import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const timestamp = (value) => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));

export function normalizeCoughEvent(event) {
    if (!object(event) || event.schema_version !== "1.0" || event.label !== "cough" || event.source !== "microphone") {
        throw new TypeError("Expected a schema 1.0 microphone cough event");
    }
    if (typeof event.event_id !== "string" || !/^evt_[A-Za-z0-9_.:-]{1,124}$/u.test(event.event_id)) {
        throw new TypeError("event_id must be a safe evt_ identifier of at most 128 characters");
    }
    if (!probability(event.confidence)) throw new TypeError("confidence must be between 0 and 1");
    if (!timestamp(event.started_at) || !timestamp(event.ended_at)
        || Date.parse(event.ended_at) < Date.parse(event.started_at)
        || !Number.isSafeInteger(event.duration_ms) || event.duration_ms < 0
        || Math.abs(Date.parse(event.ended_at) - Date.parse(event.started_at) - event.duration_ms) > 2) {
        throw new TypeError("Invalid cough timestamps or duration_ms");
    }
    if (!object(event.model) || !["beats_transfer", "beats_cough_transfer"].includes(event.model.architecture)
        || ![event.model.checkpoint, event.model.classifier_version].every((value) =>
            typeof value === "string" && value.length > 0 && value.length <= 1024)) {
        throw new TypeError("model must identify a BEATs transfer classifier, checkpoint and classifier_version");
    }
    if (!object(event.decision) || !probability(event.decision.start_threshold)
        || !probability(event.decision.peak_score) || !Number.isSafeInteger(event.decision.frames_above_threshold)
        || event.decision.frames_above_threshold < 1) throw new TypeError("Invalid finalized cough decision");
    return {
        id: `beats_cough_${createHash("sha256").update(event.event_id).digest("hex")}`,
        type: "audio.cough_detected",
        source: "beats_microphone",
        observed_at: event.ended_at,
        confidence: event.confidence,
        payload: {
            event_id: event.event_id, label: "cough", started_at: event.started_at,
            ended_at: event.ended_at, duration_ms: event.duration_ms,
            // Room audio cannot identify the person who coughed.
            subject: "unidentified_nearby_person",
            model: { architecture: event.model.architecture, checkpoint: event.model.checkpoint,
                classifier_version: event.model.classifier_version },
            decision: { start_threshold: event.decision.start_threshold, peak_score: event.decision.peak_score,
                frames_above_threshold: event.decision.frames_above_threshold },
        },
    };
}

export class CoughDetectionService {
    constructor({ config = {}, storagePath, clock = () => Date.now(), observe, hasObservation = () => false,
        onChange = () => {} }) {
        this.config = { enabled: false, reactionCooldownMs: 60_000, maxEventAgeMs: 30_000, ...config };
        this.enabled = this.config.enabled === true;
        Object.assign(this, { storagePath, clock, observe, hasObservation, onChange });
        this.queue = Promise.resolve();
        this.generation = 0;
        this.lastReactionAt = null;
        this.lastDetectedAt = null;
        this.acceptedCount = 0;
        this.seen = new Set();
        this.bridge = null;
    }

    async initialize() {
        if (!this.storagePath) return;
        try {
            const saved = JSON.parse(await fs.readFile(this.storagePath, "utf8"));
            if (typeof saved.enabled !== "boolean") throw new Error("Invalid cough settings");
            this.enabled = saved.enabled;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }

    snapshot() {
        const bridge = !this.bridge || this.clock() - Date.parse(this.bridge.lastSeenAt) > 10_000
            ? { status: "disconnected", lastSeenAt: this.bridge?.lastSeenAt ?? null }
            : { ...this.bridge };
        return { enabled: this.enabled, lastDetectedAt: this.lastDetectedAt, acceptedCount: this.acceptedCount,
            reactionCooldownMs: this.config.reactionCooldownMs, managedProcess: this.config.managedProcess !== false, bridge };
    }

    heartbeat(input) {
        if (!object(input) || !["running", "stopped", "error"].includes(input.status)
            || (input.error != null && (typeof input.error !== "string" || input.error.length > 500))) {
            throw new TypeError("Invalid BEATs bridge heartbeat");
        }
        this.bridge = { status: input.status, error: input.error ?? null, lastSeenAt: new Date(this.clock()).toISOString() };
        this.onChange(this.snapshot());
        return this.snapshot();
    }

    serialize(run) {
        const job = this.queue.then(run);
        this.queue = job.catch(() => {});
        return job;
    }

    setEnabled(enabled) {
        if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
        return this.serialize(async () => {
            if (this.storagePath) {
                await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
                const temporary = `${this.storagePath}.tmp`;
                await fs.writeFile(temporary, `${JSON.stringify({ enabled })}\n`, "utf8");
                await fs.rename(temporary, this.storagePath);
            }
            if (this.enabled !== enabled) this.generation++;
            this.enabled = enabled;
            this.onChange(this.snapshot());
            return this.snapshot();
        });
    }

    receive(event) {
        const input = normalizeCoughEvent(event);
        return this.serialize(async () => {
            if (!this.enabled) return { status: "disabled_ignored", forwarded_to_llm: false };
            if (this.seen.has(input.id) || this.hasObservation(input.id)) {
                return { status: "duplicate_ignored", forwarded_to_llm: false };
            }
            const age = this.clock() - Date.parse(input.observed_at);
            if (age > this.config.maxEventAgeMs || age < -5000) {
                return { status: "stale_ignored", forwarded_to_llm: false };
            }
            const forward = this.lastReactionAt === null
                || this.clock() - this.lastReactionAt >= this.config.reactionCooldownMs;
            const generation = this.generation;
            const valid = () => this.enabled && this.generation === generation
                && this.clock() - Date.parse(input.observed_at) <= this.config.maxEventAgeMs;
            await this.observe(input, { forward, valid });
            this.seen.add(input.id);
            if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
            if (forward) this.lastReactionAt = this.clock();
            this.lastDetectedAt = input.observed_at;
            this.acceptedCount++;
            this.onChange(this.snapshot());
            return { status: forward ? "accepted" : "cooldown_recorded", forwarded_to_llm: forward };
        });
    }
}

export function mountCoughRoutes(app, { service, routes, ready = Promise.resolve() }) {
    const handle = (run) => async (req, res) => {
        res.set("Cache-Control", "no-store");
        try { await ready; await run(req, res); }
        catch (error) {
            res.status(error instanceof TypeError ? 400 : 503).json({ error: error.message });
        }
    };
    app.get(routes.coughDetection, handle(async (_req, res) => res.json(service.snapshot())));
    app.post(routes.coughDetection, handle(async (req, res) => res.json(await service.setEnabled(req.body?.enabled))));
    app.post(routes.beatsCough, handle(async (req, res) => res.json(await service.receive(req.body))));
    app.post(routes.beatsHeartbeat, handle(async (req, res) => res.json(service.heartbeat(req.body))));
}
