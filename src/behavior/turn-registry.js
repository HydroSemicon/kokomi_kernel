export class TurnRegistry {
    constructor({ clock = () => Date.now(), maxPending = 32, ttlMs = 5 * 60_000 } = {}) {
        this.clock = clock;
        this.maxPending = maxPending;
        this.ttlMs = ttlMs;
        this.pending = new Map();
    }

    register(context) {
        if (!context?.turn_id) throw new TypeError("cognitive context requires turn_id");
        this.#prune();
        this.pending.set(context.turn_id, { context, registered_at_ms: this.clock() });
        while (this.pending.size > this.maxPending) this.pending.delete(this.pending.keys().next().value);
        return context;
    }

    get(turnId) {
        this.#prune();
        return this.pending.get(turnId)?.context ?? null;
    }

    consume(turnId) {
        const context = this.get(turnId);
        if (context) this.pending.delete(turnId);
        return context;
    }

    remove(turnId) {
        return this.pending.delete(turnId);
    }

    snapshot() {
        this.#prune();
        return { count: this.pending.size, turn_ids: [...this.pending.keys()] };
    }

    #prune() {
        const nowMs = this.clock();
        for (const [turnId, entry] of this.pending) {
            if (nowMs - entry.registered_at_ms > this.ttlMs) this.pending.delete(turnId);
        }
    }
}
