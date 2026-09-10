export class ContextComposer {
    constructor({ persona = {}, protocolVersion = "1.1" } = {}) {
        this.persona = persona;
        this.protocolVersion = protocolVersion;
    }

    compose({ trigger, state, world, behaviorProposals = [], memories = [] }) {
        const context = {
            type: "cognitive_context",
            protocol_version: this.protocolVersion,
            trigger: compactTrigger(trigger),
            persona: {
                id: this.persona.id ?? "kokomi-origin",
                version: compactVersion(this.persona.version ?? "unspecified"),
            },
            state: projectState(state),
            world: projectWorld(world),
        };

        if (memories.length > 0) context.memory = memories.map(compactMemory);
        if (behaviorProposals.length > 0) {
            context.behavior_proposals = behaviorProposals.map(compactProposal);
        }
        return context;
    }
}

function round(value, decimals = 1) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}

function compactVersion(version) {
    return version.length > 12 ? version.slice(0, 12) : version;
}

function compactPayload(value) {
    if (typeof value === "number") return round(value, 3);
    if (Array.isArray(value)) return value.map(compactPayload);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactPayload(item)]));
    }
    return value;
}

function compactTrigger(trigger) {
    const compact = {
        id: trigger.id,
        type: trigger.type,
        payload: compactPayload(trigger.payload),
    };
    if (trigger.type !== "interaction.user_input") compact.at = trigger.observed_at;
    return compact;
}

function projectFact(fact, decimals = 1) {
    if (fact?.status !== "known") return fact?.status ?? "unknown";
    return round(fact.value, decimals);
}

function projectState(state) {
    const perception = {
        person_present: projectFact(state.perception.person_present),
    };
    if (state.perception.last_sound.status !== "unknown") {
        perception.last_sound = state.perception.last_sound.status === "known"
            ? compactPayload(state.perception.last_sound.value)
            : state.perception.last_sound.status;
    }
    if (state.perception.visible_people.length > 0) {
        perception.visible_people = state.perception.visible_people.map((person) => ({
            track_id: person.track_id,
            identity: person.name ?? person.identity_status,
            ...(person.position ? { position: person.position } : {}),
        }));
    }

    const interaction = {
        being_petted: projectFact(state.interaction.being_petted),
    };
    if (state.interaction.being_petted.value === true) {
        interaction.touched_body_parts = state.interaction.being_petted.body_parts;
    }

    return {
        environment: {
            temperature_c: projectFact(state.environment.temperature),
            humidity_percent: projectFact(state.environment.humidity),
            pressure_hpa: projectFact(state.environment.pressure),
            brightness_raw: projectFact(state.environment.brightness),
        },
        perception,
        interaction,
    };
}

function projectWorld(world) {
    const projected = {
        room_occupied: projectFact(world.room.is_occupied),
        thermal_condition: projectFact(world.environment.thermal_condition),
        lighting_condition: projectFact(world.environment.lighting_condition),
    };
    if (world.environment.is_quiet.status === "known") {
        projected.environment_quiet = world.environment.is_quiet.value;
    }
    if (world.activity.someone_is_talking.status === "known") {
        projected.someone_talking = world.activity.someone_is_talking.value;
    }
    return projected;
}

function compactMemory(memory) {
    return {
        id: memory.id,
        kind: memory.kind,
        subject: memory.subject,
        content: memory.content,
        confidence: round(memory.confidence, 2),
        relevance: round(memory.relevance, 2),
        evidence_event_ids: memory.evidence_event_ids,
    };
}

function compactProposal(proposal) {
    return {
        id: proposal.id,
        kind: proposal.kind,
        priority: proposal.priority,
        reason: proposal.reason,
        context: compactPayload(proposal.context),
        expires_at: proposal.expires_at,
    };
}
