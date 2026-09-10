export class ContextComposer {
    constructor({ persona = {}, protocolVersion = "1.0", clock = () => Date.now() } = {}) {
        this.persona = persona;
        this.protocolVersion = protocolVersion;
        this.clock = clock;
    }

    compose({ trigger, state, world, behaviorProposals = [], memories = [] }) {
        return {
            type: "cognitive_context",
            protocol_version: this.protocolVersion,
            generated_at: new Date(this.clock()).toISOString(),
            trigger: {
                observation_id: trigger.id,
                type: trigger.type,
                source: trigger.source,
                observed_at: trigger.observed_at,
                payload: trigger.payload,
            },
            persona: {
                id: this.persona.id ?? "kokomi-origin",
                version: this.persona.version ?? "unspecified",
                delivery: this.persona.delivery ?? "session_bootstrap",
            },
            state,
            world,
            memory: {
                authority: "kernel",
                relevant: memories,
            },
            behavior: {
                proposals: behaviorProposals,
                instruction: "Proposals are options, not commands. Choose safely or ignore them.",
            },
        };
    }
}
