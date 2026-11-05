import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export class ConversationStore {
    constructor({ filePath, checkpointPath, clock = () => Date.now() }) {
        Object.assign(this, { filePath, checkpointPath, clock });
        this.entries = [];
        this.ids = new Set();
        this.checkpoint = { through: 0, summary: "" };
        this.queue = Promise.resolve();
    }

    async initialize() {
        try {
            const saved = JSON.parse(await fs.readFile(this.checkpointPath, "utf8"));
            if (!Number.isInteger(saved.through) || saved.through < 0 || typeof saved.summary !== "string") {
                throw new Error("Invalid conversation checkpoint");
            }
            this.checkpoint = saved;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        try {
            const lines = (await fs.readFile(this.filePath, "utf8")).split("\n");
            for (let index = 0; index < lines.length; index++) {
                if (!lines[index].trim()) continue;
                let entry;
                try { entry = JSON.parse(lines[index]); }
                catch {
                    // Recover only a torn final append; never silently skip an interior record.
                    if (index < lines.length - 2) throw new Error("Corrupt conversation log");
                    await fs.writeFile(this.filePath, `${lines.slice(0, index).join("\n")}\n`, "utf8");
                    break;
                }
                if (entry.seq !== this.entries.length + 1 || !entry.id || typeof entry.text !== "string") {
                    throw new Error("Invalid conversation sequence");
                }
                this.entries.push(entry);
                this.ids.add(entry.id);
            }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (this.checkpoint.through > this.entries.length) throw new Error("Conversation checkpoint exceeds log");
    }

    append({ sessionId, role, text, startMs = null, endMs = null, eventId = null }) {
        if (!["user", "assistant", "kernel"].includes(role) || typeof text !== "string" || text.length > 16000) {
            return Promise.reject(new TypeError("Invalid conversation fragment"));
        }
        const fingerprint = JSON.stringify([sessionId, role, startMs, endMs, eventId, text]);
        const id = `live_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 40)}`;
        const operation = this.queue.catch(() => {}).then(async () => {
            if (this.ids.has(id) || !text) return null;
            const entry = { id, seq: this.entries.length + 1, session_id: sessionId, role, text,
                start_ms: startMs, end_ms: endMs, received_at: this.clock() };
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
            this.entries.push(entry);
            this.ids.add(id);
            return entry;
        });
        this.queue = operation;
        return operation;
    }

    has(id) { return this.ids.has(id); }

    groups(entries = this.entries, gapMs = 2000) {
        const result = [];
        for (const entry of entries) {
            const last = result.at(-1);
            if (last && last.role === entry.role && last.session_id === entry.session_id
                && entry.received_at - last.received_at <= gapMs) {
                last.text += entry.text;
                last.evidence_event_ids.push(entry.id);
                last.received_at = entry.received_at;
                last.end_ms = entry.end_ms;
                last.through = entry.seq;
            } else result.push({ role: entry.role, session_id: entry.session_id, text: entry.text,
                evidence_event_ids: [entry.id], received_at: entry.received_at, through: entry.seq,
                start_ms: entry.start_ms, end_ms: entry.end_ms });
        }
        return result;
    }

    recent(sessionId = null, limit = 20) {
        return this.groups(this.entries.filter((entry) => !sessionId || entry.session_id === sessionId)).slice(-limit);
    }

    batch({ stableMs, maxBytes, flush = false }) {
        const pending = this.entries.filter((entry) => entry.seq > this.checkpoint.through);
        const groups = this.groups(pending);
        const selected = [];
        let size = 0;
        for (const group of groups) {
            if (!flush && this.clock() - group.received_at < stableMs) break;
            const bytes = Buffer.byteLength(group.text, "utf8");
            if (selected.length && size + bytes > maxBytes) break;
            // A single oversized utterance is kept whole so its negation/context is not lost.
            selected.push(group);
            size += bytes;
        }
        return selected.length ? { groups: selected, from: this.checkpoint.through + 1,
            through: selected.at(-1).through } : null;
    }

    async commit(through, summary) {
        const operation = this.queue.catch(() => {}).then(async () => {
            if (through < this.checkpoint.through || through > this.entries.length) throw new Error("Invalid checkpoint advance");
            const checkpoint = { through, summary };
            await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
            const temporary = `${this.checkpointPath}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(checkpoint), "utf8");
            await fs.rename(temporary, this.checkpointPath);
            this.checkpoint = checkpoint;
        });
        this.queue = operation;
        return operation;
    }

    async prepare(batch, result, { verifiedIndices = [] } = {}) {
        const operation = this.queue.catch(() => {}).then(async () => {
            const checkpoint = { ...this.checkpoint, prepared: { batch, result, verifiedIndices } };
            await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
            const temporary = `${this.checkpointPath}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(checkpoint), "utf8");
            await fs.rename(temporary, this.checkpointPath);
            this.checkpoint = checkpoint;
        });
        this.queue = operation;
        return operation;
    }

    snapshot() { return { fragments: this.entries.length, processedThrough: this.checkpoint.through,
        pendingFragments: this.entries.length - this.checkpoint.through }; }
}
