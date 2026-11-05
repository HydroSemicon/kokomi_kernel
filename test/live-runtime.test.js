import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { sendBrowserJson } from "../src/browser/chat-input.js";
import { chatOutputMonitor } from "../src/browser/output-monitor.js";

test("isolated Kernel starts without an API key, serves Live controls, and keeps legacy capture disabled", async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-live-runtime-"));
    const device = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/environment") res.end(JSON.stringify({ temperature: 25, humidity: 50, pressure: 1013 }));
        else if (req.url === "/brightness") res.end(JSON.stringify({ brightness: 50 }));
        else { res.statusCode = 404; res.end("{}"); }
    });
    device.listen(0, "127.0.0.1");
    await new Promise((resolve) => device.once("listening", resolve));
    const deviceUrl = `http://127.0.0.1:${device.address().port}`;
    const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));
    config.server.port = 0;
    config.memory.storagePath = path.join(folder, "memory.json");
    config.social.storagePath = path.join(folder, "social.json");
    config.persistence.eventLogPath = path.join(folder, "observations.jsonl");
    config.live.conversationPath = path.join(folder, "conversation.jsonl");
    config.live.checkpointPath = path.join(folder, "checkpoint.json");
    config.sensors.bme280Url = `${deviceUrl}/environment`;
    config.sensors.brightnessUrl = `${deviceUrl}/brightness`;
    config.browser.remoteDebuggingUrl = deviceUrl;
    const configPath = path.join(folder, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const root = fileURLToPath(new URL("../", import.meta.url));
    const environment = { ...process.env, KOKOMI_CONFIG_PATH: configPath, OPENAI_API_KEY: "", ELEVENLABS_API_KEY: "" };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["alice.js"], { cwd: root, windowsHide: true,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"] });
    t.after(async () => {
        if (child.exitCode === null) {
            const ended = new Promise((resolve) => child.once("exit", resolve));
            child.kill();
            await ended;
        }
        device.closeAllConnections();
        device.close();
        await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Kernel startup timed out. stdout=${output.slice(-2000)} stderr=${errors.slice(-2000)}`)), 20000);
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Kernel exited during startup: ${code}`)); });
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
            const match = output.match(/Kernel HTTP port: (\d+)/u);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
    });
    const base = `http://127.0.0.1:${port}`;
    const status = await (await fetch(`${base}/api/dashboard/status`)).json();
    assert.equal(status.capabilities.live.enabled, true);
    assert.equal(status.capabilities.live.ready, false);
    assert.equal(status.capabilities.asrEnabled, false);
    assert.equal(status.capabilities.ttsEnabled, false);
    const page = await (await fetch(`${base}/dashboard/`)).text();
    assert.match(page, /id="live-start"/u);
    assert.match(page, /id="live-stop"/u);
    assert.equal((await fetch(`${base}/dashboard/live-client.js`)).status, 200);
    assert.equal((await fetch(`${base}/dashboard/live-audio-monitor.js`)).status, 200);
    assert.match(page, /id="memory-records"/u);
    const create = await fetch(`${base}/api/live/session`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ sdp: "v=0 offer" }) });
    assert.equal(create.status, 503);
    assert.match((await create.json()).error, /OPENAI_API_KEY/u);
    if (process.env.KOKOMI_BROWSER_SMOKE === "1") {
        const { default: puppeteer } = await import("puppeteer");
        const browser = await puppeteer.launch({ headless: true, executablePath: process.env.KOKOMI_BROWSER_PATH,
            args: ["--no-first-run", "--no-default-browser-check", "--mute-audio"] });
        try {
            const page = await browser.newPage();
            const pageErrors = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.setViewport({ width: 1280, height: 900 });
            await page.goto(`${base}/dashboard/`, { waitUntil: "domcontentloaded" });
            await page.waitForSelector("#live-controls", { visible: true });
            await page.waitForFunction(() => document.querySelector("#live-status").textContent.includes("OPENAI_API_KEY"));
            await page.click('a[href="#communications"]');
            assert.equal(await page.$eval("#live-start", (element) => element.disabled), true);
            assert.equal(await page.$eval("#live-stop", (element) => element.disabled), true);
            assert.equal(await page.$eval("#microphone-button", (element) => element.disabled), true);
            assert.ok(await page.$eval("#live-start", (element) => element.getBoundingClientRect().width > 30));
            assert.deepEqual(pageErrors, []);
            if (process.env.KOKOMI_TEST_TRACE) console.log("Live smoke: dashboard loaded");
            // Exercise the actual CDP insertion path locally, without submitting to ChatGPT.
            const inputPage = await browser.newPage();
            const prompt = await fs.readFile(new URL("../control_prompt.md", import.meta.url), "utf8");
            const object = { turn_id: "local-smoke", kernel_backend_bootstrap: { instructions: prompt }, text: "こんにちは🌸" };
            for (const editor of ['<textarea id="entry">old draft</textarea>', '<div id="entry" contenteditable="true">old draft</div>']) {
                await inputPage.setContent(`${editor}<button id="send" onclick="const e=document.querySelector('#entry');window.submitted=e.value??e.textContent;if('value' in e)e.value='';else e.textContent=''">Send</button>`);
                await sendBrowserJson(inputPage, object, { config: { chatInputSelector: "#entry",
                    enabledSendButtonSelector: "#send:enabled", sendButtonSelector: "#send", inputTimeoutMs: 1000 } });
                assert.equal(await inputPage.evaluate(() => window.submitted), JSON.stringify(object));
            }
            // Match the observed ChatGPT composer: no send-button test ID, just a form submit button.
            // A hidden disabled legacy button must not be clicked instead of the enabled one.
            await inputPage.setContent(`<button data-testid="send-button" disabled hidden>Old Send</button>
                <form onsubmit="event.preventDefault();const e=this.querySelector('[contenteditable]');window.submitted=e.textContent;e.textContent=''">
                <div contenteditable="true"><p>old draft</p></div><button type="submit" aria-label="Send">Send</button></form>`);
            const sent = await sendBrowserJson(inputPage, object, { config: config.browser });
            assert.equal(sent.confirmed, true);
            if (process.env.KOKOMI_TEST_TRACE) console.log("Live smoke: composer submitted");
            assert.equal(await inputPage.evaluate(() => window.submitted), JSON.stringify(object));
            const monitorPage = await browser.newPage();
            await monitorPage.setContent(`<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="old"><div class="markdown prose">old response</div></div></article>`);
            await monitorPage.evaluate(() => { window.outputs = []; window.onPartialOutput = (id, text) => window.outputs.push({ id, text }); });
            const installed = await monitorPage.evaluate(chatOutputMonitor, { assistantOutputSelector: config.browser.assistantOutputSelector, outputPollIntervalMs: 20 });
            assert.equal(installed.matchedMessages, 1);
            await monitorPage.evaluate(() => {
                const user = document.createElement("div");
                user.dataset.chatgptSearchUnitKey = "fallback-turn-3:0:user";
                user.textContent = '{"turn_id":"never-accept-user-json"}';
                document.body.append(user);
                const old = document.createElement("div");
                old.dataset.chatgptSearchUnitKey = "fallback-turn-1:1:assistant";
                old.textContent = "lazy historical message";
                document.body.prepend(old);
                const response = document.createElement("div");
                response.dataset.chatgptSearchUnitKey = "fallback-turn-3:1:assistant";
                response.dataset.chatgptSearchMessageIds = "new-message new-message";
                response.textContent = 'ChatGPT said: {"turn_id":"current","memory_extraction":{"summary":"ok","candidates":[]}}';
                document.body.append(response);
            });
            await monitorPage.waitForFunction(() => window.outputs.length === 1);
            const received = await monitorPage.evaluate(() => window.outputs);
            assert.equal(received[0].id, "new-message");
            assert.ok(received[0].text.includes('"turn_id":"current"'));
            await monitorPage.evaluate(() => { document.querySelector('[data-chatgpt-search-message-ids]').textContent += " updated"; });
            await monitorPage.waitForFunction(() => window.outputs.length === 2);
            assert.equal((await monitorPage.evaluate(() => window.outputs)).length, 2);
            if (process.env.KOKOMI_TEST_TRACE) console.log("Live smoke: output monitor received updates");
            // The model tab may be in the background while the user operates the Kernel console.
            await inputPage.setContent(`<div id="entry" contenteditable="true">draft</div><button id="send" onclick="window.submitted=document.querySelector('#entry').textContent;document.querySelector('#entry').textContent=''">Send</button>`);
            await sendBrowserJson(inputPage, object, { config: { chatInputSelector: "#entry",
                enabledSendButtonSelector: "#send:enabled", sendButtonSelector: "#send", inputTimeoutMs: 2000 } });
            assert.equal(await inputPage.evaluate(() => window.submitted), JSON.stringify(object));
            await page.bringToFront();
            await page.click("#memory-refresh");
            await page.waitForFunction(() => document.querySelector("#memory-records").textContent.includes("該当する長期記憶はありません"));
            assert.deepEqual(await page.evaluate(() => window.kokomi.memory()), []);
            await page.evaluate(async () => {
                const { SilenceAlarm } = await import("/dashboard/live-audio-monitor.js");
                window.testAlarm = new SilenceAlarm();
                const enable = document.createElement("button");
                enable.id = "test-alarm-enable";
                enable.textContent = "Enable test warning sound";
                enable.style.cssText = "position:fixed;top:5px;left:5px;z-index:99999";
                enable.onclick = () => window.testAlarm.prepare();
                document.body.append(enable);
            });
            await page.click("#test-alarm-enable");
            await page.waitForFunction(() => window.testAlarm.context.state === "running");
            assert.equal(await page.evaluate(() => window.testAlarm.play()), true);
            await page.evaluate(() => window.testAlarm.close());
            if (process.env.KOKOMI_TEST_TRACE) console.log("Live smoke: memories loaded");
        } finally { await browser.close(); }
    }
});
