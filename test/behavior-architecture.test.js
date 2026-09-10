import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorArchitecture } from "../src/behavior/index.js";

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
    assert.equal(context.protocol_version, "1.1");
    assert.equal(context.trigger.payload.text, "今日は寒いね");
    assert.equal(context.persona.version, "test-version");
    assert.equal(context.memory[0].id, "memory_1");
    assert.equal(context.state.environment.temperature_c, 24.5);
    assert.equal(context.state.environment.humidity_percent, 67.3);
    assert.equal(context.world.thermal_condition, "comfortable");
    assert.equal(context.world.lighting_condition, "bright");
    assert.equal(context.state.perception.person_present, "unknown");
    assert.equal("behavior_proposals" in context, false);

    const json = JSON.stringify(context);
    assert.equal(json.includes("sensor_detail_that_must_stay_inside_kernel"), false);
    assert.equal(json.includes("observation_id"), false);
    assert.equal(json.includes("based_on"), false);
    assert.equal(json.includes("generated_at"), false);
    assert.ok(json.length < 1_200, `projected context was unexpectedly large: ${json.length}`);
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
