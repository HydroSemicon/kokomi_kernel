import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

async function startKernel(t, { key = "", route = null } = {}) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-live-runtime-"));
    const device = createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (route && await route(req, res)) return;
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
    config.responses.url = `${deviceUrl}/responses`;
    config.vision.snapshotUrl = `${deviceUrl}/snapshot`;
    config.actions.ledChange.endpointUrl = `${deviceUrl}/led`;
    const configPath = path.join(folder, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const root = fileURLToPath(new URL("../", import.meta.url));
    const environment = { ...process.env, KOKOMI_CONFIG_PATH: configPath, OPENAI_API_KEY: key };
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
    return `http://127.0.0.1:${port}`;
}

test("isolated Kernel starts without an API key, serves Live controls, and reports missing Responses credentials", async (t) => {
    const base = await startKernel(t);
    const status = await (await fetch(`${base}/api/dashboard/status`)).json();
    assert.equal(status.capabilities.live.enabled, true);
    assert.equal(status.capabilities.live.ready, false);
    assert.equal(status.services.find((item) => item.id === "responses").status, "offline");
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
});

test("typed control uses Responses, attaches a snapshot, rejects mismatched turns and publishes search citations", async (t) => {
    const sent = [];
    const jpeg = Buffer.from([255, 216, 255, 217]);
    let actionCalls = 0;
    const base = await startKernel(t, { key: "test-key", route: async (req, res) => {
        if (req.url === "/snapshot") {
            res.setHeader("Content-Type", "image/jpeg");
            res.end(jpeg);
            return true;
        }
        if (req.url === "/led") { actionCalls++; res.end("{}"); return true; }
        if (req.url !== "/responses") return false;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        sent.push({ body, authorization: req.headers.authorization });
        const content = body.input[0]?.content;
        const ctx = content && JSON.parse(content[0].text);
        let text;
        const output = [];
        const annotations = [];
        if (body.tools) {
            text = "公開資料で確認できました。";
            output.push({ type: "web_search_call", status: "completed" });
            annotations.push({ type: "url_citation", url: "https://example.com/result", title: "公開資料" });
        } else {
            const payload = { turn_id: ctx.turn_id, result: null, actions: [], requests: [] };
            if (ctx.trigger.payload.text === "机を見て") {
                if (content.length === 1) payload.requests.push({ type: "vision", params: { task: "describe_scene" } });
                else payload.result = "赤いマグがあります。";
            } else if (ctx.trigger.payload.text === "公開情報を調べて") {
                payload.requests.push({ type: "web_search", params: { query: "公開情報" } });
            } else if (ctx.trigger.payload.text === "室温を確認して") {
                if (!ctx.request_results) payload.requests.push("temperature", { type: "kernel_query", params: { resource: "state", query: null } });
                else payload.result = "室内は快適です。";
            } else {
                if (ctx.trigger.payload.text !== "LEDを白にして") payload.turn_id = "unrelated_turn";
                payload.actions.push({ type: "led_change", params: { color: "#FFFFFF" } });
            }
            text = JSON.stringify(payload);
        }
        output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }] });
        res.end(JSON.stringify({ status: "completed", output }));
        return true;
    } });
    const send = (text) => fetch(`${base}/user_input`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }) });
    const vision = await send("机を見て");
    assert.equal(vision.status, 200);
    assert.equal((await vision.json()).result, "赤いマグがあります。");
    assert.equal(sent[0].authorization, "Bearer test-key");
    assert.equal(sent[0].body.store, false);
    assert.match(sent[0].body.instructions, /physical embodied AI/);
    assert.equal(sent[0].body.text.format.strict, true);
    assert.equal(sent[1].body.input[0].content[1].image_url, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
    assert.equal((await send("LEDを変更して")).status, 503);
    assert.equal(actionCalls, 0);
    const led = await send("LEDを白にして");
    assert.equal(led.status, 200);
    assert.match((await led.json()).result, /succeeded/u);
    assert.equal(actionCalls, 1);
    assert.equal((await (await send("公開情報を調べて")).json()).result, "公開資料で確認できました。");
    assert.equal(sent.at(-1).body.input, "公開情報");
    assert.equal((await send("室温を確認して")).status, 200);
    const followup = JSON.parse(sent.at(-1).body.input[0].content[0].text);
    assert.equal(followup.state.environment, undefined);
    assert.ok(!Object.hasOwn(followup.request_results[0], "unit"));
    assert.ok([null, "comfortable"].includes(followup.request_results[0].result));
    assert.ok(!Object.hasOwn(followup.request_results[1].result.environment, "temperature"));
    const status = await (await fetch(`${base}/api/dashboard/status`)).json();
    assert.deepEqual(status.activity.find((entry) => entry.title === "Web search result").sources,
        [{ url: "https://example.com/result", title: "公開資料" }]);
});
