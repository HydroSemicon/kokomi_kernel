function clamp(value) {
    return Math.max(0, Math.min(1, value));
}

function round(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Number(value.toFixed(2));
}

export class DriveSystem {
    constructor({ clock = () => Date.now(), config = {} } = {}) {
        this.clock = clock;
        this.socialNeedFullAfterMs = config.social_need_full_after_ms ?? 4 * 60 * 60 * 1000;
        this.externalSignalStaleMs = config.external_signal_stale_ms ?? 5 * 60 * 1000;
        this.lastMeaningfulInteractionAt = null;
        this.externalSignals = new Map();
    }

    observe({ observation }) {
        if ([
            "interaction.user_input",
            "touch.petting_started",
            "vision.person_recognized",
            "vision.person_enrolled",
        ].includes(observation.type)) {
            this.lastMeaningfulInteractionAt = observation.observed_at;
        }

        if (observation.type === "internal.homeostasis_sample") {
            for (const [name, value] of Object.entries(observation.payload.signals ?? {})) {
                if (typeof value !== "number" || !Number.isFinite(value)) continue;
                this.externalSignals.set(name, {
                    value: clamp(value),
                    observed_at: observation.observed_at,
                    source: observation.source,
                });
            }
        }
    }

    snapshot({ state, world }) {
        const nowMs = this.clock();
        const thermal = world.environment.thermal_condition;
        const thermalNeed = thermal.status !== "known" ? "unknown"
            : thermal.value === "hot" ? 0.9
                : thermal.value === "cold" ? 0.7
                    : thermal.value === "warm" ? 0.35
                        : 0;

        let socialNeed = 0.25;
        if (this.lastMeaningfulInteractionAt) {
            socialNeed = clamp((nowMs - Date.parse(this.lastMeaningfulInteractionAt)) / this.socialNeedFullAfterMs);
        }
        if (world.room.is_occupied.value === true) socialNeed *= 0.35;
        if (state.interaction.being_petted.value === true) socialNeed = 0;

        const sound = state.perception.last_sound;
        const soundLevel = sound.value?.level;
        const sensoryRestNeed = sound.status !== "known" ? "unknown"
            : ["high", "loud"].includes(soundLevel) ? 0.8
                : soundLevel === "medium" ? 0.35
                    : soundLevel === null ? "unknown"
                        : 0;

        const external = {};
        for (const [name, signal] of this.externalSignals) {
            const ageMs = nowMs - Date.parse(signal.observed_at);
            if (ageMs <= this.externalSignalStaleMs) {
                external[name] = {
                    level: round(signal.value),
                    source: signal.source,
                    observed_at: signal.observed_at,
                };
            }
        }

        const needs = {
            thermal_comfort: round(thermalNeed),
            social_contact: round(socialNeed),
            sensory_rest: round(sensoryRestNeed),
        };
        const dominant = [
            ...Object.entries(needs).map(([name, level]) => ({ name, level, source: "functional_inference" })),
            ...Object.entries(external).map(([name, signal]) => ({ name, level: signal.level, source: "body_signal" })),
        ]
            .filter((item) => typeof item.level === "number" && item.level >= 0.6)
            .sort((a, b) => b.level - a.level)
            .slice(0, 3);

        return {
            schema_version: "1.0",
            generated_at: new Date(nowMs).toISOString(),
            needs,
            external,
            dominant,
        };
    }
}
