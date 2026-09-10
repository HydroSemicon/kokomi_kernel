import assert from "node:assert/strict";
import test from "node:test";
import { TurnRegistry } from "../src/behavior/turn-registry.js";

test("turn registry correlates exactly once and expires stale model responses", () => {
    let nowMs = 0;
    const registry = new TurnRegistry({ clock: () => nowMs, maxPending: 2, ttlMs: 1000 });
    registry.register({ turn_id: "obs_1", state: {} });
    assert.equal(registry.get("obs_1").turn_id, "obs_1");
    assert.equal(registry.consume("obs_1").turn_id, "obs_1");
    assert.equal(registry.consume("obs_1"), null);

    registry.register({ turn_id: "obs_2" });
    nowMs = 1001;
    assert.equal(registry.get("obs_2"), null);
});

test("turn registry bounds pending contexts", () => {
    const registry = new TurnRegistry({ maxPending: 2 });
    registry.register({ turn_id: "obs_1" });
    registry.register({ turn_id: "obs_2" });
    registry.register({ turn_id: "obs_3" });
    assert.equal(registry.get("obs_1"), null);
    assert.deepEqual(registry.snapshot().turn_ids, ["obs_2", "obs_3"]);
});
