import { createHash, randomUUID } from "node:crypto";

function normalizedLength(text) {
    return [...String(text ?? "").normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "")].length;
}

function deterministicIndex(seed, key, length) {
    const digest = createHash("sha256").update(`${seed}:${key}`).digest();
    return digest.readUInt32BE(0) % length;
}

export class FillerController {
    constructor({
        config,
        manifest,
        player,
        outputLifecycle,
        echoGuard = null,
        onObservation = async () => {},
        clockMs = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    }) {
        this.config = config;
        this.manifest = manifest;
        this.player = player;
        this.outputLifecycle = outputLifecycle;
        this.echoGuard = echoGuard;
        this.onObservation = onObservation;
        this.clockMs = clockMs;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.pendingThinking = new Map();
        this.listeningSegments = new Map();
        this.readyTurns = new Set();
        this.current = null;
        this.lastStartedAtMs = -Infinity;
        this.lastListeningAtMs = -Infinity;
        this.lastOutcome = null;
        this.counts = { scheduled: 0, started: 0, completed: 0, cancelled: 0, failed: 0, suppressed: 0 };
    }

    scheduleThinking({ turnId, sessionId, segmentId, committedAt = new Date(this.clockMs()).toISOString() }) {
        const denial = this.#baseDenial("thinking");
        if (denial) return this.#suppress({ kind: "thinking", turnId, sessionId, segmentId }, denial);
        if (this.pendingThinking.has(turnId) || this.readyTurns.has(turnId)) {
            return this.#suppress({ kind: "thinking", turnId, sessionId, segmentId }, "already_used_for_turn");
        }
        const entry = { turnId, sessionId, segmentId, committedAt, timer: null };
        entry.timer = this.setTimer(() => {
            this.pendingThinking.delete(turnId);
            this.#play(entry, "thinking", { pauseCapture: true }).catch(() => {});
        }, this.config.thinking.delayMs);
        this.pendingThinking.set(turnId, entry);
        this.counts.scheduled += 1;
        this.#emit("speech.filler_scheduled", this.#payload(entry, {
            kind: "thinking",
            status: "scheduled",
            scheduled_at: this.#iso(),
            reason: "response_not_ready_after_delay",
        }));
        return { status: "scheduled", turn_id: turnId };
    }

    observePartial({ sessionId, segmentId, revision, text, observedAt = new Date(this.clockMs()).toISOString() }) {
        if (!this.config.enabled || !this.config.listening?.enabled) return;
        const key = `${sessionId}:${segmentId}`;
        let segment = this.listeningSegments.get(key);
        if (!segment) {
            segment = { sessionId, segmentId, firstAtMs: Date.parse(observedAt) || this.clockMs(), revision, text, used: false, timer: null };
            const remaining = Math.max(0, this.config.listening.minimumSpeechMs);
            segment.timer = this.setTimer(() => this.#considerListening(key), remaining);
            this.listeningSegments.set(key, segment);
            while (this.listeningSegments.size > 100) {
                const oldestKey = this.listeningSegments.keys().next().value;
                const oldest = this.listeningSegments.get(oldestKey);
                if (oldest?.timer) this.clearTimer(oldest.timer);
                this.listeningSegments.delete(oldestKey);
            }
        } else if (revision >= segment.revision) {
            segment.revision = revision;
            segment.text = text;
        }
    }

    commitSegment({ sessionId, segmentId }) {
        const key = `${sessionId}:${segmentId}`;
        const segment = this.listeningSegments.get(key);
        if (segment?.timer) this.clearTimer(segment.timer);
        this.listeningSegments.delete(key);
    }

    async markResponseReady(turnId) {
        this.readyTurns.add(turnId);
        while (this.readyTurns.size > 1000) this.readyTurns.delete(this.readyTurns.values().next().value);
        const pending = this.pendingThinking.get(turnId);
        if (pending) {
            this.clearTimer(pending.timer);
            this.pendingThinking.delete(turnId);
            await this.#cancelled(pending, "thinking", "main_response_ready");
        }
        if (this.current && (this.current.turnId === turnId || this.current.kind === "listening")) {
            this.current.cancelReason = "main_response_ready";
            this.player.stop(this.current.fillerId);
        }
    }

    async userSpeechStarted({ sessionId, segmentId }) {
        for (const [turnId, pending] of this.pendingThinking) {
            this.clearTimer(pending.timer);
            this.pendingThinking.delete(turnId);
            await this.#cancelled(pending, "thinking", "user_resumed_speaking");
        }
        if (this.current?.kind === "thinking") {
            this.current.cancelReason = "user_resumed_speaking";
            this.player.stop(this.current.fillerId);
        }
        if (sessionId && segmentId) this.observePartial({ sessionId, segmentId, revision: 0, text: "" });
    }

    snapshot() {
        return {
            enabled: Boolean(this.config.enabled),
            armed: Boolean(this.config.armed),
            manifest_set_id: this.manifest?.set_id ?? null,
            pending_turns: this.pendingThinking.size,
            current: this.current ? {
                filler_id: this.current.fillerId,
                clip_id: this.current.clip.id,
                kind: this.current.kind,
                turn_id: this.current.turnId ?? null,
            } : null,
            last_outcome: this.lastOutcome,
            counts: { ...this.counts },
        };
    }

    close() {
        for (const pending of this.pendingThinking.values()) this.clearTimer(pending.timer);
        for (const segment of this.listeningSegments.values()) if (segment.timer) this.clearTimer(segment.timer);
        this.pendingThinking.clear();
        this.listeningSegments.clear();
        if (this.current) this.player.stop(this.current.fillerId);
    }

    #baseDenial(kind) {
        if (!this.config.enabled) return "disabled";
        if (!this.config.armed) return "unarmed";
        if (!this.manifest) return "clip_unavailable";
        if (kind === "thinking" && !this.config.thinking?.enabled) return "disabled";
        if (kind === "listening" && !this.config.listening?.armed) return "listening_unarmed";
        if (!this.manifest.clips.some((clip) => clip.kind === kind)) return "clip_unavailable";
        return null;
    }

    #considerListening(key) {
        const segment = this.listeningSegments.get(key);
        if (!segment || segment.used) return;
        segment.timer = null;
        const meta = { sessionId: segment.sessionId, segmentId: segment.segmentId };
        const denial = this.#baseDenial("listening");
        if (denial) {
            segment.used = true;
            this.#suppress({ ...meta, kind: "listening" }, denial);
            return;
        }
        if (normalizedLength(segment.text) < this.config.listening.minimumPartialCharacters) {
            segment.used = true;
            this.#suppress({ ...meta, kind: "listening" }, "partial_too_short");
            return;
        }
        segment.used = true;
        this.#play(meta, "listening", { pauseCapture: false }).catch(() => {});
    }

    async #play(meta, kind, { pauseCapture }) {
        if (kind === "thinking" && this.readyTurns.has(meta.turnId)) return this.#suppress({ ...meta, kind }, "main_response_ready");
        const now = this.clockMs();
        if (now - this.lastStartedAtMs < this.config.globalCooldownMs) return this.#suppress({ ...meta, kind }, "cooldown_active");
        if (kind === "listening" && now - this.lastListeningAtMs < this.config.listening.cooldownMs) {
            return this.#suppress({ ...meta, kind }, "cooldown_active");
        }
        const candidates = this.manifest.clips.filter((clip) => clip.kind === kind);
        if (candidates.length === 0) return this.#suppress({ ...meta, kind }, "clip_unavailable");
        const selectionKey = meta.turnId ?? `${meta.sessionId}:${meta.segmentId}`;
        const clip = candidates[deterministicIndex(this.config.experimentSeed, selectionKey, candidates.length)];
        const fillerId = `filler_${randomUUID()}`;
        const output = { ...meta, kind, clip, fillerId, cancelReason: null, startedAt: null };
        const lifecycle = await this.outputLifecycle.begin({ kind: `${kind}_filler`, outputId: fillerId, pauseCapture });
        if (kind === "thinking" && this.readyTurns.has(meta.turnId)) {
            this.outputLifecycle.end(lifecycle);
            return this.#suppress({ ...meta, kind }, "main_response_ready");
        }
        this.current = output;
        try {
            const result = await this.player.play({
                outputId: fillerId,
                filePath: clip.absolutePath,
                onStarted: async () => {
                    output.startedAt = this.#iso();
                    this.lastStartedAtMs = this.clockMs();
                    if (kind === "listening") this.lastListeningAtMs = this.lastStartedAtMs;
                    this.echoGuard?.start({ turnId: fillerId, text: clip.text, startedAt: output.startedAt });
                    this.counts.started += 1;
                    await this.#emit("speech.filler_started", this.#payload(meta, {
                        filler_id: fillerId,
                        clip_id: clip.id,
                        kind,
                        status: "started",
                        started_at: output.startedAt,
                        reason: "policy_eligible",
                    }));
                },
            });
            const completedAt = this.#iso();
            if (output.startedAt) this.echoGuard?.finish({ turnId: fillerId, completedAt });
            if (result.status === "cancelled") {
                await this.#cancelled(meta, kind, output.cancelReason ?? "cancelled", { fillerId, clip, startedAt: output.startedAt, completedAt });
            } else {
                this.counts.completed += 1;
                const payload = this.#payload(meta, {
                    filler_id: fillerId,
                    clip_id: clip.id,
                    kind,
                    status: "completed",
                    started_at: output.startedAt,
                    completed_at: completedAt,
                    reason: "playback_finished",
                });
                this.lastOutcome = payload;
                await this.#emit("speech.filler_completed", payload);
            }
        } catch (error) {
            const completedAt = this.#iso();
            if (output.startedAt) this.echoGuard?.finish({ turnId: fillerId, completedAt });
            this.counts.failed += 1;
            const payload = this.#payload(meta, {
                filler_id: fillerId,
                clip_id: clip.id,
                kind,
                status: "failed",
                started_at: output.startedAt,
                completed_at: completedAt,
                reason: "player_failed",
                error: String(error?.message ?? "local filler playback failed").slice(0, 300),
            });
            this.lastOutcome = payload;
            await this.#emit("speech.filler_failed", payload);
        } finally {
            if (this.current === output) this.current = null;
            this.outputLifecycle.end(lifecycle);
        }
    }

    #suppress(meta, reason) {
        this.counts.suppressed += 1;
        const payload = this.#payload(meta, { status: "suppressed", reason, suppressed_at: this.#iso() });
        this.lastOutcome = payload;
        this.#emit("speech.filler_suppressed", payload);
        return { status: "suppressed", reason };
    }

    async #cancelled(meta, kind, reason, details = {}) {
        this.counts.cancelled += 1;
        const payload = this.#payload(meta, {
            filler_id: details.fillerId ?? null,
            clip_id: details.clip?.id ?? null,
            kind,
            status: "cancelled",
            started_at: details.startedAt ?? null,
            completed_at: details.completedAt ?? this.#iso(),
            reason,
        });
        this.lastOutcome = payload;
        await this.#emit("speech.filler_cancelled", payload);
    }

    #payload(meta, details) {
        return {
            filler_id: details.filler_id ?? null,
            clip_id: details.clip_id ?? null,
            kind: details.kind ?? meta.kind,
            turn_id: meta.turnId ?? null,
            session_id: meta.sessionId ?? null,
            segment_id: meta.segmentId ?? null,
            committed_at: meta.committedAt ?? null,
            policy_version: "1.0",
            manifest_set_id: this.manifest?.set_id ?? null,
            ...details,
        };
    }

    #emit(type, payload) {
        return Promise.resolve(this.onObservation({ type, source: "filler_controller", observed_at: this.#iso(), payload })).catch(() => {});
    }

    #iso() {
        return new Date(this.clockMs()).toISOString();
    }
}
