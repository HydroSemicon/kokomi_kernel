import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CoughDetectionService, mountCoughRoutes, normalizeCoughEvent } from "../src/perception/cough-service.js";
import { BeatsCoughBridge, detectorCommand, configuredDetectorCommand } from "../src/perception/beats-cough-bridge.js";
import { BehaviorArchitecture } from "../src/behavior/index.js";
import { LiveKernelBridge } from "../src/live/kernel-bridge.js";

const routes = { coughDetection: "/api/perception/beats/cough-detection", beatsCough: "/api/perception/beats/cough",
    beatsHeartbeat: "/api/perception/beats/heartbeat" };
function cough(now = Date.now(), id = "evt_test") {
    return { schema_version: "1.0", event_id: id, label: "cough", source: "microphone", confidence: 0.995,
        started_at: new Date(now - 500).toISOString(), ended_at: new Date(now).toISOString(), duration_ms: 500,
        model: { architecture: "beats_cough_transfer", checkpoint: "local-checkpoint.pt", classifier_version: "hash" },
        decision: { start_threshold: 0.99, peak_score: 0.995, frames_above_threshold: 2 } };
}

test("BEATs accepts only finalized, bounded cough events and namespaces observation IDs", () => {
    const valid = cough();
    const observation = normalizeCoughEvent(valid);
    assert.match(observation.id, /^beats_cough_[a-f0-9]{64}$/u);
    assert.equal(observation.id, normalizeCoughEvent(valid).id);
    assert.equal(observation.payload.subject, "unidentified_nearby_person");
    assert.equal(normalizeCoughEvent({ ...valid, model: { ...valid.model, architecture: "beats_transfer" } }).type, "audio.cough_detected");
    for (const changes of [null, { schema_version: "2.0" }, { label: "sneeze" }, { source: "file" },
        { confidence: NaN }, { confidence: 2 }, { event_id: "evt_bad/../id" }, { started_at: "yesterday" },
        { duration_ms: 1234 }, { decision: {} }, { model: { ...valid.model, architecture: "yamnet_transfer" } }]) {
        assert.throws(() => normalizeCoughEvent(changes === null ? null : { ...valid, ...changes }), TypeError);
    }
});

test("switch persists, repeated events deduplicate, bursts record without repeated reactions, and stale events expire", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-cough-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let now = Date.now();
    const accepted = new Set();
    const calls = [];
    const options = { storagePath: path.join(directory, "cough.json"), clock: () => now,
        hasObservation: (id) => accepted.has(id), observe: async (input, options) => { accepted.add(input.id); calls.push(options); } };
    const service = new CoughDetectionService(options);
    await service.initialize();
    assert.equal((await service.receive(cough(now))).status, "disabled_ignored");
    await service.setEnabled(true);
    assert.equal((await service.receive(cough(now))).status, "accepted");
    assert.equal((await service.receive(cough(now))).status, "duplicate_ignored");
    assert.equal((await service.receive(cough(now, "evt_second"))).status, "cooldown_recorded");
    assert.deepEqual(calls.map((call) => call.forward), [true, false]);
    assert.equal(calls[0].valid(), true);
    await service.setEnabled(false);
    await service.setEnabled(true);
    assert.equal(calls[0].valid(), false); // OFF then ON must not revive a queued response.
    assert.equal((await service.receive(cough(now - 31_000, "evt_old"))).status, "stale_ignored");
    assert.equal((await service.receive(cough(now + 6000, "evt_future"))).status, "stale_ignored");
    now += 60_001;
    assert.equal((await service.receive(cough(now, "evt_later"))).status, "accepted");
    const restarted = new CoughDetectionService(options);
    await restarted.initialize();
    assert.equal(restarted.enabled, true);
    assert.equal((await restarted.receive(cough(now, "evt_later"))).status, "duplicate_ignored");
    assert.equal(service.snapshot().acceptedCount, 3);
});

test("concurrent duplicate requests create one observation and failed delivery can retry", async () => {
    let calls = 0;
    const service = new CoughDetectionService({ config: { enabled: true }, observe: async () => {
        if (++calls === 1) throw new Error("Temporary storage failure");
    } });
    const event = cough();
    await assert.rejects(service.receive(event), /storage/u);
    const responses = await Promise.all([service.receive(event), service.receive(event)]);
    assert.deepEqual(responses.map((response) => response.status), ["accepted", "duplicate_ignored"]);
    assert.equal(calls, 2);
});

test("cough observation persists separately from ambient audio and is omitted from context after expiry", () => {
    let now = Date.now();
    const behavior = new BehaviorArchitecture({ clock: () => now });
    behavior.observe({ type: "audio.classification", source: "other", payload: { label: "speech", level: "low" } });
    const { observation } = behavior.observe(normalizeCoughEvent(cough(now)));
    const context = behavior.composeContext(observation);
    assert.equal(context.state.perception.last_sound.label, "speech");
    assert.equal(context.state.perception.last_cough.subject, "unidentified_nearby_person");
    assert.equal(JSON.stringify(context).includes("local-checkpoint.pt"), false);
    now += 30_001;
    assert.equal(behavior.snapshot().state.perception.last_cough.status, "stale");
    const later = behavior.observe({ type: "interaction.user_input", source: "test", payload: { text: "こんにちは" } }).observation;
    assert.equal(behavior.composeContext(later).state.perception.last_cough, undefined);
});

test("dedicated HTTP routes validate controls and events and expose bridge liveness", async (t) => {
    let now = Date.now();
    const service = new CoughDetectionService({ clock: () => now, observe: async () => {} });
    const app = express();
    app.use(express.json());
    mountCoughRoutes(app, { service, routes });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(routes.coughDetection, { enabled: "true" })).status, 400);
    assert.equal((await post(routes.beatsCough, {})).status, 400);
    assert.equal((await post(routes.coughDetection, { enabled: true })).status, 200);
    assert.equal((await (await post(routes.beatsCough, cough(now))).json()).status, "accepted");
    assert.equal((await post(routes.beatsHeartbeat, { status: "running" })).status, 200);
    assert.equal((await (await fetch(base + routes.coughDetection)).json()).bridge.status, "running");
    now += 10_001;
    assert.equal(service.snapshot().bridge.status, "disconnected");
    assert.equal((await post(routes.beatsHeartbeat, { status: "nonsense" })).status, 400);
});

test("bridge starts/stops the microphone process from the switch, posts JSONL and retries the same event ID", async () => {
    let enabled = false;
    let fail = true;
    const children = [];
    const events = [];
    const bridge = new BeatsCoughBridge({ kernelUrl: "http://localhost:3000", routes,
        command: { executable: "fake-python", args: [], cwd: os.tmpdir() }, log: () => {},
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", 0)); };
            children.push(child); return child;
        }, fetchImpl: async (url, options) => {
            if (url.pathname === routes.coughDetection) return { ok: true, json: async () => ({ enabled }) };
            if (url.pathname === routes.beatsCough) {
                events.push(JSON.parse(options.body));
                if (fail) { fail = false; return { ok: false, status: 503, json: async () => ({ error: "Retry" }) }; }
            }
            return { ok: true, json: async () => ({ status: "accepted" }) };
        } });
    await bridge.tick();
    assert.equal(children.length, 0);
    enabled = true;
    await bridge.tick();
    await bridge.tick();
    assert.equal(children.length, 1);
    children[0].stdout.write(`${JSON.stringify(cough())}\n`);
    await bridge.deliveryQueue;
    assert.equal(events.length, 2);
    assert.equal(events[0].event_id, events[1].event_id);
    enabled = false;
    await bridge.tick();
    assert.equal(children[0].killed, true);
    assert.equal(bridge.child, null);
    enabled = true;
    await bridge.tick();
    assert.equal(children.length, 2);
    await bridge.close();
    assert.equal(children[1].killed, true);
});

test("bridge stops its process if the Kernel disappears", async () => {
    let failed = false;
    let killed = false;
    const bridge = new BeatsCoughBridge({ kernelUrl: "http://localhost:3000", routes, log: () => {},
        command: { executable: "fake", args: [] }, fetchImpl: async () => {
            if (failed) throw new Error("Connection lost");
            return { ok: true, json: async () => ({ enabled: true }) };
        }, spawnImpl: () => {
            const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 0)); };
            return child;
        } });
    await bridge.tick();
    failed = true;
    await bridge.tick();
    assert.equal(killed, true);
    await bridge.close();
});

test("managed polling starts lazily, reports missing artifacts, retries and releases its child on close", async (t) => {
    let enabled = false;
    let available = false;
    let commandCalls = 0;
    let now = Date.now();
    const heartbeats = [];
    const children = [];
    const bridge = new BeatsCoughBridge({ kernelUrl: "http://localhost:3000", routes, clock: () => now, log: () => {},
        command: () => {
            commandCalls++;
            if (!available) throw new Error("Missing detector file");
            return { executable: "fake-python", args: [] };
        }, spawnImpl: () => {
            const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", 0)); };
            children.push(child); return child;
        }, fetchImpl: async (url, options) => {
            if (url.pathname === routes.beatsHeartbeat) heartbeats.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ enabled }) };
        } });
    t.after(() => bridge.close());
    bridge.startPolling();
    bridge.startPolling();
    const timer = bridge.timer;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commandCalls, 0);
    assert.equal(heartbeats.at(-1).status, "stopped");
    enabled = true;
    await bridge.tick();
    assert.equal(commandCalls, 1);
    assert.equal(heartbeats.at(-1).status, "error");
    assert.match(heartbeats.at(-1).error, /Missing/u);
    await bridge.tick();
    assert.equal(commandCalls, 1); // Do not repeatedly load/fail within the restart backoff.
    available = true;
    now += 5000;
    await bridge.tick();
    assert.equal(children.length, 1);
    assert.equal(heartbeats.at(-1).status, "running");
    assert.equal(bridge.timer, timer);
    await bridge.close();
    assert.equal(children[0].killed, true);
    assert.equal(bridge.timer, null);
    await bridge.tick();
    assert.equal(children.length, 1);
});

test("overlapping managed ticks and shutdown during a settings request cannot spawn an extra process", async () => {
    let resolveSettings;
    let requests = 0;
    const bridge = new BeatsCoughBridge({ kernelUrl: "http://localhost:3000", routes, log: () => {},
        command: () => assert.fail("Must not start after close"),
        fetchImpl: () => { requests++; return new Promise((resolve) => { resolveSettings = resolve; }); } });
    const pending = bridge.tick();
    await bridge.tick();
    assert.equal(requests, 1);
    await bridge.close();
    resolveSettings({ ok: true, json: async () => ({ enabled: true }) });
    await pending;
    assert.equal(requests, 1);
});

test("cough reaction uses the existing backend and Live delivery, cancels late results and rejects actions", async () => {
    const results = [];
    let valid = true;
    let finish;
    let started;
    const starting = new Promise((resolve) => { started = resolve; });
    let backend = async (context) => {
        assert.match(context.response_contract, /gentle Japanese check-in/u);
        return { result: "大丈夫？", actions: [], requests: [] };
    };
    const bridge = new LiveKernelBridge({ live: { session: { id: "live_test" }, deliverResult: (text) => results.push(text) },
        conversations: { append: async () => {} }, runBackend: (...args) => backend(...args) });
    assert.equal(await bridge.submitCoughContext({ turn_id: "a" }), "大丈夫？");
    backend = async () => { started(); return await new Promise((resolve) => { finish = resolve; }); };
    const pending = bridge.submitCoughContext({ turn_id: "b" }, { valid: () => valid });
    await starting;
    valid = false;
    finish({ result: "遅れた反応", actions: [], requests: [] });
    assert.equal(await pending, null);
    assert.deepEqual(results, ["大丈夫？"]);
    backend = async () => ({ result: null, actions: [{ type: "tear" }], requests: [] });
    await assert.rejects(bridge.submitCoughContext({ turn_id: "c" }), /read-only/u);
});

test("detector command uses explicit local artifacts and refuses a multi-class configuration", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-beats-command-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const file of ["python", "head.npz", "checkpoints/BEATs_iter3+_AS2M.pt", "vendor/unilm/beats/BEATs.py"]) {
        await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await fs.writeFile(path.join(directory, file), "");
    }
    const config = path.join(directory, "cough.json");
    await fs.writeFile(config, JSON.stringify({ enabled_labels: ["cough"] }));
    const options = { detectorDirectory: directory, python: path.join(directory, "python"), head: "head.npz",
        detectorConfig: "cough.json", eventLog: path.join(directory, "events.jsonl"), device: "3", inferenceDevice: "cpu" };
    const command = detectorCommand(options);
    assert.ok(command.args.includes("--stdout-jsonl"));
    assert.ok(command.args.includes("cpu"));
    assert.deepEqual(command.args.slice(-2), ["--device", "3"]);
    const configured = configuredDetectorCommand({ coughDetection: { detector: { directory, python: options.python,
        head: options.head, config: options.detectorConfig, device: 3, inferenceDevice: "cpu" } },
    persistence: { eventLogPath: "runtime/observations.jsonl" } }, directory);
    assert.equal(configured.cwd, directory);
    assert.ok(configured.args.includes(path.join(directory, "runtime", "beats", "cough-events.jsonl")));
    assert.deepEqual(configured.args.slice(-2), ["--device", "3"]);
    await fs.writeFile(config, JSON.stringify({ enabled_labels: ["cough", "sneeze"] }));
    assert.throws(() => detectorCommand(options), /cough-only/u);
});
