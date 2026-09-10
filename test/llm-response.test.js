import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { LlmResponseProtocol } from "../src/protocol/llm-response.js";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const protocol = new LlmResponseProtocol(config);

test("LLM protocol requires a correlated turn and effective output", () => {
    assert.equal(protocol.audit({
        turn_id: "obs_1",
        speech: "こんにちは。",
        emotion: "calm",
        intensity: 0.3,
    }).ok, true);
    assert.match(protocol.audit({ speech: "こんにちは。", emotion: "calm", intensity: 0.3 }).reason, /turn_id/u);
    assert.match(protocol.audit({ turn_id: "obs_1", actions: [] }).reason, /effective/u);
});

test("LLM protocol accepts bounded on-demand Kernel queries", () => {
    assert.equal(protocol.audit({
        turn_id: "obs_1",
        requests: [{ type: "kernel_query", params: { resource: "state" } }],
    }).ok, true);
    assert.match(protocol.audit({
        turn_id: "obs_1",
        requests: [{ type: "kernel_query", params: { resource: "memory" } }],
    }).reason, /requires/u);
    assert.match(protocol.audit({
        turn_id: "obs_1",
        requests: [{ type: "kernel_query", params: { resource: "secrets" } }],
    }).reason, /resource/u);
});

test("LLM protocol enforces the one-action bottleneck before execution", () => {
    const action = { type: "led_change", params: { color: "#FFFFFF" } };
    const result = protocol.audit({ turn_id: "obs_1", actions: [action, action] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /at most 1/u);
});
