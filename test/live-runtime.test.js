import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

async function startKernel(t, { key = "", route = null, configure = () => {}, onLiveEvent = () => {} } = {}) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-live-runtime-"));
    const device = createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (route && await route(req, res)) return;
        if (req.url === "/environment") res.end(JSON.stringify({ temperature: 25, humidity: 50, pressure: 1013 }));
        else if (req.url === "/brightness") res.end(JSON.stringify({ brightness: 50 }));
        else { res.statusCode = 404; res.end("{}"); }
    });
    const liveSockets = new WebSocketServer({ server: device });
    liveSockets.on("connection", (socket) => {
        socket.send(JSON.stringify({ type: "session.started", event_id: "started" }));
        socket.on("message", (bytes) => {
            const event = JSON.parse(bytes.toString());
            onLiveEvent(event);
            socket.send(JSON.stringify(event.type === "session.close"
                ? { type: "session.closed", event_id: `closed_${event.event_id}`, usage: { duration_seconds: 0 } }
                : { type: "session.updated", client_event_id: event.event_id }));
        });
    });
    device.listen(0, "127.0.0.1");
    await new Promise((resolve) => device.once("listening", resolve));
    const deviceUrl = `http://127.0.0.1:${device.address().port}`;
    const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));
    config.server.port = 0;
    config.memory.storagePath = path.join(folder, "memory.json");
    config.social.storagePath = path.join(folder, "social.json");
    config.persistence.eventLogPath = path.join(folder, "observations.jsonl");
    config.coughDetection.storagePath = path.join(folder, "cough-settings.json");
    config.coughDetection.managedProcess = false;
    config.live.conversationPath = path.join(folder, "conversation.jsonl");
    config.live.checkpointPath = path.join(folder, "checkpoint.json");
    config.sensors.bme280Url = `${deviceUrl}/environment`;
    config.sensors.brightnessUrl = `${deviceUrl}/brightness`;
    config.responses.url = `${deviceUrl}/responses`;
    config.live.apiBaseUrl = deviceUrl;
    config.live.socketBaseUrl = deviceUrl.replace("http:", "ws:");
    config.vision.snapshotUrl = `${deviceUrl}/snapshot`;
    config.actions.ledChange.endpointUrl = `${deviceUrl}/led`;
    await configure(config, folder);
    const configPath = path.join(folder, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const root = fileURLToPath(new URL("../", import.meta.url));
    const environment = { ...process.env, KOKOMI_CONFIG_PATH: configPath, OPENAI_API_KEY: key,
        KOKOMI_PERSONA_PATH: path.join(folder, "unused-env-persona.md") };
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
        for (const socket of liveSockets.clients) socket.terminate();
        liveSockets.close();
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

test("Live startup sends the entire shared control prompt without using any persona file", async (t) => {
    const controlPrompt = await fs.readFile(new URL("../control_prompt.md", import.meta.url), "utf8");
    for (const webSearchEnabled of [true, false]) await t.test(`web search ${webSearchEnabled}`, async (t) => {
        const created = [];
        const liveEvents = [];
        const base = await startKernel(t, { key: "test-key", onLiveEvent: (event) => liveEvents.push(event),
            configure: (config, folder) => {
                config.responses.webSearchEnabled = webSearchEnabled;
                // Legacy settings and environment variables must never load these absent files.
                config.live.personaPath = path.join(folder, "unused-config-persona.md");
                config.live.instructionsPath = path.join(folder, "unused-old-live-prompt.md");
                config.behavior.persona = { id: "unused-legacy-persona", version: "unused-version" };
                config.live.stateSyncIntervalMs = 25;
            }, route: async (req, res) => {
                if (req.url !== "/sessions") return false;
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                created.push(JSON.parse(Buffer.concat(chunks)));
                res.end(JSON.stringify({ session: { id: "live_prompt_test" }, transport: { sdp: "v=0 answer" } }));
                return true;
            } });
        const post = (endpoint, body) => fetch(`${base}/api/live/${endpoint}`, { method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body) });
        const response = await post("session", { sdp: "v=0 offer" });
        assert.equal(response.status, 201);
        const owner = await response.json();
        const { instructions } = created[0].session;
        assert.ok(instructions.startsWith("Execution role: Live voice frontend."));
        assert.ok(instructions.includes(controlPrompt)); // No capability or restriction may be silently dropped.
        assert.ok(Buffer.byteLength(instructions, "utf8") <= 16384);
        assert.equal(instructions.includes("このセッションでは公開 Web 検索は利用できません。"), !webSearchEnabled);
        assert.ok(!JSON.stringify(created).includes("unused-legacy-persona"));
        assert.ok(!instructions.includes("人格設定:"));
        const deadline = Date.now() + 3000;
        while (!liveEvents.some((event) => event.type === "session.thinking.append") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(liveEvents.some((event) => event.type === "session.thinking.append"));
        assert.ok(!JSON.stringify(liveEvents).includes("unused-legacy-persona"));
        assert.equal(liveEvents.filter((event) => event.type === "session.instructions.append").length, 0);
        assert.equal((await post("stop", { token: owner.control_token })).status, 200);
        assert.equal(created.length, 1); // The control prompt is sent only during session creation.
    });
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
    assert.ok(sent[0].body.instructions.startsWith("Execution role: Responses backend."));
    assert.ok(sent.every(({ body }) => !Object.hasOwn(JSON.parse(body.input[0].content[0].text), "persona")));
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

test("BEATs HTTP cough notifications reach Responses and active Live once, with console OFF suppressing input", async (t) => {
    const contexts = [];
    const liveEvents = [];
    const base = await startKernel(t, { key: "test-key", onLiveEvent: (event) => liveEvents.push(event),
        configure: (config) => { config.live.stateSyncIntervalMs = 25; },
        route: async (req, res) => {
            if (req.url === "/sessions") {
                res.end(JSON.stringify({ session: { id: "live_cough_test" }, transport: { sdp: "v=0 answer" } }));
                return true;
            }
            if (req.url !== "/responses") return false;
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks));
            const context = JSON.parse(body.input[0].content[0].text);
            contexts.push(context);
            res.end(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: JSON.stringify({ turn_id: context.turn_id,
                    result: "大丈夫？ 少し休む？", actions: [], requests: [] }) }] }] }));
            return true;
        } });
    const post = (route, body) => fetch(base + route, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body) });
    const owner = await (await post("/api/live/session", { sdp: "v=0 offer" })).json();
    assert.equal((await post("/api/live/heartbeat", { token: owner.control_token, started: true })).status, 200);
    const settings = "/api/perception/beats/cough-detection";
    const events = "/api/perception/beats/cough";
    const now = Date.now();
    const event = { schema_version: "1.0", event_id: "evt_runtime_cough", label: "cough", source: "microphone", confidence: 0.995,
        started_at: new Date(now - 500).toISOString(), ended_at: new Date(now).toISOString(), duration_ms: 500,
        model: { architecture: "beats_cough_transfer", checkpoint: "local.pt", classifier_version: "hash" },
        decision: { start_threshold: 0.99, peak_score: 0.995, frames_above_threshold: 1 } };
    assert.equal((await (await post(events, event)).json()).status, "disabled_ignored");
    await post(settings, { enabled: true });
    assert.equal((await (await post(events, event)).json()).status, "accepted");
    const deadline = Date.now() + 3000;
    while (!liveEvents.some((item) => item.type === "session.commentary.append" && item.content.includes("大丈夫"))
        && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].trigger.type, "audio.cough_detected");
    assert.equal(contexts[0].trigger.payload.subject, "unidentified_nearby_person");
    assert.ok(liveEvents.some((item) => item.type === "session.commentary.append" && item.content.includes("大丈夫")));
    assert.equal((await (await post(events, event)).json()).status, "duplicate_ignored");
    assert.equal((await (await post(events, { ...event, event_id: "evt_runtime_burst" })).json()).status, "cooldown_recorded");
    await post(settings, { enabled: false });
    assert.equal((await (await post(events, { ...event, event_id: "evt_runtime_off" })).json()).status, "disabled_ignored");
    const snapshot = await (await fetch(`${base}/api/dashboard/status`)).json();
    assert.equal(snapshot.coughDetection.enabled, false);
    assert.equal(snapshot.coughDetection.acceptedCount, 2);
    assert.equal(contexts.length, 1);
    assert.equal(new Set(snapshot.endpoints.map((item) => item.route)).size, snapshot.endpoints.length);
    assert.equal(snapshot.behavior.state.perception.last_cough.status, "known");
    assert.match(await (await fetch(`${base}/dashboard/`)).text(), /id="cough-enabled"/u);
    await post("/api/live/stop", { token: owner.control_token });
});

test("Kernel starts its BEATs supervisor automatically and restores saved ON without a bridge command", async (t) => {
    for (const savedOn of [false, true]) await t.test(`saved ON ${savedOn}`, async (t) => {
        const base = await startKernel(t, { configure: async (config, folder) => {
            config.coughDetection.managedProcess = true;
            config.coughDetection.detector.directory = path.join(folder, "absent-detector");
            config.live.enabled = false;
            if (savedOn) await fs.writeFile(config.coughDetection.storagePath, JSON.stringify({ enabled: true }));
        } });
        const settings = `${base}/api/perception/beats/cough-detection`;
        const waitFor = async (status) => {
            const deadline = Date.now() + 4000;
            let snapshot;
            do {
                snapshot = await (await fetch(settings)).json();
                if (snapshot.bridge.status === status) return snapshot;
                await new Promise((resolve) => setTimeout(resolve, 30));
            } while (Date.now() < deadline);
            assert.fail(`BEATs did not report ${status}: ${JSON.stringify(snapshot)}`);
        };
        const post = (enabled) => fetch(settings, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }) });
        if (!savedOn) {
            const initial = await waitFor("stopped");
            assert.equal(initial.managedProcess, true);
            assert.equal(initial.enabled, false); // No model lookup is required while OFF.
            await post(true);
        }
        const attempted = await waitFor("error");
        assert.equal(attempted.enabled, true);
        assert.match(attempted.bridge.error, /Missing detector file/u); // Automatic startup reached artifact resolution.
        await post(false);
        assert.equal((await waitFor("stopped")).enabled, false);
        const dashboard = await (await fetch(`${base}/api/dashboard/status`)).json();
        assert.equal(dashboard.services.find((service) => service.id === "beats").status, "disabled");
    });
});
