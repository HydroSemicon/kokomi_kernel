import test from "node:test";
import assert from "node:assert/strict";
import { LiveBrowserClient } from "../dashboard/live-client.js";

function browserFixture(fetchImpl) {
    let stopped = 0;
    const channel = { close() {} };
    const statuses = [];
    const peer = { iceGatheringState: "complete", localDescription: { sdp: "v=0 offer" },
        createDataChannel: () => channel, createOffer: async () => ({}), setLocalDescription: async () => {},
        setRemoteDescription: async () => {}, addTrack() {}, close() {} };
    const client = new LiveBrowserClient({ fetchImpl, peerFactory: () => peer, onStatus: (...args) => statuses.push(args),
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) },
        audioFactory: () => ({ play: async () => {}, pause() {} }) });
    return { client, peer, channel, statuses, stopped: () => stopped };
}

test("a rejected Live event is shown without stopping the microphone or heartbeat session", async (t) => {
    const requests = [];
    const f = browserFixture(async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => url === "/api/live/session"
            ? { control_token: "owner", sdp: "answer", heartbeat_interval_ms: 60000 }
            : url === "/api/live/heartbeat" ? { status: "active", contextWarning: "command rejected" } : { closeConfirmed: true } };
    });
    t.after(() => f.client.stop());
    await f.client.start();
    f.channel.onmessage({ data: JSON.stringify({ type: "session.started" }) });
    f.channel.onmessage({ data: JSON.stringify({ type: "error", error: { code: "invalid_request",
        message: "command rejected" } }) });
    await f.client.sendHeartbeat(f.client.generation, f.client.owner);
    assert.equal(f.client.active, true);
    assert.equal(f.stopped(), 0);
    assert.equal(requests.some((request) => request.url === "/api/live/stop"), false);
    assert.ok(requests.some((request) => request.url === "/api/live/heartbeat" && request.body.started === true));
    assert.ok(f.statuses.some(([status, message]) => status === "warning" && /command rejected/u.test(message)));
});

test("stopping during session creation closes a late server session and never opens a second one", async () => {
    let finishCreate;
    let creating;
    const requested = new Promise((resolve) => { creating = resolve; });
    const requests = [];
    const f = browserFixture(async (url) => {
        requests.push(url);
        if (url === "/api/live/session") {
            creating();
            return await new Promise((resolve) => { finishCreate = resolve; });
        }
        return { ok: true, json: async () => ({ closeConfirmed: true }) };
    });
    const started = f.client.start();
    await requested;
    await f.client.start(); // Double clicks must not create another session.
    await f.client.stop();
    finishCreate({ ok: true, json: async () => ({ control_token: "late", sdp: "answer", heartbeat_interval_ms: 5000 }) });
    await started;
    assert.deepEqual(requests, ["/api/live/session", "/api/live/stop"]);
    assert.equal(f.stopped(), 1);
    assert.equal(f.client.heartbeatTimer, undefined);
});

test("stopping during SDP answer application does not leave a heartbeat timer running", async () => {
    let finishAnswer;
    let answering;
    const applied = new Promise((resolve) => { answering = resolve; });
    const f = browserFixture(async (url) => ({ ok: true, json: async () => url === "/api/live/session"
        ? { control_token: "owner", sdp: "answer", heartbeat_interval_ms: 5000 } : { closeConfirmed: true } }));
    f.peer.setRemoteDescription = async () => { answering(); await new Promise((resolve) => { finishAnswer = resolve; }); };
    const started = f.client.start();
    await applied;
    await f.client.stop();
    finishAnswer();
    await started;
    assert.equal(f.client.heartbeatTimer, undefined);
    assert.equal(f.client.owner, null);
    assert.equal(f.stopped(), 1);
});
