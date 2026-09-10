import { createObservation } from "./observation.js";
import { StateStore } from "./state-store.js";
import { WorldModel } from "./world-model.js";
import { SpontaneousBehaviorEngine } from "./spontaneous-behavior.js";
import { ContextComposer } from "./context-composer.js";

export class BehaviorArchitecture {
    constructor({ config = {}, clock = () => Date.now() } = {}) {
        this.clock = clock;
        const isoClock = () => new Date(clock()).toISOString();
        this.stateStore = new StateStore({ clock, freshness: config.freshness });
        this.worldModel = new WorldModel({ thresholds: config.thresholds });
        this.behaviorEngine = new SpontaneousBehaviorEngine({
            clock,
            cooldowns: config.cooldowns,
            proposalTtlMs: config.proposal_ttl_ms,
        });
        this.contextComposer = new ContextComposer({ persona: config.persona });
        this.isoClock = isoClock;
        this.pendingProposals = [];
    }

    observe(input) {
        const observation = createObservation(input, { now: this.isoClock });
        const state = this.stateStore.apply(observation);
        const world = this.worldModel.derive(state);
        const proposals = this.behaviorEngine.evaluate({ observation, state, world });
        this.pendingProposals.push(...proposals);
        this.#removeExpiredProposals();
        return { observation, state, world, proposals };
    }

    snapshot() {
        const state = this.stateStore.snapshot();
        return {
            state,
            world: this.worldModel.derive(state),
            pending_proposals: this.peekPendingProposals(),
        };
    }

    composeContext(trigger, { memories = [], consumeProposals = true } = {}) {
        const state = this.stateStore.snapshot();
        const world = this.worldModel.derive(state);
        const proposals = consumeProposals ? this.takePendingProposals() : this.peekPendingProposals();
        return this.contextComposer.compose({
            trigger,
            state,
            world,
            behaviorProposals: proposals,
            memories,
        });
    }

    peekPendingProposals() {
        this.#removeExpiredProposals();
        return this.pendingProposals.map((proposal) => ({ ...proposal }));
    }

    takePendingProposals({ minimumPriority = 0, limit = 10 } = {}) {
        this.#removeExpiredProposals();
        const selected = this.pendingProposals
            .filter((proposal) => proposal.priority >= minimumPriority)
            .sort((a, b) => b.priority - a.priority)
            .slice(0, limit);
        const selectedIds = new Set(selected.map((proposal) => proposal.id));
        this.pendingProposals = this.pendingProposals.filter((proposal) => !selectedIds.has(proposal.id));
        return selected;
    }

    #removeExpiredProposals() {
        const nowMs = this.clock();
        this.pendingProposals = this.pendingProposals.filter((proposal) => Date.parse(proposal.expires_at) >= nowMs);
    }
}

export { createObservation, StateStore, WorldModel, SpontaneousBehaviorEngine, ContextComposer };
