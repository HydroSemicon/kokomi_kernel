import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

const KINDS = new Set(["relationship", "boundary", "commitment"]);
const PERMISSIONS = new Set(["allow", "deny"]);
const COMMITMENT_STATUSES = new Set(["open", "completed", "cancelled"]);
const ACTION_TYPES = new Set(["tear", "led_change", "bluesky_post", "remember_person", "say"]);

function validateProposal(proposal) {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return "social proposal must be an object";
    const allowedFields = new Set([
        "kind", "subject", "content", "confidence", "evidence_event_ids",
        "action_type", "permission", "status",
    ]);
    if (Object.keys(proposal).some((key) => !allowedFields.has(key))) return "social proposal contains an unknown field";
    if (!KINDS.has(proposal.kind)) return "social proposal kind is invalid";
    if (typeof proposal.subject !== "string" || !proposal.subject.trim()) return "social proposal subject is required";
    if (typeof proposal.content !== "string" || !proposal.content.trim() || proposal.content.length > 1000) {
        return "social proposal content must contain 1 to 1000 characters";
    }
    if (typeof proposal.confidence !== "number" || proposal.confidence < 0 || proposal.confidence > 1) {
        return "social proposal confidence must be between 0 and 1";
    }
    if (
        !Array.isArray(proposal.evidence_event_ids)
        || proposal.evidence_event_ids.length === 0
        || proposal.evidence_event_ids.length > 20
        || proposal.evidence_event_ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)
    ) {
        return "social proposal requires evidence_event_ids";
    }
    if (proposal.kind === "boundary") {
        if (!ACTION_TYPES.has(proposal.action_type) || !PERMISSIONS.has(proposal.permission)) {
            return "boundary requires action_type and allow/deny permission";
        }
    } else if (proposal.action_type !== undefined || proposal.permission !== undefined) {
        return "action_type and permission are valid only for boundaries";
    }
    if (proposal.kind === "commitment" && proposal.status !== undefined && !COMMITMENT_STATUSES.has(proposal.status)) {
        return "commitment status is invalid";
    }
    if (proposal.kind !== "commitment" && proposal.status !== undefined) return "status is valid only for commitments";
    return null;
}

export function validateSocialProposals(proposals) {
    if (!Array.isArray(proposals)) return "social_proposals must be an array";
    if (proposals.length > 10) return "social_proposals may contain at most 10 items";
    for (const proposal of proposals) {
        const error = validateProposal(proposal);
        if (error) return error;
    }
    return null;
}

export class SocialStateStore {
    constructor({ filePath, clock = () => Date.now(), visiblePersonTtlMs = 300_000 } = {}) {
        this.filePath = filePath;
        this.clock = clock;
        this.visiblePersonTtlMs = visiblePersonTtlMs;
        this.records = [];
        this.visiblePeople = new Map();
        this.lastInteractionAt = null;
        this.writeQueue = Promise.resolve();
    }

    async initialize() {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            if (parsed?.schema_version === "1.0" && Array.isArray(parsed.records)) this.records = parsed.records;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }

    observe(observation) {
        if (observation.type.startsWith("vision.person_")) {
            const trackId = String(observation.payload.track_id);
            if (observation.type === "vision.person_disappeared") this.visiblePeople.delete(trackId);
            else {
                this.visiblePeople.set(trackId, {
                    track_id: trackId,
                    person_id: observation.payload.identity?.person_id ?? null,
                    name: observation.payload.identity?.name ?? null,
                    identity_status: observation.payload.identity?.status ?? "unknown",
                    last_seen_at: observation.observed_at,
                });
            }
        }
        if (["interaction.user_input", "touch.petting_started"].includes(observation.type)) {
            this.lastInteractionAt = observation.observed_at;
        }
    }

    async addProposals(proposals, { source = "llm" } = {}) {
        const error = validateSocialProposals(proposals);
        if (error) throw new TypeError(error);
        const now = new Date(this.clock()).toISOString();
        const added = proposals.map((proposal) => ({
            id: `social_${randomUUID()}`,
            ...proposal,
            subject: proposal.subject.trim(),
            content: proposal.content.trim(),
            status: "pending",
            commitment_status: proposal.kind === "commitment" ? (proposal.status ?? "open") : null,
            source,
            created_at: now,
            decided_at: null,
        }));
        this.records.push(...added);
        await this.#persist();
        return added;
    }

    async decide(id, decision) {
        if (!["accepted", "rejected"].includes(decision)) throw new TypeError("decision must be accepted or rejected");
        const record = this.records.find((item) => item.id === id);
        if (!record) return null;
        if (record.status !== "pending") {
            if (record.status === decision) return { ...record };
            throw new TypeError("social proposal has already been decided; submit a new proposal to correct it");
        }
        record.status = decision;
        record.decided_at = new Date(this.clock()).toISOString();
        if (decision === "accepted") this.#supersedePriorState(record);
        await this.#persist();
        return { ...record };
    }

    list({ status, kind } = {}) {
        return this.records.filter((record) => (!status || record.status === status) && (!kind || record.kind === kind));
    }

    isActionDenied(actionType) {
        const boundary = [...this.records].reverse().find((record) => (
            record.status === "accepted" && record.kind === "boundary" && record.action_type === actionType
        ));
        return boundary?.permission === "deny";
    }

    context() {
        const accepted = this.records.filter((record) => record.status === "accepted");
        const nowMs = this.clock();
        return {
            visible_people: [...this.visiblePeople.values()].filter((person) => (
                nowMs <= Date.parse(person.last_seen_at) + this.visiblePersonTtlMs
            )),
            last_interaction_at: this.lastInteractionAt,
            relationships: accepted.filter((record) => record.kind === "relationship").slice(-5).map(compactRecord),
            boundaries: accepted.filter((record) => record.kind === "boundary").slice(-10).map(compactRecord),
            open_commitments: accepted
                .filter((record) => record.kind === "commitment" && record.commitment_status === "open")
                .slice(-10)
                .map(compactRecord),
        };
    }

    async #persist() {
        if (!this.filePath) return;
        const body = JSON.stringify({ schema_version: "1.0", records: this.records }, null, 2);
        this.writeQueue = this.writeQueue.then(async () => {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
            await fs.writeFile(temporaryPath, body, "utf8");
            await fs.rename(temporaryPath, this.filePath);
        });
        return this.writeQueue;
    }

    #supersedePriorState(acceptedRecord) {
        for (const candidate of this.records) {
            if (candidate.id === acceptedRecord.id || candidate.status !== "accepted" || candidate.kind !== acceptedRecord.kind) continue;
            const sameSubject = candidate.subject.toLocaleLowerCase("ja") === acceptedRecord.subject.toLocaleLowerCase("ja");
            const replacesBoundary = acceptedRecord.kind === "boundary"
                && sameSubject
                && candidate.action_type === acceptedRecord.action_type;
            const replacesCommitment = acceptedRecord.kind === "commitment"
                && sameSubject
                && candidate.content.trim() === acceptedRecord.content.trim();
            if (!replacesBoundary && !replacesCommitment) continue;
            candidate.status = "superseded";
            candidate.superseded_by = acceptedRecord.id;
            candidate.superseded_at = acceptedRecord.decided_at;
        }
    }
}

function compactRecord(record) {
    return {
        id: record.id,
        kind: record.kind,
        subject: record.subject,
        content: record.content,
        confidence: record.confidence,
        ...(record.kind === "boundary" ? { action_type: record.action_type, permission: record.permission } : {}),
        ...(record.kind === "commitment" ? { status: record.commitment_status } : {}),
    };
}
