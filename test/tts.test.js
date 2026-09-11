import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { buildElevenLabsTtsRequest, ElevenLabsTtsProvider } from "../src/speech/elevenlabs-tts.js";
import { TtsAdapter } from "../src/speech/tts-adapter.js";
import { TtsEchoGuard } from "../src/speech/echo-guard.js";

const emotions = ["neutral", "happy", "calm", "sad", "angry", "surprised", "fear", "thinking"];
const config = {
    provider: "elevenlabs",
    defaultModelId: "eleven_v3",
    similarityBoost: 0.75,
    speakerBoost: true,
    stabilityAtIntensityZero: 0.65,
    stabilityAtIntensityOne: 0.35,
    styleAtIntensityZero: 0,
    styleAtIntensityOne: 0.35,
    emotionTags: {
        neutral: null,
        happy: "[happily]",
        calm: "[calmly]",
        sad: "[sad]",
        angry: "[angry]",
        surprised: "[surprised]",
        fear: "[worried]",
        thinking: "[thoughtfully]",
    },
};

test("all allowed emotions map deterministically without changing original speech", () => {
    for (const emotion of emotions) {
        const request = buildElevenLabsTtsRequest({ text: "大丈夫？", emotion, intensity: 0.4 }, config);
        assert.equal(request.originalText, "大丈夫？");
        if (emotion === "neutral") assert.equal(request.renderedText, "大丈夫？");
        else assert.equal(request.renderedText, `${config.emotionTags[emotion]} 大丈夫？`);
        assert.equal(request.renderedText.split(config.emotionTags[emotion] ?? "__never__").length <= 2, true);
    }
});

test("intensity interpolation is bounded and produces the specified voice settings", () => {
    const expected = [
        [0, 0.65],
        [0.5, 0.5],
        [1, 0.35],
    ];
    for (const [intensity, stability] of expected) {
        const request = buildElevenLabsTtsRequest({ text: "大丈夫？", emotion: "fear", intensity }, config);
        assert.deepEqual(request.body.voice_settings, { stability });
    }
    const example = buildElevenLabsTtsRequest({ text: "大丈夫？", emotion: "fear", intensity: 0.4 }, config);
    assert.equal(example.body.text, "[worried] 大丈夫？");
    assert.equal(example.body.voice_settings.stability, 0.53);
    assert.equal("similarity_boost" in example.body.voice_settings, false);
    assert.equal("style" in example.body.voice_settings, false);
    assert.equal("use_speaker_boost" in example.body.voice_settings, false);
    assert.equal("speed" in example.body.voice_settings, false);
});

test("non-v3 models retain configurable similarity, style, and speaker boost settings", () => {
    const request = buildElevenLabsTtsRequest(
        { text: "大丈夫？", emotion: "fear", intensity: 0.4 },
        { ...config, defaultModelId: "eleven_multilingual_v2" },
    );
    assert.deepEqual(request.body.voice_settings, {
        stability: 0.53,
        similarity_boost: 0.75,
        style: 0.14,
        use_speaker_boost: true,
    });
});

test("only the configured prefix is treated as an ElevenLabs control tag", () => {
    const request = buildElevenLabsTtsRequest({
        text: "[angry] これは読み上げる文字です",
        emotion: "happy",
        intensity: 0.5,
    }, config);
    assert.equal(request.originalText, "[angry] これは読み上げる文字です");
    assert.equal(request.renderedText, "[happily] ［angry］ これは読み上げる文字です");
});

function fakeProvider(run) {
    return {
        name: "elevenlabs",
        modelId: "eleven_v3",
        buildRequest: (request) => buildElevenLabsTtsRequest(request, config),
        speak: run,
    };
}

function adapterWith({ enabled = true, run, events }) {
    return new TtsAdapter({
        enabled,
        provider: fakeProvider(run),
        validEmotions: emotions,
        onObservation: async (event) => events.push(event),
        clock: () => "2026-09-11T12:00:00.000Z",
    });
}

const speechRequest = { turnId: "obs_123", text: "大丈夫？", emotion: "fear", intensity: 0.4 };

test("TTS disabled, completed, HTTP-failed, and playback-failed produce distinct inspectable outcomes", async () => {
    const disabledEvents = [];
    const disabled = adapterWith({ enabled: false, run: async () => assert.fail("provider called"), events: disabledEvents });
    assert.equal((await disabled.speak(speechRequest)).status, "skipped");
    assert.deepEqual(disabledEvents.map((event) => event.type), ["speech.output_requested", "speech.output_skipped"]);

    const completedEvents = [];
    const completed = adapterWith({
        events: completedEvents,
        run: async ({ onPlaybackStarted }) => onPlaybackStarted(),
    });
    assert.equal((await completed.speak(speechRequest)).status, "completed");
    assert.deepEqual(completedEvents.map((event) => event.type), [
        "speech.output_requested",
        "speech.output_started",
        "speech.output_completed",
    ]);

    for (const message of ["TTS provider returned HTTP 503", "TTS player exited with code 1"]) {
        const events = [];
        const failed = adapterWith({ events, run: async () => { throw new Error(message); } });
        const outcome = await failed.speak(speechRequest);
        assert.equal(outcome.status, "failed");
        assert.equal(outcome.error, message);
        assert.equal(events.at(-1).type, "speech.output_failed");
    }
});

test("a failed FIFO item does not prevent the next TTS item from completing", async () => {
    let calls = 0;
    const events = [];
    const adapter = adapterWith({
        events,
        run: async ({ onPlaybackStarted }) => {
            calls += 1;
            if (calls === 1) throw new Error("first failed");
            await onPlaybackStarted();
        },
    });
    const first = adapter.speak(speechRequest);
    const second = adapter.speak({ ...speechRequest, turnId: "obs_124" });
    assert.equal((await first).status, "failed");
    assert.equal((await second).status, "completed");
    assert.equal(calls, 2);
});

test("echo guard suppresses similar recent TTS but preserves dissimilar human speech", () => {
    const guard = new TtsEchoGuard({ echoGuardMs: 1000 });
    guard.start({ turnId: "obs_123", text: "今日は少し寒いね。", startedAt: "2026-09-11T12:00:00.000Z" });
    guard.finish({ turnId: "obs_123", completedAt: "2026-09-11T12:00:02.000Z" });

    assert.ok(guard.match("今日は、少し寒いね", "2026-09-11T12:00:02.500Z"));
    assert.equal(guard.match("窓を閉めてほしい", "2026-09-11T12:00:01.000Z"), null);
    assert.equal(guard.match("今日は少し寒いね", "2026-09-11T12:00:03.100Z"), null);
});

function audioBody() {
    return {
        async *[Symbol.asyncIterator]() {
            yield Buffer.from([1, 2, 3]);
        },
    };
}

function fakePlayer(exitCode = 0) {
    const player = new EventEmitter();
    player.stdin = new Writable({
        write(chunk, encoding, callback) {
            callback();
        },
        final(callback) {
            callback();
            queueMicrotask(() => player.emit("close", exitCode));
        },
    });
    return player;
}

test("ElevenLabs provider uses injected network/process I/O and sanitizes failures", async () => {
    const providerConfig = {
        ...config,
        baseUrl: "https://example.invalid/v1/text-to-speech",
        defaultVoiceId: "voice_1",
        defaultOutputFormat: "mp3_44100_128",
        playerCommand: "ffplay",
        playerArgs: ["-"],
    };
    let requestOptions;
    let starts = 0;
    const playbackOrder = [];
    const successful = new ElevenLabsTtsProvider({
        config: providerConfig,
        apiKey: "test-key",
        fetchImpl: async (url, options) => {
            assert.match(url, /voice_1\/stream/u);
            requestOptions = options;
            return { ok: true, status: 200, body: audioBody() };
        },
        spawnImpl: () => fakePlayer(0),
    });
    const prepared = successful.buildRequest(speechRequest);
    await successful.speak({
        body: prepared.body,
        onBeforePlayback: async () => { playbackOrder.push("capture_paused"); },
        onPlaybackStarted: async () => { starts += 1; playbackOrder.push("playback_started"); },
    });
    assert.equal(starts, 1);
    assert.deepEqual(playbackOrder, ["capture_paused", "playback_started"]);
    assert.equal(JSON.parse(requestOptions.body).text, "[worried] 大丈夫？");

    const httpFailed = new ElevenLabsTtsProvider({
        config: providerConfig,
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: false, status: 401, body: { raw: "sensitive" } }),
        spawnImpl: () => assert.fail("player must not start after HTTP failure"),
    });
    await assert.rejects(
        httpFailed.speak({ body: prepared.body, onPlaybackStarted: async () => {} }),
        (error) => error.message === "TTS provider returned HTTP 401" && !error.message.includes("sensitive"),
    );

    const playbackFailed = new ElevenLabsTtsProvider({
        config: providerConfig,
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: true, status: 200, body: audioBody() }),
        spawnImpl: () => fakePlayer(2),
    });
    await assert.rejects(
        playbackFailed.speak({ body: prepared.body, onPlaybackStarted: async () => {} }),
        /TTS player exited with code 2/u,
    );
});

function failingInputPlayer({ writeReturns = true, errorCode = null, closeCode = null }) {
    const player = new EventEmitter();
    const input = new EventEmitter();
    input.destroyed = false;
    input.write = () => {
        if (errorCode) {
            queueMicrotask(() => input.emit("error", Object.assign(new Error(errorCode), { code: errorCode })));
        }
        if (closeCode !== null) queueMicrotask(() => player.emit("close", closeCode));
        return writeReturns;
    };
    input.end = () => {};
    input.destroy = () => { input.destroyed = true; };
    player.stdin = input;
    return player;
}

test("ElevenLabs provider handles ffplay EPIPE without an unhandled stdin error", async () => {
    const provider = new ElevenLabsTtsProvider({
        config: {
            ...config,
            baseUrl: "https://example.invalid/v1/text-to-speech",
            defaultVoiceId: "voice_1",
            defaultOutputFormat: "mp3_44100_128",
            playerCommand: "ffplay",
            playerArgs: ["-"],
        },
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: true, status: 200, body: audioBody() }),
        spawnImpl: () => failingInputPlayer({ errorCode: "EPIPE" }),
    });
    await assert.rejects(
        provider.speak({ body: { text: "test" }, onPlaybackStarted: async () => {} }),
        /TTS player input closed during audio streaming/u,
    );
});

test("ElevenLabs provider does not hang when ffplay exits while backpressure waits for drain", async () => {
    const provider = new ElevenLabsTtsProvider({
        config: {
            ...config,
            baseUrl: "https://example.invalid/v1/text-to-speech",
            defaultVoiceId: "voice_1",
            defaultOutputFormat: "mp3_44100_128",
            playerCommand: "ffplay",
            playerArgs: ["-"],
        },
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: true, status: 200, body: audioBody() }),
        spawnImpl: () => failingInputPlayer({ writeReturns: false, closeCode: 0 }),
    });
    await assert.rejects(
        provider.speak({ body: { text: "test" }, onPlaybackStarted: async () => {} }),
        /TTS player closed before the audio stream completed/u,
    );
});
