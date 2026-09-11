import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AsrCaptureCoordinator } from "../src/speech/asr-capture-coordinator.js";
import { PlaybackCoordinator } from "../src/speech/playback-coordinator.js";
import { AudioOutputLifecycle } from "../src/speech/audio-output-lifecycle.js";
import { FillerController } from "../src/speech/filler-controller.js";
import { loadFillerManifest } from "../src/speech/filler-manifest.js";
import { AsrTranscriptService } from "../src/speech/asr-transcript.js";
import { AliceAsrClient } from "../dashboard/asr-client.js";
import { BehaviorArchitecture } from "../src/behavior/index.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("ASR capture coordinator waits for pause acknowledgement and resumes after its guard", async () => {
    const messages = [];
    const coordinator = new AsrCaptureCoordinator({ ackTimeoutMs: 50, resumeGuardMs: 5 });
    const clientId = coordinator.connect((message) => messages.push(message));
    const pause = coordinator.pause({ reason: "main_tts", outputId: "turn_1" });
    const revision = coordinator.snapshot().revision;
    assert.equal(coordinator.acknowledge({ clientId, revision, paused: true }), true);
    const result = await pause;
    assert.equal(result.acknowledged, 1);
    assert.equal(result.timed_out, false);
    assert.equal(coordinator.snapshot().paused, true);
    assert.equal(coordinator.shouldSuppress("2000-01-01T00:00:00.000Z"), false);
    assert.equal(coordinator.shouldSuppress(new Date().toISOString()), true);
    coordinator.scheduleResume();
    await wait(10);
    assert.equal(coordinator.snapshot().paused, false);
    assert.match(messages.join(""), /event: capture/u);
    coordinator.close();
});

test("browser ASR pause closes capture and resume reconnects with a fresh token", async () => {
    const connections = [];
    let tokenNumber = 0;
    const client = new AliceAsrClient({
        sdkLoader: async () => ({
            Scribe: {
                connect: ({ token }) => {
                    const connection = { token, closeCalls: 0, on: () => {}, close() { this.closeCalls += 1; } };
                    connections.push(connection);
                    return connection;
                },
            },
            CommitStrategy: { VAD: "vad", MANUAL: "manual" },
            RealtimeEvents: {
                OPEN: "open", ERROR: "error", CLOSE: "close", PARTIAL_TRANSCRIPT: "partial", COMMITTED_TRANSCRIPT: "committed",
            },
        }),
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ token: `token_${++tokenNumber}` }),
        }),
    });
    await client.start();
    assert.equal(connections[0].token, "token_1");
    await client.setCapturePaused(true, "main_tts");
    assert.equal(connections[0].closeCalls, 1);
    assert.equal(client.isActive, false);
    assert.equal(client.isStarted, true);
    await client.setCapturePaused(false);
    assert.equal(connections[1].token, "token_2");
    client.stop();
});

test("Kernel rejects every ASR event while output capture is paused", async () => {
    let ingested = 0;
    let prepared = 0;
    let suppressed = 0;
    const service = new AsrTranscriptService({
        config: { maxTextLength: 2000 },
        ingestPartial: async () => { ingested += 1; },
        prepareCommitted: async () => { prepared += 1; },
        dispatchCommitted: async () => {},
        isCapturePaused: () => true,
        onCaptureSuppressed: async () => { suppressed += 1; },
    });
    const base = { session_id: "session1", segment_id: "segment1", revision: 1, text: "心海の声" };
    const partial = await service.handle({ ...base, event_id: "paused_partial", kind: "partial" });
    const committed = await service.handle({ ...base, event_id: "paused_committed", kind: "committed" });
    assert.equal(partial.status, "capture_suppressed");
    assert.equal(committed.status, "capture_suppressed");
    assert.equal(ingested, 0);
    assert.equal(prepared, 0);
    assert.equal(suppressed, 2);
});

test("filler manifest rejects traversal and loads bounded local WAV clips", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-filler-manifest-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, "thinking.wav"), Buffer.from("RIFF"));
    const manifest = {
        schema_version: "1.0",
        set_id: "test-set",
        voice_id: "voice",
        generator: "test",
        generator_model: "test",
        created_at: "2026-09-12T00:00:00.000Z",
        clips: [{
            id: "thinking_1", kind: "thinking", text: "んー", path: "thinking.wav", duration_ms: 300,
            emotion: "thinking", intensity: 0.2, semantic_commitment: "none",
        }],
    };
    const manifestPath = path.join(directory, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const loaded = await loadFillerManifest({ manifestPath, maxClipDurationMs: 1000, validEmotions: ["thinking"] });
    assert.equal(loaded.clips[0].absolutePath, path.join(directory, "thinking.wav"));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, clips: [{ ...manifest.clips[0], path: "../escape.wav" }] }));
    await assert.rejects(
        loadFillerManifest({ manifestPath, maxClipDurationMs: 1000, validEmotions: ["thinking"] }),
        /escapes/u,
    );
});

function fillerFixture({ delayMs = 5, player } = {}) {
    const events = [];
    const capture = new AsrCaptureCoordinator({ resumeGuardMs: 1 });
    const lifecycle = new AudioOutputLifecycle({ playbackCoordinator: new PlaybackCoordinator(), captureCoordinator: capture });
    const controller = new FillerController({
        config: {
            enabled: true, armed: true, experimentSeed: "seed", globalCooldownMs: 0,
            thinking: { enabled: true, delayMs },
            listening: { enabled: true, armed: false, minimumSpeechMs: 5, minimumPartialCharacters: 3 },
        },
        manifest: {
            set_id: "fillers-v1",
            clips: [{ id: "thinking_1", kind: "thinking", text: "んー", absolutePath: "thinking.wav" }],
        },
        player: player ?? { play: async ({ onStarted }) => { await onStarted(); return { status: "completed" }; }, stop: () => true },
        outputLifecycle: lifecycle,
        onObservation: async (event) => events.push(event),
    });
    return { controller, events, capture };
}

test("a slow ASR turn emits one local thinking filler and a ready response cancels it", async () => {
    const slow = fillerFixture();
    slow.controller.scheduleThinking({ turnId: "turn_slow", sessionId: "s", segmentId: "one" });
    await wait(20);
    assert.deepEqual(slow.events.map((event) => event.type), [
        "speech.filler_scheduled", "speech.filler_started", "speech.filler_completed",
    ]);
    assert.equal(slow.controller.snapshot().counts.started, 1);

    const fast = fillerFixture({ delayMs: 30 });
    fast.controller.scheduleThinking({ turnId: "turn_fast", sessionId: "s", segmentId: "two" });
    await fast.controller.markResponseReady("turn_fast");
    await wait(40);
    assert.deepEqual(fast.events.map((event) => event.type), ["speech.filler_scheduled", "speech.filler_cancelled"]);
    assert.equal(fast.controller.snapshot().counts.started, 0);
    slow.controller.close();
    fast.controller.close();
});

test("listening backchannel remains independently unarmed", async () => {
    const fixture = fillerFixture();
    fixture.controller.observePartial({ sessionId: "s", segmentId: "long", revision: 1, text: "これは十分長い発話です" });
    await wait(15);
    const suppressed = fixture.events.find((event) => event.type === "speech.filler_suppressed");
    assert.equal(suppressed.payload.reason, "listening_unarmed");
    fixture.controller.close();
});

test("main TTS and filler leases never own the audible output lane together", async () => {
    const coordinator = new PlaybackCoordinator();
    const releaseFiller = await coordinator.acquire({ kind: "thinking_filler", outputId: "filler_1" });
    let mainAcquired = false;
    const main = coordinator.acquire({ kind: "main_tts", outputId: "turn_1" }).then((release) => {
        mainAcquired = true;
        return release;
    });
    await wait(5);
    assert.equal(mainAcquired, false);
    assert.equal(coordinator.snapshot().kind, "thinking_filler");
    releaseFiller();
    const releaseMain = await main;
    assert.equal(coordinator.snapshot().kind, "main_tts");
    releaseMain();
    await wait(0);
    assert.equal(coordinator.snapshot().busy, false);
});

test("unfinished filler playback is reconciled as interrupted after restart", () => {
    const architecture = new BehaviorArchitecture({ clock: () => Date.parse("2026-09-12T00:00:02.000Z") });
    architecture.observe({
        type: "speech.filler_started",
        source: "filler_controller",
        observed_at: "2026-09-12T00:00:01.000Z",
        payload: { filler_id: "filler_1", clip_id: "thinking_1", kind: "thinking", status: "started" },
    }, { generateProposals: false });
    const interrupted = architecture.reconcileInterruptedFiller();
    assert.equal(interrupted.type, "speech.filler_interrupted");
    assert.equal(interrupted.payload.status, "interrupted");
    assert.equal(interrupted.payload.reason, "kernel_restart");
});
