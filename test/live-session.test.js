import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { LiveSessionService } from "../src/live/session-service.js";
import { LiveKernelBridge } from "../src/live/kernel-bridge.js";
import { LiveBrowserClient } from "../dashboard/live-client.js";
import { bodyContext } from "../src/live/body-context.js";

const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));

function fixture(overrides = {}) {
    const { autoStart = true, ...serviceOverrides } = overrides;
    let now = 100;
    const sockets = [];
    const logged = [];
    const delegated = [];
    const requests = [];
    const conversations = { checkpoint: { summary: "前回は紅茶について話した" },
        snapshot: () => ({ fragments: logged.length }), recent: (_session, limit = 20) => logged.map((entry) => ({
            role: entry.role, text: entry.text, received_at: now, evidence_event_ids: ["a"],
        })).slice(-limit), append: async (entry) => { logged.push(entry); return entry; } };
    const service = new LiveSessionService({ config: { ...config.live, closeTimeoutMs: 20, requestTimeoutMs: 100 },
        apiKey: "test-secret", conversations, clock: () => now,
        memory: { retrieve: () => [], list: () => [] }, bootstrap: async () => "心海として会話する",
        getContext: () => ({ facts: "室温は25℃", style: "普段どおり話す" }),
        fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true,
            json: async () => ({ session: { id: "live_test" }, transport: { sdp: "v=0 answer" } }) }; },
        socketFactory: () => {
            const socket = new EventEmitter();
            socket.sent = [];
            socket.readyState = 0;
            socket.send = (text) => {
                const event = JSON.parse(text);
                socket.sent.push(event);
                if (event.type === "session.close") queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({
                    type: "session.closed", event_id: "closed", usage: { duration_seconds: 2 },
                }))));
            };
            socket.close = () => { socket.readyState = 3; socket.emit("close"); };
            sockets.push(socket);
            queueMicrotask(() => {
                socket.readyState = 1;
                socket.emit("open");
                if (autoStart) socket.emit("message", Buffer.from(JSON.stringify({ type: "session.started", event_id: "started" })));
            });
            return socket;
        },
        onDelegation: async (task) => delegated.push(task), ...serviceOverrides });
    return { service, sockets, logged, delegated, requests, setNow: (value) => { now = value; } };
}

test("Live creation uses client delegation, restricted browser events, and server-only credentials", async () => {
    const f = fixture();
    const owner = await f.service.start("v=0 offer");
    const body = JSON.parse(f.requests[0].options.body);
    assert.equal(body.session.model, "gpt-live-1");
    assert.equal(body.session.delegation.type, "client");
    assert.deepEqual(body.session.client.data_channel.allowed_client_events, []);
    assert.equal(body.session.store, false);
    assert.equal(body.transport.type, "webrtc");
    assert.ok(!JSON.stringify(owner).includes("test-secret"));
    assert.ok(!JSON.stringify(f.service.snapshot()).includes(owner.control_token));
    await assert.rejects(f.service.start("v=0 second"), /already exists/u);
    assert.throws(() => f.service.heartbeat("wrong owner"), /owner/u);
    await f.service.stop(owner.control_token);
    assert.equal(f.service.snapshot().closeConfirmed, true);
});

test("Live receives qualitative world state and does not replay prior numerical room readings", async () => {
    const qualitative = bodyContext({ state: { environment: { temperature: { status: "known", value: 26.42 } },
        perception: { visible_people: [] }, interaction: {} }, world: { room: {}, environment: {
        thermal_condition: { status: "known", value: "comfortable" }, lighting_condition: { status: "known", value: "bright" },
    } }, drives: { external: {} } }, config.live);
    const f = fixture({ getContext: () => qualitative });
    f.service.conversations.checkpoint.summary = "前回の室温は26.42℃";
    f.service.conversations.recent = () => [
        { role: "assistant", text: "今ね、室温はだいたい二十六度くらい。" },
        { role: "user", text: "最近は紅茶が好き" },
    ];
    const owner = await f.service.start("v=0 offer");
    const sent = JSON.stringify(JSON.parse(f.requests[0].options.body).session.input);
    assert.match(sent, /comfortable/u);
    assert.match(sent, /紅茶/u);
    assert.doesNotMatch(sent, /26\.42|二十六度/u);
    await f.service.stop(owner.control_token);
});

test("sideband open does not send context until media startup is confirmed", async () => {
    const f = fixture({ autoStart: false });
    const owner = await f.service.start("v=0 offer");
    assert.equal(f.service.status, "connecting");
    await f.service.tick();
    assert.equal(f.service.append("thinking", "too early"), false);
    assert.equal(f.sockets[0].sent.length, 0);
    assert.throws(() => f.service.heartbeat("wrong", { started: true }), /owner/u);
    f.service.heartbeat(owner.control_token, { started: true });
    assert.equal(f.service.status, "active");
    f.service.sync();
    assert.ok(f.sockets[0].sent.some((event) => event.type === "session.thinking.append"));
    await f.service.stop(owner.control_token);
    f.service.heartbeat(owner.control_token, { started: true });
    assert.equal(f.service.status, "idle");
});

test("rejected commands release nested acknowledgements and preserve audio with durable error details", async () => {
    const f = fixture();
    const owner = await f.service.start("v=0 offer");
    await f.service.events;
    f.service.append("thinking", "context");
    const clientId = f.sockets[0].sent[0].event_id;
    await f.service.handle(f.service.session, { type: "error", event_id: "rejected", error: {
        type: "invalid_request_error", code: "not_started", param: "content", client_event_id: clientId,
        message: "Session has not started; sk-privatecredential Bearer secret-token",
    } });
    const status = f.service.heartbeat(owner.control_token);
    assert.equal(status.status, "active");
    assert.equal(status.pendingContextUpdates, 0);
    assert.equal(status.lastEventError.code, "not_started");
    assert.equal(status.lastEventError.client_event_id, clientId);
    assert.match(status.contextWarning, /not_started/u);
    assert.match(f.logged[0].text, /live_error/u);
    assert.ok(!JSON.stringify(status).includes("privatecredential"));
    assert.ok(!f.logged[0].text.includes("secret-token"));
    assert.equal(f.sockets[0].sent.some((event) => event.type === "session.close"), false);
    await f.service.stop(owner.control_token);
    assert.equal(f.service.snapshot().contextWarning, null);
    assert.equal(f.service.snapshot().lastEventError.code, "not_started");
});

test("missing API keys fail before a billable request and invalid configuration is rejected", async () => {
    let requests = 0;
    const f = fixture({ apiKey: "", fetchImpl: () => { requests++; } });
    await assert.rejects(f.service.start("v=0 offer"), /OPENAI_API_KEY/u);
    assert.equal(requests, 0);
    assert.throws(() => fixture({ config: { ...config.live, updateBudgetTokens: 501 } }), /budget/u);
});

test("transcripts are saved once and metadata-only delegation does not invent request text", async () => {
    const f = fixture();
    const owner = await f.service.start("v=0 offer");
    const session = f.service.session;
    const event = { type: "session.input_transcript.delta", event_id: "input", delta: "机を見て", start_ms: 0, end_ms: 500 };
    await f.service.handle(session, event);
    await f.service.handle(session, event);
    assert.equal(f.logged.length, 1);
    await f.service.handle(session, { type: "session.delegation.created", event_id: "d1", offset_ms: 500,
        delegation: { id: "delegate_one", target: "client" } });
    await Promise.resolve();
    assert.equal(f.delegated.length, 1);
    assert.equal(f.delegated[0].delegationId, "delegate_one");
    assert.equal(f.delegated[0].text, undefined);
    const oldTask = f.delegated[0];
    await f.service.handle(session, { ...event, event_id: "cancel", delta: "やっぱりやめて", start_ms: 600, end_ms: 900 });
    assert.equal(f.service.isCurrent(oldTask), false);
    await f.service.stop(owner.control_token);
});

test("heartbeat expiry closes the remote session and suppresses late updates", async () => {
    const f = fixture();
    await f.service.start("v=0 offer");
    f.setNow(100 + config.live.heartbeatTimeoutMs + 1);
    await f.service.tick();
    assert.equal(f.service.snapshot().closeConfirmed, true);
    assert.equal(f.service.append("commentary", "遅れて届いた結果"), false);
});

test("unconfirmed closes block a new paid session and can be retried", async () => {
    const f = fixture();
    const owner = await f.service.start("v=0 offer");
    const socket = f.sockets[0];
    socket.send = (text) => socket.sent.push(JSON.parse(text));
    await f.service.stop(owner.control_token);
    assert.equal(f.service.snapshot().closeConfirmed, false);
    await assert.rejects(f.service.start("v=0 another"), /unconfirmed/u);
    await f.service.stop(owner.control_token); // A replacement sideband confirms closure.
    assert.equal(f.service.snapshot().closeConfirmed, true);
});

test("context sync retrieves relevant memories once and uses distinct instruction and fact channels", async () => {
    const f = fixture({ memory: { list: () => [], retrieve: () => [{ id: "m_1", content: "紅茶が好き" }] } });
    const owner = await f.service.start("v=0 offer");
    await f.service.events;
    f.service.sync();
    f.service.sync();
    const events = f.sockets[0].sent;
    assert.equal(events.filter((event) => event.type === "session.instructions.append").length, 0);
    assert.ok(JSON.parse(f.requests[0].options.body).session.instructions.includes("普段どおり話す"));
    f.service.getContext = () => ({ facts: "室温は25℃", style: "少しゆっくり話す" });
    f.service.sync();
    assert.equal(events.filter((event) => event.type === "session.instructions.append").length, 1);
    assert.equal(events.filter((event) => event.content.includes("紅茶が好き")).length, 0); // Already provided at startup.
    assert.ok(events.every((event) => Buffer.byteLength(event.content ?? "") <= config.live.updateBudgetTokens));
    await f.service.stop(owner.control_token);
});

function bridgeFixture(overrides = {}) {
    const calls = [];
    const live = { session: { id: "live_test" }, isCurrent: () => true, append: (...args) => calls.push(args) };
    const bridge = new LiveKernelBridge({ config: config.live, live, conversations: { append: async () => {} },
        memory: {}, buildContext: async (input) => input,
        runBackend: async () => ({ result: "机にカップがある" }), executeAction: async () => assert.fail("unexpected action"),
        query: async () => ({}), snapshot: async () => ({ buffer: Buffer.from("image"), mimeType: "image/jpeg" }), ...overrides });
    return { bridge, calls, live };
}

test("vision round trips attach the camera image while retaining original action authorization", async () => {
    let step = 0;
    const root = { turn_id: "root", trigger: { type: "interaction.user_input", payload: { text: "机を見て" } } };
    const f = bridgeFixture({ runBackend: async (context, options) => {
        step++;
        assert.deepEqual(context.trigger, root.trigger);
        if (step === 1) return { requests: [{ type: "vision", params: { task: "describe_scene" } }] };
        assert.equal(options.image.mimeType, "image/jpeg");
        assert.notEqual(context.turn_id, root.turn_id);
        return { result: "机に赤いカップがあります。" };
    } });
    assert.equal(await f.bridge.submitContext(root), "机に赤いカップがあります。");
    assert.equal(step, 2);
    assert.equal(f.calls[0][0], "commentary");
});

test("a camera question without Live delegation captures once and a late delegation cannot repeat it", async () => {
    const user = { role: "user", text: "これ何かわかる", start_ms: 0, received_at: Date.now() - 10, evidence_event_ids: ["camera_question"] };
    const session = { id: "live_test", revision: 0 };
    const spoken = [];
    const firstImage = Promise.withResolvers();
    const release = Promise.withResolvers();
    let captures = 0;
    const f = bridgeFixture({ config: { ...config.live, delegationQuietMs: 5 },
        live: { session, isCurrent: () => true, deliverResult: (text, task) => spoken.push({ text, task }) },
        conversations: { recent: () => [user], append: async () => {} },
        snapshot: async () => { captures++; firstImage.resolve(); await release.promise; return { mimeType: "image/jpeg" }; },
        runBackend: async (context, { image }) => {
            assert.equal(context.task, "live_vision");
            assert.match(context.response_contract, /read-only/u);
            assert.equal(image.mimeType, "image/jpeg");
            return { result: "赤いマグがあります。" };
        },
    });
    f.bridge.observeTranscript({ id: "camera_question", session_id: session.id });
    await Promise.race([firstImage.promise, delay(100).then(() => assert.ok(captures, "camera fallback did not start"))]);
    await f.bridge.delegate({ sessionId: session.id, delegationId: "late_vision", offsetMs: 500 });
    release.resolve();
    await f.bridge.queue.submit(() => {});
    assert.equal(captures, 1);
    assert.equal(spoken[0].text, "赤いマグがあります。");
    assert.equal(spoken[0].task.delegationId, "late_vision");
});

test("a native voice delegation still routes a device action through the actuator gate", async () => {
    const user = { role: "user", text: "LEDを赤くして", start_ms: 0, received_at: Date.now() - 3000, evidence_event_ids: ["led_request"] };
    const action = { type: "led_change", params: { color: "#FF0000" } };
    let executed = false;
    const f = bridgeFixture({ conversations: { recent: () => [user], append: async () => {} },
        buildContext: async ({ type, payload }) => ({ turn_id: "led_turn", trigger: { type, payload } }),
        runBackend: async (context) => {
            assert.equal(context.task, "live_control");
            assert.equal(context.trigger.payload.text, user.text);
            return { actions: [action] };
        },
        executeAction: async (received, options) => {
            assert.deepEqual(received, action);
            assert.equal(options.turnId, "led_turn");
            assert.equal(options.valid(), true);
            executed = true;
            return { action_type: "led_change", status: "succeeded" };
        },
    });
    await f.bridge.delegate({ sessionId: "live_test", delegationId: "native_led", offsetMs: 500 });
    assert.equal(executed, true);
    assert.match(f.calls[0][1], /succeeded/u);
});

test("actual failed action outcomes override optimistic backend wording", async () => {
    const f = bridgeFixture({ runBackend: async () => ({ result: "LEDを変更しました", actions: [{ type: "led_change", params: { color: "#FF0000" } }] }),
        executeAction: async (_action, options) => { assert.equal(options.turnId, "root"); return { action_type: "led_change", status: "failed", error: "offline" }; } });
    const result = await f.bridge.submitContext({ turn_id: "root" });
    assert.match(result, /failed/u);
    assert.ok(!result.includes("変更しました"));
});

test("a correction during backend execution prevents an outdated action from running", async () => {
    let current = true;
    const f = bridgeFixture({ live: { session: { id: "live_test" }, isCurrent: () => current, append: () => assert.fail("late speech") },
        runBackend: async () => { current = false; return { actions: [{ type: "tear", params: { speed: 1, duration: 1 } }] }; } });
    assert.equal(await f.bridge.submitContext({ turn_id: "root" }, { sessionId: "live_test" }), null);
});

test("Live receives further speech during vision work, even when memory inference is still pending", { timeout: 2000 }, async () => {
    const memory = Promise.withResolvers();
    const visionStarted = Promise.withResolvers();
    const vision = Promise.withResolvers();
    const f = fixture({ onDelegation: (task) => bridge.submitContext({ turn_id: "vision_root" }, task) });
    const bridge = bridgeFixture({ live: f.service,
        runBackend: async (context, { image } = {}) => {
            if (context.task === "live_memory") return memory.promise;
            if (!image) return { requests: [{ type: "vision", params: { task: "describe_scene" } }] };
            visionStarted.resolve();
            return vision.promise;
        },
    }).bridge;
    const owner = await f.service.start("v=0 offer");
    await f.service.events;
    const extracting = bridge.extract({ batch: { groups: [] }, known: [], previousSummary: "" });
    const session = f.service.session;
    await f.service.handle(session, { type: "session.delegation.created", event_id: "vision_delegation", offset_ms: 0,
        delegation: { id: "vision_lookup", target: "client" } });
    await visionStarted.promise;
    await f.service.handle(session, { type: "session.input_transcript.delta", event_id: "speech_during_vision",
        delta: "最近は紅茶が好き", start_ms: 300, end_ms: 900 });
    assert.ok(f.logged.some((entry) => entry.text === "最近は紅茶が好き"));
    assert.equal(f.service.status, "active");
    memory.resolve({ memory_extraction: { summary: "", candidates: [] } });
    vision.resolve({ result: "赤いマグがあります。" });
    await extracting;
    await bridge.queue.submit(() => {});
    assert.ok(f.sockets[0].sent.some((event) => event.type === "session.commentary.append"
        && event.delegation_id === "vision_lookup" && event.content === "赤いマグがあります。"));
    await f.service.stop(owner.control_token);
});

test("browser stop closes tracks and playback before awaiting server closure", async () => {
    const order = [];
    let finishStop;
    const client = new LiveBrowserClient({ fetchImpl: async () => {
        order.push("server request");
        await new Promise((resolve) => { finishStop = resolve; });
        return { ok: true, json: async () => ({ closeConfirmed: true }) };
    } });
    client.owner = { control_token: "owner" };
    client.stream = { getTracks: () => [{ stop: () => order.push("microphone stopped") }] };
    client.audio = { pause: () => order.push("speaker stopped"), srcObject: {} };
    const stopped = client.stop();
    assert.deepEqual(order, ["microphone stopped", "speaker stopped", "server request"]);
    finishStop();
    await stopped;
});

test("a delegation uses its timestamped request even while the user starts another topic", async () => {
    let received;
    const f = bridgeFixture({ conversations: {
        recent: () => [
            { role: "user", text: "机の上を見て", start_ms: 0, received_at: Date.now() - 3000, evidence_event_ids: ["old"] },
            { role: "assistant", text: "確認している間、お話ししましょう。", start_ms: 800 },
            { role: "user", text: "最近紅茶にはまってる", start_ms: 1400, received_at: Date.now(), evidence_event_ids: ["new"] },
        ], append: async () => {},
    }, buildContext: async (input) => { received = input; return { ...input, turn_id: "root" }; } });
    await f.bridge.delegate({ sessionId: "live_test", offsetMs: 500 });
    assert.equal(received.payload.text, "机の上を見て");
});

test("stalled context acknowledgements bound pending updates without stopping conversation", async () => {
    const f = fixture({ config: { ...config.live, maxPendingAppends: 2 } });
    const owner = await f.service.start("v=0 offer");
    await f.service.events;
    assert.equal(f.service.append("thinking", "one"), true);
    assert.equal(f.service.append("thinking", "two"), true);
    assert.equal(f.service.append("thinking", "three"), false);
    assert.equal(f.service.status, "active");
    assert.equal(f.service.snapshot().pendingContextUpdates, 2);
    assert.equal(f.service.deliverResult("保存していた視覚の結果"), true);
    assert.equal(f.service.snapshot().pendingResults, 1);
    const id = f.sockets[0].sent[0].event_id;
    await f.service.handle(f.service.session, { type: "session.thinking.appended", event_id: "ack", client_event_id: id });
    f.service.sync();
    assert.equal(f.service.snapshot().pendingResults, 0);
    assert.ok(f.sockets[0].sent.some((event) => event.type === "session.commentary.append" && event.content === "保存していた視覚の結果"));
    await f.service.handle(f.service.session, { type: "session.thinking.appended", event_id: "ack2", client_event_id: f.sockets[0].sent[1].event_id });
    assert.equal(f.service.append("thinking", "three"), true);
    await f.service.stop(owner.control_token);
});

test("closing drains already-received transcript fragments before confirming final usage", async () => {
    const f = fixture();
    const owner = await f.service.start("v=0 offer");
    f.service.session.closing = true;
    await f.service.handle(f.service.session, { type: "session.input_transcript.delta", event_id: "last",
        delta: "最後の一言", start_ms: 100, end_ms: 200 });
    assert.equal(f.logged[0].text, "最後の一言");
    await f.service.stop(owner.control_token);
});
