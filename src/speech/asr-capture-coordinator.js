import { randomUUID } from "node:crypto";

function controlEvent(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class AsrCaptureCoordinator {
    constructor({
        ackTimeoutMs = 600,
        resumeGuardMs = 400,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        clock = () => new Date().toISOString(),
    } = {}) {
        this.ackTimeoutMs = ackTimeoutMs;
        this.resumeGuardMs = resumeGuardMs;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.clock = clock;
        this.clients = new Map();
        this.pendingAcks = new Map();
        this.resumeTimer = null;
        this.revision = 0;
        this.paused = false;
        this.reason = null;
        this.outputId = null;
        this.pausedAtMs = null;
    }

    connect(write) {
        const clientId = `asr_client_${randomUUID()}`;
        this.clients.set(clientId, write);
        write(controlEvent("hello", { client_id: clientId }));
        write(controlEvent("capture", this.#command()));
        return clientId;
    }

    disconnect(clientId) {
        this.clients.delete(clientId);
        for (const pending of this.pendingAcks.values()) {
            pending.waiting.delete(clientId);
            if (pending.waiting.size === 0) pending.finish(false);
        }
    }

    async pause({ reason = "audio_output", outputId = null } = {}) {
        if (this.resumeTimer) {
            this.clearTimer(this.resumeTimer);
            this.resumeTimer = null;
        }
        if (this.paused) {
            this.reason = reason;
            this.outputId = outputId;
            return { revision: this.revision, clients: this.clients.size, acknowledged: this.clients.size, timed_out: false };
        }

        this.paused = true;
        this.pausedAtMs = Date.parse(this.clock());
        this.reason = reason;
        this.outputId = outputId;
        this.revision += 1;
        const command = this.#command();
        const waiting = new Set(this.clients.keys());
        this.#broadcast("capture", command);
        if (waiting.size === 0) {
            return { revision: this.revision, clients: 0, acknowledged: 0, timed_out: false };
        }

        return new Promise((resolve) => {
            const pending = {
                waiting,
                initialCount: waiting.size,
                timer: null,
                finished: false,
                finish: (timedOut) => {
                    if (pending.finished) return;
                    pending.finished = true;
                    if (pending.timer) this.clearTimer(pending.timer);
                    this.pendingAcks.delete(command.revision);
                    resolve({
                        revision: command.revision,
                        clients: pending.initialCount,
                        acknowledged: pending.initialCount - pending.waiting.size,
                        timed_out: timedOut,
                    });
                },
            };
            pending.timer = this.setTimer(() => pending.finish(true), this.ackTimeoutMs);
            this.pendingAcks.set(command.revision, pending);
        });
    }

    acknowledge({ clientId, revision, paused }) {
        if (!this.clients.has(clientId)) return false;
        if (revision !== this.revision || paused !== this.paused) return false;
        const pending = this.pendingAcks.get(revision);
        if (pending) {
            pending.waiting.delete(clientId);
            if (pending.waiting.size === 0) pending.finish(false);
        }
        return true;
    }

    scheduleResume({ reason = "audio_output_finished" } = {}) {
        if (this.resumeTimer) this.clearTimer(this.resumeTimer);
        this.resumeTimer = this.setTimer(() => {
            this.resumeTimer = null;
            this.resumeNow({ reason });
        }, this.resumeGuardMs);
    }

    resumeNow({ reason = "audio_output_finished" } = {}) {
        if (this.resumeTimer) {
            this.clearTimer(this.resumeTimer);
            this.resumeTimer = null;
        }
        if (!this.paused) return this.#command();
        this.paused = false;
        this.pausedAtMs = null;
        this.reason = reason;
        this.outputId = null;
        this.revision += 1;
        const command = this.#command();
        this.#broadcast("capture", command);
        return command;
    }

    snapshot() {
        return {
            ...this.#command(),
            connected_clients: this.clients.size,
            resume_pending: this.resumeTimer !== null,
        };
    }

    shouldSuppress(observedAt) {
        if (!this.paused) return false;
        const observedAtMs = Date.parse(observedAt);
        if (!Number.isFinite(observedAtMs) || !Number.isFinite(this.pausedAtMs)) return true;
        return observedAtMs >= this.pausedAtMs;
    }

    close() {
        if (this.resumeTimer) this.clearTimer(this.resumeTimer);
        this.resumeTimer = null;
        for (const pending of this.pendingAcks.values()) pending.finish(true);
        this.clients.clear();
    }

    #command() {
        return {
            revision: this.revision,
            paused: this.paused,
            reason: this.reason,
            output_id: this.outputId,
            issued_at: this.clock(),
        };
    }

    #broadcast(event, payload) {
        for (const [clientId, write] of this.clients) {
            try {
                write(controlEvent(event, payload));
            } catch {
                this.disconnect(clientId);
            }
        }
    }
}
