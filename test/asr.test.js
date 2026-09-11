import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { BehaviorArchitecture } from "../src/behavior/index.js";
import {
    AsrTranscriptService,
    validateAsrTranscript,
} from "../src/speech/asr-transcript.js";
import { AsrTokenService, isLoopbackAddress } from "../src/speech/asr-token.js";
import { AliceAsrClient } from "../dashboard/asr-client.js";

const baseEvent = {
    event_id: "asr_session1_segment1_revision1",
    session_id: "session1",
    segment_id: "segment1",
    kind: "partial",
    revision: 1,
    text: "今日は",
    observed_at: "2026-09-11T12:00:00.000Z",
    language_code: "ja",
};

test("browser ASR clients share a locally served wrapper with a pinned ElevenLabs SDK version", async () => {
    const html = await fs.readFile(new URL("../realtime_stt.html", import.meta.url), "utf8");
    const dashboard = await fs.readFile(new URL("../dashboard/index.html", import.meta.url), "utf8");
    const client = await fs.readFile(new URL("../dashboard/asr-client.js", import.meta.url), "utf8");
    assert.match(html, /\/dashboard\/asr-client\.js/u);
    assert.match(dashboard, /id="microphone-button"/u);
    assert.match(client, /https:\/\/esm\.sh\/@elevenlabs\/client@1\.15\.1/u);
    assert.doesNotMatch(client, /cdn\.skypack\.dev/u);
});

test("shared browser ASR client streams partial text and delivers committed speech", async () => {
    const listeners = new Map();
    const connection = {
        on: (event, listener) => listeners.set(event, listener),
        close: () => {},
    };
    const posted = [];
    let connectOptions;
    let deliveredResolve;
    const delivered = new Promise((resolve) => { deliveredResolve = resolve; });
    const client = new AliceAsrClient({
        config: {
            languageCode: "ja",
            commitStrategy: "vad",
            vadSilenceThresholdSecs: 0.8,
            minSpeechDurationMs: 250,
        },
        sdkLoader: async () => ({
            Scribe: {
                connect: (options) => {
                    connectOptions = options;
                    return connection;
                },
            },
            CommitStrategy: { VAD: "vad", MANUAL: "manual" },
            RealtimeEvents: {
                OPEN: "open",
                ERROR: "error",
                CLOSE: "close",
                PARTIAL_TRANSCRIPT: "partial",
                COMMITTED_TRANSCRIPT: "committed",
            },
        }),
        fetchImpl: async (url, options) => {
            if (url === "/api/asr/token") {
                return {
                    ok: true,
                    json: async () => ({ token: "one-time-token", model_id: "scribe_v2_realtime" }),
                };
            }
            posted.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ status: "accepted" }) };
        },
        onDelivered: deliveredResolve,
    });

    await client.start();
    assert.equal(connectOptions.token, "one-time-token");
    assert.equal(connectOptions.commitStrategy, "vad");
    listeners.get("partial")({ text: "こん" });
    listeners.get("committed")({ text: "こんにちは", language_code: "ja" });
    await delivered;

    assert.deepEqual(posted.map((event) => event.kind), ["partial", "committed"]);
    assert.equal(posted[1].text, "こんにちは");
    assert.equal(posted[1].revision, 1);
    client.stop();
    assert.equal(client.isActive, false);
});

test("ASR transcript validation rejects malformed protocol fields", () => {
    const invalid = [
        { ...baseEvent, extra: true },
        { ...baseEvent, event_id: "bad id" },
        { ...baseEvent, session_id: "" },
        { ...baseEvent, kind: "final" },
        { ...baseEvent, revision: -1 },
        { ...baseEvent, revision: 1.5 },
        { ...baseEvent, observed_at: "yesterday" },
        { ...baseEvent, text: "123456" },
    ];
    for (const event of invalid) {
        assert.throws(() => validateAsrTranscript(event, { maxTextLength: 5 }), TypeError);
    }
    assert.throws(() => validateAsrTranscript({ ...baseEvent, kind: "committed", text: "  " }), /must not be empty/u);
});

test("partial ASR updates transient state, becomes stale, and is absent from cognitive projection", () => {
    let nowMs = Date.parse("2026-09-11T12:00:00.000Z");
    const architecture = new BehaviorArchitecture({ clock: () => nowMs, asrPartialTtlMs: 2000 });
    const { observation } = architecture.observe({
        id: baseEvent.event_id,
        type: "asr.partial_transcript",
        source: "elevenlabs_scribe",
        observed_at: baseEvent.observed_at,
        payload: {
            session_id: "session1",
            segment_id: "segment1",
            revision: 1,
            text: "今日は",
        },
    });
    let snapshot = architecture.snapshot();
    assert.equal(snapshot.state.interaction.user_speaking.value, true);
    assert.equal(snapshot.state.interaction.asr_partial.value.text, "今日は");

    const { observation: laterTrigger } = architecture.observe({
        id: "tick_after_partial",
        type: "system.spontaneous_tick",
        source: "test",
        observed_at: baseEvent.observed_at,
        payload: { reason: "projection_test" },
    });
    const context = architecture.composeContext(laterTrigger, { consumeProposals: false });
    assert.equal(JSON.stringify(context).includes("今日は"), false);

    nowMs += 2001;
    snapshot = architecture.snapshot();
    assert.equal(snapshot.state.interaction.user_speaking.status, "stale");
    assert.equal(snapshot.state.interaction.asr_partial.status, "stale");
});

test("committed ASR uses one normal speech input turn, clears partial state, and is idempotent", async () => {
    const architecture = new BehaviorArchitecture({ clock: () => Date.parse("2026-09-11T12:00:01.000Z") });
    const persisted = [];
    const prepared = [];
    const partialOptions = [];
    let dispatches = 0;
    const service = new AsrTranscriptService({
        config: { maxTextLength: 2000 },
        clock: () => "2026-09-11T12:00:01.000Z",
        ingestPartial: async (input, options) => {
            partialOptions.push(options);
            architecture.observe(input);
        },
        prepareCommitted: async (input) => {
            const { observation } = architecture.observe(input);
            persisted.push(observation);
            prepared.push(input);
            return architecture.composeContext(observation, { consumeProposals: false });
        },
        dispatchCommitted: async () => {
            dispatches += 1;
        },
    });

    await service.handle(baseEvent);
    const committed = {
        ...baseEvent,
        event_id: "asr_session1_segment1_committed",
        kind: "committed",
        revision: 1,
        text: "今日は寒いね",
    };
    const first = await service.handle(committed);
    const duplicate = await service.handle(committed);
    await service.handle({
        ...baseEvent,
        event_id: "asr_session1_segment1_revision2",
        revision: 2,
        text: "遅れて届いた部分認識",
    });

    assert.equal(first.turn_id, committed.event_id);
    assert.equal(first.forwarded_to_llm, true);
    assert.equal(duplicate.status, "duplicate_ignored");
    assert.equal(dispatches, 1);
    assert.deepEqual(partialOptions, [{ persist: false }]);
    assert.equal(persisted.length, 1);
    assert.equal(prepared[0].source, "elevenlabs_scribe");
    assert.equal(prepared[0].payload.modality, "speech");
    assert.deepEqual(prepared[0].payload.asr, {
        session_id: "session1",
        segment_id: "segment1",
        language_code: "ja",
    });
    const state = architecture.snapshot().state;
    assert.equal(state.interaction.user_speaking.value, false);
    assert.equal(state.interaction.asr_partial.status, "unknown");
});

test("failed committed delivery retries the prepared context without creating a second turn", async () => {
    let prepares = 0;
    let dispatches = 0;
    const service = new AsrTranscriptService({
        config: { maxTextLength: 2000 },
        ingestPartial: async () => {},
        prepareCommitted: async (input) => {
            prepares += 1;
            return { turn_id: input.id };
        },
        dispatchCommitted: async () => {
            dispatches += 1;
            if (dispatches === 1) throw new Error("bridge unavailable");
        },
    });
    const committed = { ...baseEvent, event_id: "asr_retry_committed", kind: "committed" };
    await assert.rejects(service.handle(committed), /bridge unavailable/u);
    const result = await service.handle(committed);
    assert.equal(result.status, "accepted");
    assert.equal(prepares, 1);
    assert.equal(dispatches, 2);
});

test("ASR service suppresses similar TTS loopback while accepting dissimilar speech", async () => {
    let prepares = 0;
    let suppressed = 0;
    const service = new AsrTranscriptService({
        config: { maxTextLength: 2000 },
        clock: () => "2026-09-11T12:00:01.000Z",
        ingestPartial: async () => {},
        prepareCommitted: async (input) => {
            prepares += 1;
            return { turn_id: input.id };
        },
        dispatchCommitted: async () => {},
        echoGuard: {
            match: (text) => text.includes("Aliceの声")
                ? { turnId: "tts_1", method: "containment", similarity: 0.95 }
                : null,
        },
        onEchoSuppressed: async () => {
            suppressed += 1;
        },
    });
    const echo = await service.handle({
        ...baseEvent,
        event_id: "asr_echo_committed",
        kind: "committed",
        text: "Aliceの声です",
    });
    const human = await service.handle({
        ...baseEvent,
        event_id: "asr_human_committed",
        segment_id: "segment2",
        kind: "committed",
        text: "窓を閉めて",
    });
    assert.equal(echo.status, "echo_suppressed");
    assert.equal(human.status, "accepted");
    assert.equal(suppressed, 1);
    assert.equal(prepares, 1);
});

test("token service accepts IPv4 and IPv6 loopback without exposing the API key", async () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("192.168.1.10"), false);
    assert.equal(isLoopbackAddress("127.999.0.1"), false);

    const service = new AsrTokenService({
        enabled: true,
        provider: "elevenlabs_scribe",
        modelId: "scribe_v2_realtime",
        loopbackOnly: true,
        apiKey: "secret-api-key",
        client: { tokens: { singleUse: { create: async () => ({ token: "single-use-token" }) } } },
    });
    const payload = await service.issue("::1");
    assert.deepEqual(payload, {
        token: "single-use-token",
        provider: "elevenlabs_scribe",
        model_id: "scribe_v2_realtime",
    });
    assert.equal(JSON.stringify(payload).includes("secret-api-key"), false);
    await assert.rejects(service.issue("10.0.0.2"), (error) => error.statusCode === 403);

    const unavailable = new AsrTokenService({ enabled: false });
    await assert.rejects(unavailable.issue("::1"), (error) => error.statusCode === 503);
    const providerFailure = new AsrTokenService({
        enabled: true,
        provider: "elevenlabs_scribe",
        modelId: "scribe_v2_realtime",
        loopbackOnly: false,
        apiKey: "secret-api-key",
        client: { tokens: { singleUse: { create: async () => { throw new Error("raw provider body secret-api-key"); } } } },
    });
    await assert.rejects(providerFailure.issue("::1"), (error) => (
        error.statusCode === 502 && error.message === "ASR provider token request failed"
    ));
});
