function unknownFact(reason) {
    return { value: null, status: "unknown", reason };
}

function derivedFact(value, basedOn, confidence = 1) {
    return { value, status: "known", confidence, based_on: basedOn };
}

function known(fact) {
    return fact?.status === "known";
}

export class WorldModel {
    constructor({ thresholds = {} } = {}) {
        this.thresholds = {
            cold_celsius: thresholds.cold_celsius ?? 18,
            warm_celsius: thresholds.warm_celsius ?? 27,
            hot_celsius: thresholds.hot_celsius ?? 31,
            dark_brightness: thresholds.dark_brightness ?? 40,
            bright_brightness: thresholds.bright_brightness ?? 75,
        };
    }

    derive(state) {
        const occupied = state.perception.person_present.status === "known"
            ? derivedFact(state.perception.person_present.value, ["perception.person_present"])
            : unknownFact("no_fresh_person_evidence");

        const sound = state.perception.last_sound;
        const someoneTalking = known(sound)
            ? derivedFact(sound.value.label === "speech", ["perception.last_sound"], sound.confidence)
            : unknownFact("no_fresh_sound_classification");
        const environmentQuiet = known(sound) && typeof sound.value.level === "string"
            ? derivedFact(["quiet", "low"].includes(sound.value.level), ["perception.last_sound"], sound.confidence)
            : unknownFact("sound_level_unavailable");

        return {
            schema_version: "1.0",
            derived_from_state_revision: state.revision,
            generated_at: state.generated_at,
            room: {
                is_occupied: occupied,
                visible_people: state.perception.visible_people.map((person) => ({
                    track_id: person.track_id,
                    name: person.name,
                    identity_status: person.identity_status,
                    position: person.position,
                })),
            },
            environment: {
                thermal_condition: this.#thermalCondition(state.environment.temperature),
                lighting_condition: this.#lightingCondition(state.environment.brightness),
                is_quiet: environmentQuiet,
            },
            activity: {
                someone_is_talking: someoneTalking,
                character_is_being_petted: state.interaction.being_petted.status === "known"
                    ? derivedFact(state.interaction.being_petted.value, ["interaction.being_petted"])
                    : unknownFact("no_fresh_touch_evidence"),
            },
        };
    }

    #thermalCondition(temperature) {
        if (!known(temperature)) return unknownFact("temperature_unavailable_or_stale");
        let value = "comfortable";
        if (temperature.value < this.thresholds.cold_celsius) value = "cold";
        else if (temperature.value >= this.thresholds.hot_celsius) value = "hot";
        else if (temperature.value >= this.thresholds.warm_celsius) value = "warm";
        return derivedFact(value, ["environment.temperature"], temperature.confidence);
    }

    #lightingCondition(brightness) {
        if (!known(brightness)) return unknownFact("brightness_unavailable_or_stale");
        let value = "normal";
        if (brightness.value < this.thresholds.dark_brightness) value = "dark";
        else if (brightness.value >= this.thresholds.bright_brightness) value = "bright";
        return derivedFact(value, ["environment.brightness"], brightness.confidence);
    }
}
