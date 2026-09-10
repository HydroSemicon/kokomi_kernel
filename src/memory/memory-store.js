import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

const VALID_KINDS = new Set(["episodic", "preference", "relationship", "semantic"]);
const VALID_RETENTION = new Set(["session", "long"]);

function tokenize(text) {
    const normalized = String(text).toLocaleLowerCase("ja");
    const tokens = normalized
            .split(/[\s、。,.!?！？:：;；「」『』（）()]+/u)
            .map((token) => token.trim())
            .filter((token) => token.length >= 2);
    for (let index = 0; index < normalized.length - 1; index += 1) {
        const bigram = normalized.slice(index, index + 2);
        if (!/\s/u.test(bigram)) tokens.push(bigram);
    }
    return new Set(tokens);
}

function hashToken(token) {
    let hash = 2166136261;
    for (const character of token) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function featureVector(text, dimensions = 256) {
    const vector = new Float64Array(dimensions);
    for (const token of tokenize(text)) {
        const hash = hashToken(token);
        const index = hash % dimensions;
        vector[index] += (hash & 0x100) === 0 ? 1 : -1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
    return vector;
}

function cosine(left, right) {
    let score = 0;
    for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
    return Math.max(0, Math.min(1, score));
}

function contentSimilarity(left, right) {
    return cosine(featureVector(left), featureVector(right));
}

function validateProposal(proposal) {
    if (proposal === null || typeof proposal !== "object" || Array.isArray(proposal)) {
        return "memory proposal must be an object";
    }
    const allowed = ["kind", "subject", "content", "confidence", "evidence_event_ids", "retention"];
    if (Object.keys(proposal).some((key) => !allowed.includes(key))) return "memory proposal contains an unknown field";
    if (!VALID_KINDS.has(proposal.kind)) return "memory proposal kind is invalid";
    if (typeof proposal.subject !== "string" || proposal.subject.trim() === "") return "memory proposal subject is required";
    if (typeof proposal.content !== "string" || proposal.content.trim() === "" || proposal.content.length > 1000) {
        return "memory proposal content must contain 1 to 1000 characters";
    }
    if (typeof proposal.confidence !== "number" || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
        return "memory proposal confidence must be between 0 and 1";
    }
    if (
        !Array.isArray(proposal.evidence_event_ids)
        || proposal.evidence_event_ids.length === 0
        || proposal.evidence_event_ids.length > 20
        || proposal.evidence_event_ids.some((id) => typeof id !== "string" || id.trim() === "" || id.length > 128)
    ) {
        return "memory proposal evidence_event_ids must contain 1 to 20 valid observation IDs";
    }
    if (!VALID_RETENTION.has(proposal.retention)) return "memory proposal retention is invalid";
    return null;
}

export function validateMemoryProposals(proposals) {
    if (!Array.isArray(proposals)) return "memory_proposals must be an array";
    if (proposals.length > 10) return "memory_proposals may contain at most 10 items";
    for (const proposal of proposals) {
        const error = validateProposal(proposal);
        if (error) return error;
    }
    return null;
}

export class MemoryStore {
    constructor({ filePath, clock = () => Date.now(), sessionId = `session_${randomUUID()}` } = {}) {
        this.filePath = filePath;
        this.clock = clock;
        this.sessionId = sessionId;
        this.records = [];
        this.writeQueue = Promise.resolve();
    }

    async initialize() {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            if (parsed?.schema_version === "1.0" && Array.isArray(parsed.records)) {
                this.records = parsed.records;
            }
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }

    async addProposals(proposals, { source = "llm" } = {}) {
        const validationError = validateMemoryProposals(proposals);
        if (validationError) throw new TypeError(validationError);
        const now = new Date(this.clock()).toISOString();
        const added = proposals.map((proposal) => ({
            id: `memory_${randomUUID()}`,
            ...proposal,
            subject: proposal.subject.trim(),
            content: proposal.content.trim(),
            source,
            session_id: this.sessionId,
            status: "pending",
            created_at: now,
            decided_at: null,
        }));
        this.records.push(...added);
        await this.#persist();
        return added;
    }

    async decide(id, decision) {
        if (!new Set(["accepted", "rejected"]).has(decision)) {
            throw new TypeError("decision must be accepted or rejected");
        }
        const record = this.records.find((candidate) => candidate.id === id);
        if (!record) return null;
        if (record.status !== "pending") {
            if (record.status === decision) return { ...record };
            throw new TypeError("memory proposal has already been decided; submit a new proposal to correct it");
        }
        record.status = decision;
        record.decided_at = new Date(this.clock()).toISOString();
        if (decision === "accepted") record.consolidated_ids = this.#consolidate(record);
        await this.#persist();
        return { ...record };
    }

    list({ status } = {}) {
        return this.records
            .filter((record) => !status || record.status === status)
            .map((record) => ({ ...record }));
    }

    retrieve(query, { limit = 5 } = {}) {
        const queryTokens = tokenize(query);
        if (queryTokens.size === 0) return [];
        const queryVector = featureVector(query);
        return this.records
            .filter((record) => (
                record.status === "accepted"
                && (record.retention === "long" || record.session_id === this.sessionId)
            ))
            .map((record) => {
                const recordTokens = tokenize(`${record.subject} ${record.content}`);
                let overlap = 0;
                for (const token of queryTokens) if (recordTokens.has(token)) overlap += 1;
                const lexicalScore = overlap / Math.max(queryTokens.size, 1);
                const vectorScore = cosine(queryVector, featureVector(`${record.subject} ${record.content}`));
                const score = lexicalScore * 0.65 + vectorScore * 0.25 + record.confidence * 0.1;
                return { record, score, lexicalScore, vectorScore };
            })
            .filter(({ lexicalScore, vectorScore }) => lexicalScore > 0 || vectorScore >= 0.18)
            .sort((a, b) => b.score - a.score || b.record.confidence - a.record.confidence)
            .slice(0, limit)
            .map(({ record, score }) => ({
                id: record.id,
                kind: record.kind,
                subject: record.subject,
                content: record.content,
                confidence: record.confidence,
                relevance: Number(score.toFixed(3)),
                evidence_event_ids: record.evidence_event_ids,
                retrieval_method: "hybrid_lexical_hash_v1",
            }));
    }

    #consolidate(acceptedRecord) {
        const consolidated = [];
        for (const candidate of this.records) {
            if (
                candidate.id === acceptedRecord.id
                || candidate.status !== "accepted"
                || candidate.kind !== acceptedRecord.kind
                || candidate.subject.toLocaleLowerCase("ja") !== acceptedRecord.subject.toLocaleLowerCase("ja")
            ) continue;
            if (contentSimilarity(candidate.content, acceptedRecord.content) < 0.92) continue;
            candidate.status = "superseded";
            candidate.superseded_by = acceptedRecord.id;
            candidate.superseded_at = acceptedRecord.decided_at;
            consolidated.push(candidate.id);
        }
        return consolidated;
    }

    async #persist() {
        if (!this.filePath) return;
        const body = JSON.stringify({ schema_version: "1.0", records: this.records }, null, 2);
        this.writeQueue = this.writeQueue.then(async () => {
            const directory = path.dirname(this.filePath);
            await fs.mkdir(directory, { recursive: true });
            const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
            await fs.writeFile(temporaryPath, body, "utf8");
            await fs.rename(temporaryPath, this.filePath);
        });
        return this.writeQueue;
    }
}
