import fs from "fs/promises";
import path from "path";

const DEFAULT_CHECKPOINT_TYPES = new Set([
    "sensor.environment_sample",
    "sensor.brightness_sample",
    "audio.classification",
]);

export class EventStore {
    constructor({
        filePath,
        clock = () => Date.now(),
        maxReplayEvents = 20_000,
        sensorCheckpointMs = 60_000,
    } = {}) {
        this.filePath = filePath;
        this.clock = clock;
        this.maxReplayEvents = maxReplayEvents;
        this.sensorCheckpointMs = sensorCheckpointMs;
        this.writeQueue = Promise.resolve();
        this.lastPersistedAt = new Map();
        this.lastPayloadSignature = new Map();
        this.knownIds = new Set();
        this.diagnostics = { loaded: 0, malformed: 0, skippedCheckpoints: 0 };
    }

    async initialize() {
        if (!this.filePath) return [];
        let text;
        try {
            text = await fs.readFile(this.filePath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }

        const events = [];
        for (const line of text.split(/\r?\n/u)) {
            if (!line.trim()) continue;
            try {
                const record = JSON.parse(line);
                if (record?.record_type !== "observation" || !record.observation?.id) {
                    this.diagnostics.malformed += 1;
                    continue;
                }
                events.push(record.observation);
                this.knownIds.add(record.observation.id);
                const key = this.#checkpointKey(record.observation);
                this.lastPersistedAt.set(key, Date.parse(record.persisted_at) || this.clock());
                this.lastPayloadSignature.set(key, JSON.stringify(record.observation.payload));
            } catch {
                this.diagnostics.malformed += 1;
            }
        }

        const replay = events.slice(-this.maxReplayEvents);
        this.diagnostics.loaded = replay.length;
        return replay;
    }

    async append(observation, { force = false } = {}) {
        if (!this.filePath) return false;
        const nowMs = this.clock();
        const key = this.#checkpointKey(observation);
        const signature = JSON.stringify(observation.payload);
        if (!force && DEFAULT_CHECKPOINT_TYPES.has(observation.type)) {
            const previous = this.lastPersistedAt.get(key) ?? -Infinity;
            const audioChanged = observation.type === "audio.classification"
                && this.lastPayloadSignature.get(key) !== signature;
            if (!audioChanged && nowMs - previous < this.sensorCheckpointMs) {
                this.diagnostics.skippedCheckpoints += 1;
                return false;
            }
        }

        this.lastPersistedAt.set(key, nowMs);
        this.lastPayloadSignature.set(key, signature);
        this.knownIds.add(observation.id);
        const line = `${JSON.stringify({
            record_type: "observation",
            persisted_at: new Date(nowMs).toISOString(),
            observation,
        })}\n`;
        this.writeQueue = this.writeQueue.then(async () => {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.appendFile(this.filePath, line, "utf8");
        });
        await this.writeQueue;
        return true;
    }

    snapshot() {
        return { ...this.diagnostics };
    }

    has(id) {
        return this.knownIds.has(id);
    }

    #checkpointKey(observation) {
        return `${observation.type}:${observation.source ?? "unknown"}`;
    }
}
