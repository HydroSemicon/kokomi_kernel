import { randomUUID } from "crypto";

export class SpontaneousBehaviorEngine {
    constructor({ clock = () => Date.now(), cooldowns = {}, proposalTtlMs = 30_000 } = {}) {
        this.clock = clock;
        this.proposalTtlMs = proposalTtlMs;
        this.cooldowns = {
            greet_person_ms: cooldowns.greet_person_ms ?? 120_000,
            respond_to_touch_ms: cooldowns.respond_to_touch_ms ?? 10_000,
            mention_temperature_ms: cooldowns.mention_temperature_ms ?? 900_000,
            mention_darkness_ms: cooldowns.mention_darkness_ms ?? 900_000,
        };
        this.lastEmittedAt = new Map();
    }

    evaluate({ observation, world }) {
        const candidates = [];
        const personPresent = world.room.is_occupied.value === true;

        if (["vision.person_recognized", "vision.person_enrolled", "vision.person_unknown"].includes(observation.type)) {
            candidates.push(this.#candidate({
                kind: "social.greet_arrival",
                priority: 80,
                cooldownKey: "greet_person",
                reason: "a_person_became_visible",
                context: { track_id: observation.payload.track_id, identity: observation.payload.identity },
            }));
        }

        if (observation.type === "touch.petting_started") {
            candidates.push(this.#candidate({
                kind: "social.respond_to_touch",
                priority: 85,
                cooldownKey: "respond_to_touch",
                reason: "petting_started",
                context: { body_part: observation.payload.body_part },
            }));
        }

        const thermal = world.environment.thermal_condition.value;
        if (personPresent && ["cold", "hot"].includes(thermal)) {
            candidates.push(this.#candidate({
                kind: "environment.mention_temperature",
                priority: thermal === "hot" ? 62 : 55,
                cooldownKey: "mention_temperature",
                reason: `room_is_${thermal}`,
                context: { thermal_condition: thermal },
            }));
        }

        if (personPresent && world.environment.lighting_condition.value === "dark") {
            candidates.push(this.#candidate({
                kind: "environment.consider_lighting",
                priority: 50,
                cooldownKey: "mention_darkness",
                reason: "room_is_dark",
                context: {},
            }));
        }

        return candidates.filter(Boolean);
    }

    #candidate({ kind, priority, cooldownKey, reason, context }) {
        const nowMs = this.clock();
        const cooldownMs = this.cooldowns[`${cooldownKey}_ms`];
        const lastAt = this.lastEmittedAt.get(cooldownKey) ?? -Infinity;
        if (nowMs - lastAt < cooldownMs) return null;
        this.lastEmittedAt.set(cooldownKey, nowMs);
        return {
            id: `proposal_${randomUUID()}`,
            kind,
            priority,
            created_at: new Date(nowMs).toISOString(),
            expires_at: new Date(nowMs + this.proposalTtlMs).toISOString(),
            cooldown_key: cooldownKey,
            reason,
            context,
            execution: "cognitive_review_required",
        };
    }
}
