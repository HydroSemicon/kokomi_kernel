import assert from "node:assert/strict";
import test from "node:test";
import { ActionGate } from "../src/behavior/action-gate.js";

function userContext(text, turnId = "obs_turn") {
    return {
        turn_id: turnId,
        trigger: { type: "interaction.user_input", payload: { text } },
    };
}

test("action gate binds an action to one turn and records a closed outcome", () => {
    let nowMs = Date.parse("2026-09-10T00:00:00.000Z");
    const gate = new ActionGate({
        clock: () => nowMs,
        config: { max_actions_per_turn: 1, duplicate_window_ms: 30_000 },
    });
    const context = userContext("LEDを青にして");
    const action = { type: "led_change", params: { color: "#0000FF" } };
    const first = gate.propose({ turnId: context.turn_id, context, action });
    assert.equal(first.allowed, true);

    const second = gate.propose({ turnId: context.turn_id, context, action: { type: "tear", params: { speed: 1, duration: 1 } } });
    assert.equal(second.allowed, false);
    assert.equal(second.reason, "turn_action_bottleneck");

    nowMs += 100;
    const outcome = gate.close(first.intention, { status: "succeeded", result: { accepted: true } });
    assert.equal(outcome.turn_id, context.turn_id);
    assert.equal(outcome.expected_effect, "led_controller_accepts_color");
    assert.equal(gate.snapshot().pending_intentions.length, 0);
});

test("public actions need current-turn authorization and accepted boundaries take precedence", () => {
    const deniedBoundary = { isActionDenied: (type) => type === "bluesky_post" };
    const gate = new ActionGate({ boundaryProvider: deniedBoundary });
    const action = { type: "bluesky_post", params: { text: "hello" } };

    const noPermission = gate.propose({
        turnId: "obs_1",
        context: userContext("今日もいい天気だね", "obs_1"),
        action,
    });
    assert.equal(noPermission.reason, "accepted_social_boundary_denies_action");

    const allowedGate = new ActionGate();
    const explicit = allowedGate.propose({
        turnId: "obs_2",
        context: userContext("Blueskyに投稿して", "obs_2"),
        action,
    });
    assert.equal(explicit.allowed, true);
});

test("negative wording never authorizes public posting or face enrollment", () => {
    const postingGate = new ActionGate();
    const posting = postingGate.propose({
        turnId: "obs_no_post",
        context: userContext("Blueskyには投稿してほしくない", "obs_no_post"),
        action: { type: "bluesky_post", params: { text: "hello" } },
    });
    assert.equal(posting.allowed, false);
    assert.equal(posting.reason, "explicit_current_turn_authorization_required");

    const faceGate = new ActionGate();
    const face = faceGate.propose({
        turnId: "obs_no_face",
        context: {
            ...userContext("顔を登録してほしくない", "obs_no_face"),
            state: { perception: { visible_people: [{ track_id: "7" }] } },
        },
        action: { type: "remember_person", params: { track_id: "7", name: "たかん" } },
    });
    assert.equal(face.allowed, false);
    assert.equal(face.reason, "explicit_current_turn_authorization_required");
});

test("spontaneous turns cannot cause unarmed external actions", () => {
    const gate = new ActionGate({ config: { allowed_spontaneous_actions: [] } });
    const result = gate.propose({
        turnId: "obs_tick",
        context: { turn_id: "obs_tick", trigger: { type: "system.spontaneous_tick", payload: {} } },
        action: { type: "led_change", params: { color: "#FFFFFF" } },
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "action_not_armed_for_spontaneous_turns");
});

test("restored intentions and outcomes preserve restart-time action diagnostics", () => {
    const gate = new ActionGate();
    const intention = {
        id: "intention_1",
        turn_id: "obs_1",
        action: { type: "led_change", params: { color: "#FFFFFF" } },
        action_hash: "abc",
        expected_effect: "led_controller_accepts_color",
        proposed_at: "2026-09-10T00:00:00.000Z",
    };
    gate.restoreIntention(intention);
    assert.equal(gate.snapshot().pending_intentions.length, 1);
    gate.restoreOutcome({
        intention_id: intention.id,
        action_type: "led_change",
        action_hash: "abc",
        status: "succeeded",
        completed_at: "2026-09-10T00:00:01.000Z",
    });
    assert.equal(gate.snapshot().pending_intentions.length, 0);
    assert.equal(gate.snapshot().recent_outcomes[0].status, "succeeded");
});

test("an orphaned intention becomes an unknown outcome after restart", () => {
    const gate = new ActionGate({ clock: () => Date.parse("2026-09-10T00:01:00.000Z") });
    gate.restoreIntention({
        id: "intention_orphan",
        turn_id: "obs_1",
        action: { type: "tear", params: { speed: 1, duration: 1 } },
        action_hash: "orphan-hash",
        expected_effect: "tear_actuator_accepts_command",
        proposed_at: "2026-09-10T00:00:00.000Z",
    });
    const [outcome] = gate.reconcileInterrupted();
    assert.equal(outcome.status, "unknown_after_restart");
    assert.equal(outcome.prediction_match, null);
    assert.equal(gate.snapshot().pending_intentions.length, 0);
});

test("spontaneous speech needs confirmed occupancy", () => {
    const gate = new ActionGate();
    const denied = gate.evaluateSpeech({
        trigger: { type: "system.spontaneous_tick" },
        world: { room_occupied: "unknown" },
    });
    assert.equal(denied.allowed, false);
    assert.equal(gate.evaluateSpeech({
        trigger: { type: "system.spontaneous_tick" },
        world: { room_occupied: true },
    }).allowed, true);
});
