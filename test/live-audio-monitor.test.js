import test from "node:test";
import assert from "node:assert/strict";
import { LiveAudioMonitor } from "../dashboard/live-audio-monitor.js";

function fixture(t, { sound = true } = {}) {
    let now = 0;
    let played = 0;
    const warnings = [];
    const stats = new Map();
    const monitor = new LiveAudioMonitor({ clock: () => now,
        config: { silenceWarningSeconds: 60, silenceWarningRepeatSeconds: 60, silenceAudioLevel: 0.02 },
        alarm: { prepare() {}, play: () => { played++; return sound; }, close() {} },
        onWarning: (warning) => warnings.push(warning) });
    monitor.start({ getStats: async () => stats });
    t.after(() => monitor.stop());
    return { monitor, warnings, stats, played: () => played, setNow: (value) => { now = value; } };
}

test("one minute of silence warns audibly, repeats once a minute, and resets on activity", (t) => {
    const f = fixture(t);
    f.setNow(59999); f.monitor.checkSilence();
    assert.equal(f.played(), 0);
    f.setNow(60000); f.monitor.checkSilence();
    assert.equal(f.played(), 1);
    assert.equal(f.warnings[0].soundPlayed, true);
    f.setNow(119999); f.monitor.checkSilence();
    assert.equal(f.played(), 1);
    f.setNow(120000); f.monitor.checkSilence();
    assert.equal(f.played(), 2);
    f.monitor.noteActivity();
    f.setNow(179999); f.monitor.checkSilence();
    assert.equal(f.played(), 2);
    f.monitor.stop(); f.setNow(240000); f.monitor.checkSilence();
    assert.equal(f.played(), 2);
});

test("both microphone and remote audio energy prevent a false silence warning", async (t) => {
    const f = fixture(t);
    f.stats.set("mic", { id: "mic", type: "media-source", kind: "audio", totalAudioEnergy: 0.01, totalSamplesDuration: 1 });
    f.setNow(60000); await f.monitor.sample();
    assert.equal(f.played(), 0);
    f.stats.set("mic", { id: "mic", type: "media-source", kind: "audio", totalAudioEnergy: 0.01, totalSamplesDuration: 2 });
    f.stats.set("speaker", { id: "speaker", type: "inbound-rtp", kind: "audio", audioLevel: 0.1 });
    f.setNow(120000); await f.monitor.sample();
    assert.equal(f.played(), 0);
    f.stats.set("speaker", { id: "speaker", type: "inbound-rtp", kind: "audio", audioLevel: 0 });
    f.setNow(180000); await f.monitor.sample();
    assert.equal(f.played(), 1);
});

test("diagnostics distinguish packet loss, concealment and jitter buffer delay without storing audio", async (t) => {
    const f = fixture(t);
    const base = { id: "incoming", type: "inbound-rtp", kind: "audio", packetsLost: 0,
        packetsDiscarded: 0, concealedSamples: 0, concealmentEvents: 0, jitter: 0.015,
        jitterBufferDelay: 1, jitterBufferEmittedCount: 100 };
    f.stats.set(base.id, base); await f.monitor.sample();
    f.setNow(1000);
    f.stats.set(base.id, { ...base, packetsLost: 2, concealedSamples: 960, concealmentEvents: 1,
        jitterBufferDelay: 1.8, jitterBufferEmittedCount: 110 });
    await f.monitor.sample();
    const sample = f.monitor.snapshot().samples.at(-1).incoming[0];
    assert.equal(sample.lostDelta, 2);
    assert.equal(sample.concealedDelta, 960);
    assert.equal(sample.concealmentEventsDelta, 1);
    assert.equal(sample.jitterMs, 15);
    assert.ok(Math.abs(sample.bufferMs - 80) < 0.001);
    f.monitor.stop();
    assert.equal(f.monitor.snapshot().samples.length, 2);
});

test("a blocked warning sound is reported so the UI can offer an audio permission button", (t) => {
    const f = fixture(t, { sound: false });
    f.setNow(60000); f.monitor.checkSilence();
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0].soundPlayed, false);
});
