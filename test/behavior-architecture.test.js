import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorArchitecture, createObservation } from "../src/behavior/index.js";

function testArchitecture() {
    let nowMs = Date.parse("2026-09-10T00:00:00.000Z");
    const architecture = new BehaviorArchitecture({
        clock: () => nowMs,
        config: {
            freshness: {
                environment_ms: 1_000,
                brightness_ms: 1_000,
                person_ms: 1_000,
            },
            thresholds: {
                cold_celsius: 18,
                warm_celsius: 27,
                hot_celsius: 31,
                dark_brightness: 40,
                bright_brightness: 75,
            },
            persona: { id: "kokomi-origin", version: "test-version" },
        },
    });
    return {
        architecture,
        advance(milliseconds) { nowMs += milliseconds; },
    };
}

test("observation envelopes reject unsafe externally supplied identifiers", () => {
    assert.throws(() => createObservation({
        id: "bad id with spaces",
        type: "audio.classification",
        source: "yamnet",
        payload: { label: "speech" },
    }), /observation id/u);
});

test("raw observations become persistent state and a deterministic world model", () => {
    const { architecture } = testArchitecture();
    architecture.observe({
        id: "obs_environment",
        type: "sensor.environment_sample",
        source: "bme280",
        payload: { temperature: 32, humidity: 56, units: { temperature: "celsius", humidity: "percent" } },
    });
    architecture.observe({
        id: "obs_brightness",
        type: "sensor.brightness_sample",
        source: "cds",
        payload: { brightness: 30, unit: "raw" },
    });
    architecture.observe({
        id: "vision_1",
        type: "vision.person_recognized",
        source: "deepsort",
        payload: {
            track_id: "7",
            identity: { status: "recognized", person_id: "person_1", name: "KOT" },
            position: "center",
        },
    });

    const { state, world } = architecture.snapshot();
    assert.equal(state.environment.temperature.value, 32);
    assert.equal(state.perception.person_present.value, true);
    assert.equal(world.room.is_occupied.value, true);
    assert.equal(world.environment.thermal_condition.value, "hot");
    assert.equal(world.environment.lighting_condition.value, "dark");
});

test("stale sensor data becomes unknown rather than silently becoming false", () => {
    const { architecture, advance } = testArchitecture();
    architecture.observe({
        type: "sensor.environment_sample",
        source: "bme280",
        payload: { temperature: 28, units: { temperature: "celsius" } },
    });
    advance(1_001);

    const { state, world } = architecture.snapshot();
    assert.equal(state.environment.temperature.status, "stale");
    assert.equal(world.environment.thermal_condition.status, "unknown");
    assert.equal(world.environment.thermal_condition.value, null);
});

test("audio classification drives quietness and speech activity in the world model", () => {
    const { architecture } = testArchitecture();
    architecture.observe({
        id: "audio_1",
        type: "audio.classification",
        source: "yamnet",
        confidence: 0.91,
        payload: { label: "speech", level: "medium" },
    });
    const { state, world } = architecture.snapshot();
    assert.equal(state.perception.last_sound.value.label, "speech");
    assert.equal(world.activity.someone_is_talking.value, true);
    assert.equal(world.environment.is_quiet.value, false);
});

test("behavior proposals are bounded by priority, expiry, and cooldown", () => {
    const { architecture, advance } = testArchitecture();
    architecture.observe({
        type: "touch.petting_started",
        source: "touch",
        payload: { body_part: "head" },
    });
    architecture.observe({
        type: "touch.petting_started",
        source: "touch",
        payload: { body_part: "head" },
    });

    const proposals = architecture.peekPendingProposals();
    assert.equal(proposals.filter((proposal) => proposal.kind === "social.respond_to_touch").length, 1);
    assert.equal(proposals[0].execution, "cognitive_review_required");

    advance(30_001);
    assert.equal(architecture.peekPendingProposals().length, 0);
});

test("behavior proposals are leased until delivery succeeds and can be restored after failure", () => {
    const { architecture } = testArchitecture();
    const { observation } = architecture.observe({
        id: "touch_for_lease",
        type: "touch.petting_started",
        source: "touch",
        payload: { body_part: "head" },
    });
    const context = architecture.composeContext(observation, {
        consumeProposals: false,
        leaseProposals: true,
    });
    assert.equal(context.behavior_proposals.length, 1);
    assert.equal(architecture.peekPendingProposals().length, 0);
    assert.equal(architecture.releaseProposalLease(context.turn_id), 1);
    assert.equal(architecture.peekPendingProposals().length, 1);

    const retry = architecture.composeContext(observation, {
        consumeProposals: false,
        leaseProposals: true,
    });
    assert.equal(retry.behavior_proposals.length, 1);
    assert.equal(architecture.acknowledgeProposalLease(retry.turn_id), true);
    assert.equal(architecture.peekPendingProposals().length, 0);
});

test("cognitive context keeps trigger, persona, state, world, memory, and proposals separate", () => {
    const { architecture } = testArchitecture();
    architecture.observe({
        id: "sensor_detail_that_must_stay_inside_kernel",
        type: "sensor.environment_sample",
        source: "bme280",
        payload: {
            temperature: 24.51695194063359,
            humidity: 67.25578837697772,
            pressure: 1016.9634879322562,
            units: { temperature: "celsius", humidity: "percent", pressure: "hpa" },
        },
    });
    architecture.observe({
        type: "sensor.brightness_sample",
        source: "cds",
        payload: { brightness: 439, unit: "raw" },
    });
    const { observation } = architecture.observe({
        type: "interaction.user_input",
        source: "user_input_api",
        payload: { text: "今日は寒いね" },
    });
    const context = architecture.composeContext(observation, {
        memories: [{ id: "memory_1", content: "ユーザーは冷え性だと話した" }],
    });

    assert.equal(context.type, "cognitive_context");
    assert.equal(context.protocol_version, "1.2");
    assert.equal(context.turn_id, context.trigger.id);
    assert.equal(context.trigger.payload.text, "今日は寒いね");
    assert.equal(context.persona.version, "test-version");
    assert.equal(context.memory[0].id, "memory_1");
    assert.equal(context.state.environment.temperature_c, 24.5);
    assert.equal(context.state.environment.humidity_percent, 67.3);
    assert.equal(context.world.thermal_condition, "comfortable");
    assert.equal(context.world.lighting_condition, "bright");
    assert.equal(context.state.perception.person_present, "unknown");
    assert.equal(context.drives.needs.social_contact, 0);
    assert.equal("behavior_proposals" in context, false);

    const json = JSON.stringify(context);
    assert.equal(json.includes("sensor_detail_that_must_stay_inside_kernel"), false);
    assert.equal(json.includes("observation_id"), false);
    assert.equal(json.includes("based_on"), false);
    assert.equal(json.includes("generated_at"), false);
    assert.ok(json.length < 1_200, `projected context was unexpectedly large: ${json.length}`);
});

test("body signals and action outcomes enter typed state without becoming free-form prompt text", () => {
    const { architecture } = testArchitecture();
    architecture.observe({
        id: "body_1",
        type: "internal.homeostasis_sample",
        source: "body_controller",
        payload: { signals: { energy_deficit: 0.82 } },
    });
    const { observation } = architecture.observe({
        id: "outcome_1",
        type: "action.outcome",
        source: "kernel_action_gate",
        payload: {
            intention_id: "intention_1",
            action_type: "led_change",
            expected_effect: "led_controller_accepts_color",
            status: "succeeded",
        },
    });

    const snapshot = architecture.snapshot();
    assert.equal(snapshot.state.action.last_outcome.value.status, "succeeded");
    assert.equal(snapshot.world.agency.last_action_status.value, "succeeded");
    assert.equal(snapshot.drives.external.energy_deficit.level, 0.82);

    const context = architecture.composeContext(observation, {
        actionGate: { recent_outcomes: [snapshot.state.action.last_outcome.value] },
    });
    assert.equal(context.drives.body_signals.energy_deficit.level, 0.82);
    assert.equal(context.trigger.payload.action_type, "led_change");
    assert.equal("last_action_outcome" in context, false);

    const next = architecture.observe({
        id: "user_after_outcome",
        type: "interaction.user_input",
        source: "user",
        payload: { text: "できた？" },
    }).observation;
    const nextContext = architecture.composeContext(next, {
        actionGate: { recent_outcomes: [snapshot.state.action.last_outcome.value] },
    });
    assert.equal(nextContext.last_action_outcome.action_type, "led_change");
    assert.equal("action_hash" in nextContext.last_action_outcome, false);
});

test("projection keeps memory evidence and behavior safety fields when they are present", () => {
    const { architecture } = testArchitecture();
    const { observation } = architecture.observe({
        id: "touch_observation",
        type: "touch.petting_started",
        source: "touch",
        payload: { body_part: "head" },
    });
    const context = architecture.composeContext(observation, {
        memories: [{
            id: "memory_1",
            kind: "preference",
            subject: "user",
            content: "ユーザーは静かな部屋を好む",
            confidence: 0.94,
            relevance: 0.812,
            evidence_event_ids: ["older_observation"],
        }],
    });

    assert.equal(context.memory[0].confidence, 0.94);
    assert.equal(context.memory[0].relevance, 0.81);
    assert.deepEqual(context.memory[0].evidence_event_ids, ["older_observation"]);
    assert.equal(context.behavior_proposals[0].kind, "social.respond_to_touch");
    assert.equal(context.behavior_proposals[0].priority, 85);
    assert.equal(context.behavior_proposals[0].reason, "petting_started");
    assert.equal("execution" in context.behavior_proposals[0], false);
    assert.equal("cooldown_key" in context.behavior_proposals[0], false);
});
