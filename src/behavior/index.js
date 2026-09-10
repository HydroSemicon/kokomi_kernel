import { createObservation } from "./observation.js";
import { StateStore } from "./state-store.js";
import { WorldModel } from "./world-model.js";
import { SpontaneousBehaviorEngine } from "./spontaneous-behavior.js";
import { ContextComposer } from "./context-composer.js";
import { DriveSystem } from "./drive-system.js";

export class BehaviorArchitecture {
    constructor({ config = {}, clock = () => Date.now() } = {}) {
        this.clock = clock;
        const isoClock = () => new Date(clock()).toISOString();
        this.stateStore = new StateStore({ clock, freshness: config.freshness });
        this.worldModel = new WorldModel({ thresholds: config.thresholds });
        this.driveSystem = new DriveSystem({ clock, config: config.drives });
        this.behaviorEngine = new SpontaneousBehaviorEngine({
            clock,
            cooldowns: config.cooldowns,
            proposalTtlMs: config.proposal_ttl_ms,
        });
        this.contextComposer = new ContextComposer({ persona: config.persona, protocolVersion: "1.2" });
        this.isoClock = isoClock;
        this.pendingProposals = [];
        this.proposalLeases = new Map();
    }

    observe(input, { generateProposals = true } = {}) {
        const observation = createObservation(input, { now: this.isoClock });
        const state = this.stateStore.apply(observation);
        const world = this.worldModel.derive(state);
        this.driveSystem.observe({ observation, state, world });
        const drives = this.driveSystem.snapshot({ state, world });
        const proposals = generateProposals
            ? this.behaviorEngine.evaluate({ observation, state, world, drives })
            : [];
        this.pendingProposals.push(...proposals);
        this.#removeExpiredProposals();
        return { observation, state, world, drives, proposals };
    }

    snapshot() {
        const state = this.stateStore.snapshot();
        const world = this.worldModel.derive(state);
        return {
            state,
            world,
            drives: this.driveSystem.snapshot({ state, world }),
            pending_proposals: this.peekPendingProposals(),
        };
    }

    composeContext(trigger, {
        memories = [],
        social = {},
        actionGate = {},
        consumeProposals = true,
        leaseProposals = false,
        minimumProposalPriority = 0,
    } = {}) {
        const state = this.stateStore.snapshot();
        const world = this.worldModel.derive(state);
        const proposals = leaseProposals
            ? this.#leasePendingProposals(trigger.id, { minimumPriority: minimumProposalPriority })
            : consumeProposals
                ? this.takePendingProposals({ minimumPriority: minimumProposalPriority })
                : this.peekPendingProposals().filter((proposal) => proposal.priority >= minimumProposalPriority);
        return this.contextComposer.compose({
            trigger,
            state,
            world,
            behaviorProposals: proposals,
            memories,
            social,
            drives: this.driveSystem.snapshot({ state, world }),
            actionGate,
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

    acknowledgeProposalLease(turnId) {
        return this.proposalLeases.delete(turnId);
    }

    releaseProposalLease(turnId) {
        const proposals = this.proposalLeases.get(turnId) ?? [];
        this.proposalLeases.delete(turnId);
        const nowMs = this.clock();
        this.pendingProposals.push(...proposals.filter((proposal) => Date.parse(proposal.expires_at) >= nowMs));
        return proposals.length;
    }

    #leasePendingProposals(turnId, { minimumPriority = 0, limit = 10 } = {}) {
        const proposals = this.takePendingProposals({ minimumPriority, limit });
        if (proposals.length > 0) this.proposalLeases.set(turnId, proposals);
        return proposals;
    }

    #removeExpiredProposals() {
        const nowMs = this.clock();
        this.pendingProposals = this.pendingProposals.filter((proposal) => Date.parse(proposal.expires_at) >= nowMs);
    }
}

export { createObservation, StateStore, WorldModel, SpontaneousBehaviorEngine, ContextComposer, DriveSystem };
