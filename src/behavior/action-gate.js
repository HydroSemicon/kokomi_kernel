import { createHash, randomUUID } from "crypto";

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function actionHash(action) {
    return createHash("sha256").update(JSON.stringify(stable(action))).digest("hex");
}

function expectedEffect(type) {
    return {
        tear: "tear_actuator_accepts_command",
        led_change: "led_controller_accepts_color",
        bluesky_post: "public_post_is_created",
        remember_person: "face_enrollment_enters_collecting_state",
    }[type] ?? "command_is_accepted";
}

function explicitAuthorization(type, context) {
    const trigger = context?.trigger;
    if (trigger?.type !== "interaction.user_input") return false;
    const text = String(trigger.payload?.text ?? "");
    if (type === "bluesky_post") {
        const denied = /(?:投稿|ポスト|post|publish).{0,40}(?:しないで|しない|するな|やめて|不要|してほしくない|してはいけない|not|never)|(?:do not|don't|dont|never|stop|avoid).{0,40}(?:post|publish)/iu.test(text);
        if (denied) return false;
        return /(?:Bluesky|ブルースカイ)(?:に|へ)?.{0,30}(?:投稿|ポスト).{0,20}(?:して|しろ|お願い|頼む|送って)|(?:投稿|ポスト)(?:を)?(?:して|しろ|お願い|頼む|送って)|(?:post|publish).{0,40}(?:to|on)\s+bluesky/iu.test(text);
    }
    if (type === "remember_person") {
        const denied = /(?:覚え|記憶|登録).{0,30}(?:ないで|しない|するな|やめて|不要|ほしくない|いけない)|(?:do not|don't|dont|never|stop|avoid).{0,40}(?:remember|enroll|register)/iu.test(text);
        if (denied) return false;
        return /(?:覚えて|記憶して|登録して|名前は|と呼んで)/u.test(text);
    }
    return true;
}

export class ActionGate {
    constructor({ clock = () => Date.now(), config = {}, boundaryProvider = null } = {}) {
        this.clock = clock;
        this.enabled = config.enabled ?? true;
        this.maxActionsPerTurn = config.max_actions_per_turn ?? 1;
        this.duplicateWindowMs = config.duplicate_window_ms ?? 30_000;
        this.cooldowns = config.cooldowns ?? {};
        this.allowedSpontaneousActions = new Set(config.allowed_spontaneous_actions ?? []);
        this.boundaryProvider = boundaryProvider;
        this.turnCounts = new Map();
        this.recentHashes = new Map();
        this.lastActionAt = new Map();
        this.pending = new Map();
        this.recentOutcomes = [];
    }

    propose({ turnId, action, context }) {
        const nowMs = this.clock();
        const hash = actionHash(action);
        const denial = this.#denialReason({ turnId, action, context, hash, nowMs });
        if (denial) return { allowed: false, reason: denial, hash };

        const intention = {
            id: `intention_${randomUUID()}`,
            turn_id: turnId,
            action,
            action_hash: hash,
            expected_effect: expectedEffect(action.type),
            proposed_at: new Date(nowMs).toISOString(),
        };
        this.turnCounts.set(turnId, (this.turnCounts.get(turnId) ?? 0) + 1);
        this.recentHashes.set(hash, nowMs);
        this.lastActionAt.set(action.type, nowMs);
        this.pending.set(intention.id, intention);
        this.#prune(nowMs);
        return { allowed: true, intention };
    }

    evaluateSpeech(context) {
        if (this.boundaryProvider?.isActionDenied("say")) return { allowed: false, reason: "accepted_social_boundary_denies_speech" };
        if (context?.trigger?.type === "system.spontaneous_tick" && context.world?.room_occupied !== true) {
            return { allowed: false, reason: "spontaneous_speech_requires_confirmed_occupancy" };
        }
        return { allowed: true };
    }

    close(intention, { status, result = null, error = null }) {
        const now = new Date(this.clock()).toISOString();
        this.pending.delete(intention.id);
        const outcome = {
            intention_id: intention.id,
            turn_id: intention.turn_id,
            action_type: intention.action.type,
            action_hash: intention.action_hash,
            expected_effect: intention.expected_effect,
            status,
            prediction_match: status === "succeeded" ? true : status === "failed" ? false : null,
            result,
            error,
            completed_at: now,
        };
        this.recentOutcomes.unshift(outcome);
        if (this.recentOutcomes.length > 50) this.recentOutcomes.length = 50;
        return outcome;
    }

    restoreIntention(intention) {
        if (!intention?.id || !intention.action_hash || !intention.action?.type) return;
        const proposedMs = Date.parse(intention.proposed_at) || this.clock();
        this.pending.set(intention.id, intention);
        this.recentHashes.set(intention.action_hash, proposedMs);
        this.lastActionAt.set(intention.action.type, proposedMs);
    }

    restoreOutcome(outcome) {
        if (!outcome?.action_type || !outcome.completed_at) return;
        this.pending.delete(outcome.intention_id);
        const completedMs = Date.parse(outcome.completed_at) || this.clock();
        if (outcome.action_hash) this.recentHashes.set(outcome.action_hash, completedMs);
        this.lastActionAt.set(outcome.action_type, completedMs);
        this.recentOutcomes.unshift(outcome);
        if (this.recentOutcomes.length > 50) this.recentOutcomes.length = 50;
    }

    reconcileInterrupted() {
        return [...this.pending.values()].map((intention) => this.close(intention, {
            status: "unknown_after_restart",
            error: "kernel_restarted_before_outcome_was_recorded",
        }));
    }

    deniedOutcome({ turnId, action, reason, hash }) {
        const outcome = {
            intention_id: null,
            turn_id: turnId,
            action_type: action.type,
            action_hash: hash,
            expected_effect: expectedEffect(action.type),
            status: "denied",
            prediction_match: null,
            result: null,
            error: reason,
            completed_at: new Date(this.clock()).toISOString(),
        };
        this.recentOutcomes.unshift(outcome);
        if (this.recentOutcomes.length > 50) this.recentOutcomes.length = 50;
        return outcome;
    }

    snapshot() {
        return {
            enabled: this.enabled,
            pending_intentions: [...this.pending.values()],
            recent_outcomes: this.recentOutcomes.slice(0, 10),
        };
    }

    #denialReason({ turnId, action, context, hash, nowMs }) {
        if (!this.enabled) return null;
        if (!turnId || !context) return "missing_cognitive_turn_context";
        if ((this.turnCounts.get(turnId) ?? 0) >= this.maxActionsPerTurn) return "turn_action_bottleneck";

        const previousHashAt = this.recentHashes.get(hash);
        if (previousHashAt !== undefined && nowMs - previousHashAt < this.duplicateWindowMs) {
            return "duplicate_action_in_suppression_window";
        }

        const cooldownMs = this.cooldowns[`${action.type}_ms`] ?? 0;
        const lastAt = this.lastActionAt.get(action.type) ?? -Infinity;
        if (nowMs - lastAt < cooldownMs) return "action_cooldown_active";

        if (this.boundaryProvider?.isActionDenied(action.type)) return "accepted_social_boundary_denies_action";
        if (["bluesky_post", "remember_person"].includes(action.type) && !explicitAuthorization(action.type, context)) {
            return "explicit_current_turn_authorization_required";
        }
        if (action.type === "remember_person") {
            const visiblePeople = context.state?.perception?.visible_people ?? [];
            const matchingTrack = visiblePeople.some((person) => String(person.track_id) === String(action.params.track_id));
            if (!matchingTrack) return "face_enrollment_track_is_not_currently_visible";
            const userText = String(context.trigger?.payload?.text ?? "");
            if (!userText.includes(String(action.params.name))) return "face_enrollment_name_not_grounded_in_current_turn";
        }
        if (context.trigger?.type === "system.spontaneous_tick" && !this.allowedSpontaneousActions.has(action.type)) {
            return "action_not_armed_for_spontaneous_turns";
        }
        return null;
    }

    #prune(nowMs) {
        for (const [hash, at] of this.recentHashes) {
            if (nowMs - at > this.duplicateWindowMs) this.recentHashes.delete(hash);
        }
        if (this.turnCounts.size > 100) {
            const oldest = this.turnCounts.keys().next().value;
            this.turnCounts.delete(oldest);
        }
    }
}

export { actionHash };
