import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { LlmResponseProtocol } from "../src/protocol/llm-response.js";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const protocol = new LlmResponseProtocol(config);

test("LLM protocol requires a correlated turn and effective output", () => {
    assert.equal(protocol.audit({
        turn_id: "obs_1",
        result: "こんにちは。",
    }, { task: "live_control" }).ok, true);
    assert.match(protocol.audit({ result: "こんにちは。" }).reason, /turn_id/u);
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

test("public web search cannot be combined with control or other requests", () => {
    const options = { task: "live_control" };
    const lookup = { turn_id: "obs_1", requests: [{ type: "web_search", params: { query: "東京タワーの開業年" } }] };
    assert.equal(protocol.audit(lookup, options).ok, true);
    assert.match(protocol.audit({ ...lookup, actions: [{ type: "led_change", params: { color: "#FFFFFF" } }] }, options).reason, /only/u);
    assert.match(protocol.audit({ ...lookup, requests: [...lookup.requests, "temperature"] }, options).reason, /only/u);
});
