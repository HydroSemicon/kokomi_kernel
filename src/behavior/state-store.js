function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function makeFact({ value, unit = null, observation, staleAfterMs }) {
    const observedMs = Date.parse(observation.observed_at);
    return {
        value,
        unit,
        observed_at: observation.observed_at,
        received_at: observation.received_at,
        source: observation.source,
        observation_id: observation.id,
        confidence: observation.confidence,
        stale_after: staleAfterMs === null ? null : new Date(observedMs + staleAfterMs).toISOString(),
    };
}

function publicFact(fact, nowMs) {
    if (!fact) return { value: null, status: "unknown" };
    return {
        value: fact.value,
        unit: fact.unit,
        status: fact.stale_after !== null && nowMs > Date.parse(fact.stale_after) ? "stale" : "known",
        observed_at: fact.observed_at,
        source: fact.source,
        confidence: fact.confidence,
        observation_id: fact.observation_id,
    };
}

export class StateStore {
    constructor({ clock = () => Date.now(), freshness = {} } = {}) {
        this.clock = clock;
        this.freshness = {
            environment_ms: freshness.environment_ms ?? 15_000,
            brightness_ms: freshness.brightness_ms ?? 15_000,
            sound_ms: freshness.sound_ms ?? 5_000,
            person_ms: freshness.person_ms ?? 10_000,
            touch_ms: freshness.touch_ms ?? 30_000,
        };
        this.revision = 0;
        this.lastObservation = null;
        this.environment = {};
        this.sound = null;
        this.personTracks = new Map();
        this.hasPersonEvidence = false;
        this.lastPersonSeenAt = null;
        this.activeTouches = new Map();
        this.hasTouchEvidence = false;
        this.lastTouch = null;
        this.lastUserInput = null;
    }

    apply(observation) {
        switch (observation.type) {
        case "sensor.environment_sample":
            this.#applyEnvironment(observation);
            break;
        case "sensor.brightness_sample":
            this.#applyBrightness(observation);
            break;
        case "audio.classification":
            this.#applySound(observation);
            break;
        case "vision.person_recognized":
        case "vision.person_unknown":
        case "vision.person_enrolled":
        case "vision.person_disappeared":
            this.#applyPerson(observation);
            break;
        case "touch.petting_started":
        case "touch.petting_ended":
            this.#applyTouch(observation);
            break;
        case "interaction.user_input":
            this.lastUserInput = makeFact({
                value: observation.payload.text,
                observation,
                staleAfterMs: null,
            });
            break;
        default:
            break;
        }

        this.revision += 1;
        this.lastObservation = observation;
        return this.snapshot();
    }

    #applyEnvironment(observation) {
        const units = observation.payload.units ?? {};
        for (const field of ["temperature", "humidity", "pressure"]) {
            const value = observation.payload[field];
            if (!finiteNumber(value)) continue;
            this.environment[field] = makeFact({
                value,
                unit: units[field] ?? null,
                observation,
                staleAfterMs: this.freshness.environment_ms,
            });
        }
    }

    #applyBrightness(observation) {
        if (!finiteNumber(observation.payload.brightness)) return;
        this.environment.brightness = makeFact({
            value: observation.payload.brightness,
            unit: observation.payload.unit ?? "raw",
            observation,
            staleAfterMs: this.freshness.brightness_ms,
        });
    }

    #applySound(observation) {
        if (typeof observation.payload.label !== "string") return;
        this.sound = makeFact({
            value: {
                label: observation.payload.label,
                level: observation.payload.level ?? null,
            },
            observation,
            staleAfterMs: this.freshness.sound_ms,
        });
    }

    #applyPerson(observation) {
        this.hasPersonEvidence = true;
        const trackId = String(observation.payload.track_id);
        if (observation.type === "vision.person_disappeared") {
            this.personTracks.delete(trackId);
            return;
        }

        const identity = observation.payload.identity ?? {};
        this.personTracks.set(trackId, {
            track_id: trackId,
            identity_status: identity.status ?? "unknown",
            person_id: identity.person_id ?? null,
            name: identity.name ?? null,
            position: observation.payload.position ?? null,
            observed_at: observation.observed_at,
            expires_at: new Date(Date.parse(observation.observed_at) + this.freshness.person_ms).toISOString(),
            confidence: observation.confidence,
            observation_id: observation.id,
        });
        this.lastPersonSeenAt = observation.observed_at;
    }

    #applyTouch(observation) {
        this.hasTouchEvidence = true;
        const bodyPart = observation.payload.body_part;
        if (observation.type === "touch.petting_started") {
            this.activeTouches.set(bodyPart, observation.observed_at);
        } else {
            this.activeTouches.delete(bodyPart);
        }
        this.lastTouch = makeFact({
            value: {
                action: observation.type.split(".")[1],
                body_part: bodyPart,
            },
            observation,
            staleAfterMs: this.freshness.touch_ms,
        });
    }

    snapshot() {
        const nowMs = this.clock();
        const visiblePeople = [...this.personTracks.values()]
            .filter((person) => nowMs <= Date.parse(person.expires_at))
            .map(({ expires_at, ...person }) => ({ ...person, status: "known" }));
        let personPresence;
        if (!this.hasPersonEvidence) {
            personPresence = { value: null, status: "unknown", last_seen_at: null };
        } else if (visiblePeople.length > 0) {
            personPresence = { value: true, status: "known", last_seen_at: this.lastPersonSeenAt };
        } else if (this.personTracks.size > 0) {
            personPresence = { value: null, status: "stale", last_seen_at: this.lastPersonSeenAt };
        } else {
            personPresence = { value: false, status: "known", last_seen_at: this.lastPersonSeenAt };
        }

        const freshTouchParts = [...this.activeTouches.entries()]
            .filter(([, startedAt]) => nowMs <= Date.parse(startedAt) + this.freshness.touch_ms)
            .map(([bodyPart]) => bodyPart);
        let pettingState;
        if (!this.hasTouchEvidence) pettingState = { value: null, body_parts: [], status: "unknown" };
        else if (freshTouchParts.length > 0) pettingState = { value: true, body_parts: freshTouchParts, status: "known" };
        else if (this.activeTouches.size > 0) pettingState = { value: null, body_parts: [], status: "stale" };
        else pettingState = { value: false, body_parts: [], status: "known" };

        return {
            schema_version: "1.0",
            revision: this.revision,
            generated_at: new Date(nowMs).toISOString(),
            environment: {
                temperature: publicFact(this.environment.temperature, nowMs),
                humidity: publicFact(this.environment.humidity, nowMs),
                pressure: publicFact(this.environment.pressure, nowMs),
                brightness: publicFact(this.environment.brightness, nowMs),
            },
            perception: {
                person_present: personPresence,
                visible_people: visiblePeople,
                last_sound: publicFact(this.sound, nowMs),
            },
            interaction: {
                being_petted: pettingState,
                last_touch: publicFact(this.lastTouch, nowMs),
                last_user_input: publicFact(this.lastUserInput, nowMs),
            },
            provenance: {
                last_observation_id: this.lastObservation?.id ?? null,
                last_observation_type: this.lastObservation?.type ?? null,
            },
        };
    }
}
