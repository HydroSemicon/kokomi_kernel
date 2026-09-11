import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventStore } from "../src/behavior/event-store.js";
import { BehaviorArchitecture } from "../src/behavior/index.js";

test("event store checkpoints high-rate sensors and replays durable semantic events", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-events-test-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "observations.jsonl");
    let nowMs = Date.parse("2026-09-10T00:00:00.000Z");
    const store = new EventStore({ filePath, clock: () => nowMs, sensorCheckpointMs: 60_000 });
    await store.initialize();
    const sensor = {
        id: "sensor_1",
        type: "sensor.environment_sample",
        source: "bme280",
        observed_at: new Date(nowMs).toISOString(),
        payload: { temperature: 25 },
    };
    assert.equal(await store.append(sensor), true);
    nowMs += 1_000;
    assert.equal(await store.append({ ...sensor, id: "sensor_2" }), false);
    assert.equal(await store.append({
        id: "user_1",
        type: "interaction.user_input",
        source: "user",
        observed_at: new Date(nowMs).toISOString(),
        payload: { text: "こんにちは" },
    }), true);

    const replay = await new EventStore({ filePath }).initialize();
    assert.deepEqual(replay.map((event) => event.id), ["sensor_1", "user_1"]);
    const reloaded = new EventStore({ filePath });
    await reloaded.initialize();
    assert.equal(reloaded.has("user_1"), true);
    assert.equal(reloaded.has("invented_event"), false);
});

test("replayed observations rebuild state without replaying spontaneous proposals", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-replay-test-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "observations.jsonl");
    const nowMs = Date.parse("2026-09-10T00:00:00.000Z");
    const store = new EventStore({ filePath, clock: () => nowMs });
    await store.append({
        id: "touch_1",
        type: "touch.petting_started",
        source: "touch",
        observed_at: new Date(nowMs).toISOString(),
        received_at: new Date(nowMs).toISOString(),
        confidence: 1,
        payload: { body_part: "head" },
    });

    const architecture = new BehaviorArchitecture({ clock: () => nowMs });
    for (const observation of await new EventStore({ filePath }).initialize()) {
        architecture.observe(observation, { generateProposals: false });
    }
    assert.equal(architecture.snapshot().state.interaction.being_petted.value, true);
    assert.equal(architecture.peekPendingProposals().length, 0);
});

test("startup reconciliation persists an interrupted outcome for unfinished TTS playback", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-tts-recovery-test-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "observations.jsonl");
    let nowMs = Date.parse("2026-09-10T00:00:00.000Z");
    const store = new EventStore({ filePath, clock: () => nowMs });
    const original = new BehaviorArchitecture({ clock: () => nowMs }).observe({
        type: "speech.output_started",
        source: "tts_adapter",
        payload: {
            turn_id: "turn_1",
            emotion: "calm",
            intensity: 0.4,
            provider: "elevenlabs",
            model_id: "eleven_v3",
            requested_at: "2026-09-10T00:00:00.000Z",
            started_at: "2026-09-10T00:00:00.000Z",
            original_text: "こんにちは",
            rendered_text: "[calmly] こんにちは",
            status: "started",
            error: null,
        },
    }, { generateProposals: false }).observation;
    await store.append(original, { force: true });

    nowMs += 1_000;
    const recovered = new BehaviorArchitecture({ clock: () => nowMs });
    for (const observation of await new EventStore({ filePath }).initialize()) {
        recovered.observe(observation, { generateProposals: false });
    }
    assert.equal(recovered.snapshot().state.output.tts.playing, true);

    const recoveryInput = recovered.reconcileInterruptedTts();
    assert.equal(recoveryInput.payload.reason, "kernel_restart");
    const recoveryObservation = recovered.observe(
        recoveryInput,
        { generateProposals: false },
    ).observation;
    await store.append(recoveryObservation, { force: true });
    assert.equal(recovered.snapshot().state.output.tts.playing, false);
    assert.equal(recovered.snapshot().state.output.tts.last_status, "interrupted");

    const replayed = new BehaviorArchitecture({ clock: () => nowMs });
    for (const observation of await new EventStore({ filePath }).initialize()) {
        replayed.observe(observation, { generateProposals: false });
    }
    assert.equal(replayed.snapshot().state.output.tts.playing, false);
    assert.equal(replayed.snapshot().state.output.tts.last_status, "interrupted");
    assert.equal(replayed.reconcileInterruptedTts(), null);
});
