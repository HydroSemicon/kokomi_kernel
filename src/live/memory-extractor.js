import { validateMemoryProposals } from "../memory/memory-store.js";
import { fitText } from "./text-budget.js";
import { createHash } from "node:crypto";

const FORBIDDEN = /パスワード|秘密鍵|API.?キー|アクセストークン|password|credential|secret|許可|権限|禁止|承認|permission|authorization|覚えないで|記録しないで/iu;
const UNCERTAIN = /もし|仮に|たとえば|例えば|冗談|かもしれ|だったら|hypothetical|joking|maybe/iu;
const CORRECTION = /訂正|じゃなく|ではなく|本当は|取り消/iu;

function completeQuote(text, quote) {
    const source = text.trim();
    const index = source.indexOf(quote);
    if (index < 0) return false;
    const before = index === 0 || /[。！？!?\n]/u.test(source[index - 1]);
    const after = index + quote.length === source.length || /[。！？!?\n]$/u.test(quote);
    return before && after;
}

export function evidenceFor(candidate) {
    return candidate.evidence ?? [{ quote: candidate.quote, evidence_event_ids: candidate.proposal.evidence_event_ids }];
}

export function groundedEvidence(candidate, groups) {
    const evidence = evidenceFor(candidate);
    if (!candidate.proposal.evidence_event_ids.every((id) => evidence.some((item) => item.evidence_event_ids.includes(id)))) return null;
    const sources = evidence.map((item) => groups.find((group) => group.role === "user"
        && completeQuote(group.text, item.quote)
        && item.evidence_event_ids.every((id) => group.evidence_event_ids.includes(id))));
    return sources.every(Boolean) ? sources : null;
}

export function validateVerification(result) {
    return !result || Object.keys(result).some((key) => key !== "supported_indices")
        || !Array.isArray(result.supported_indices) || result.supported_indices.length > 10
        || result.supported_indices.some((index) => !Number.isInteger(index) || index < 0 || index > 9)
        || new Set(result.supported_indices).size !== result.supported_indices.length ? "Invalid memory verification" : null;
}

function preferenceTopic(text) {
    const normalized = text.replace(/^(?:ユーザー|私|僕|わたし|本人)(?:は|が)\s*/u, "");
    return normalized.match(/^(.+?)(?:が|を|は)(?:好き|嫌い|好む|苦手|得意)/u)?.[1] ?? null;
}

export function validateExtraction(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)
        || Object.keys(result).some((key) => !["summary", "candidates"].includes(key))
        || typeof result.summary !== "string" || result.summary.length > 4000
        || !Array.isArray(result.candidates) || result.candidates.length > 10) return "Invalid memory extraction";
    for (const candidate of result.candidates) {
        if (!candidate || Object.keys(candidate).some((key) => !["proposal", "quote", "evidence", "explicit", "conflict"].includes(key))
            || (!candidate.evidence && (typeof candidate.quote !== "string" || !candidate.quote.trim()))
            || typeof candidate.explicit !== "boolean" || typeof candidate.conflict !== "boolean") return "Invalid memory evidence";
        const error = validateMemoryProposals([candidate.proposal]);
        if (error) return error;
        if (candidate.evidence && (!Array.isArray(candidate.evidence) || !candidate.evidence.length || candidate.evidence.length > 10
            || candidate.evidence.some((item) => !item || Object.keys(item).some((key) => !["quote", "evidence_event_ids"].includes(key))
                || typeof item.quote !== "string" || !item.quote.trim() || item.quote.length > 16000
                || !Array.isArray(item.evidence_event_ids) || !item.evidence_event_ids.length || item.evidence_event_ids.length > 20
                || item.evidence_event_ids.some((id) => typeof id !== "string" || !id || id.length > 128)))) return "Invalid memory evidence";
    }
    return null;
}

export class MemoryExtractor {
    constructor({ config, conversations, memory, run, verify = null, onStatus = () => {}, clock = () => Date.now() }) {
        Object.assign(this, { config, conversations, memory, run, verify, onStatus, clock });
        this.running = null;
        this.flushRequested = false;
        this.retryAfter = 0;
        for (const field of ["intervalSeconds", "retryIntervalSeconds", "stableSilenceMs", "maxBatchBytes", "summaryBudgetTokens"]) {
            if (!Number.isInteger(config[field]) || config[field] <= 0) throw new TypeError(`Invalid memory.extraction.${field}`);
        }
    }

    tick({ flush = false } = {}) {
        this.flushRequested ||= flush;
        if (!this.config.enabled || this.running || this.clock() < this.retryAfter) return this.running ?? Promise.resolve();
        this.running = this.extract().catch((error) => {
            this.retryAfter = this.clock() + this.config.retryIntervalSeconds * 1000;
            this.onStatus({ status: "error", message: error.message });
        }).finally(() => { this.running = null; });
        return this.running;
    }

    async extract() {
        const prepared = this.conversations.checkpoint.prepared;
        const batch = prepared?.batch ?? this.conversations.batch({ stableMs: this.config.stableSilenceMs,
            maxBytes: this.config.maxBatchBytes, flush: this.flushRequested });
        if (!batch) { this.flushRequested = false; return; }
        this.onStatus({ status: "running", through: batch.through });
        const known = this.memory.retrieve(batch.groups.map((group) => group.text).join(" "), { limit: 10 });
        const result = prepared?.result ?? await this.run({ batch, known, previousSummary: this.conversations.checkpoint.summary });
        const error = validateExtraction(result);
        if (error) throw new Error(error);
        for (const candidate of result.candidates) {
            if (![...candidate.proposal.evidence_event_ids, ...evidenceFor(candidate).flatMap((item) => item.evidence_event_ids)]
                .every((id) => batch.groups.some((item) => item.evidence_event_ids.includes(id)))) {
                throw new Error("Memory extraction references unknown evidence");
            }
        }
        let verifiedIndices = prepared?.verifiedIndices ?? [];
        if (!prepared && result.candidates.length && this.verify) {
            const verification = await this.verify({ batch, candidates: result.candidates, known });
            const verificationError = validateVerification(verification);
            if (verificationError || verification.supported_indices.some((index) => index >= result.candidates.length)) {
                throw new Error(verificationError ?? "Memory verification references an unknown candidate");
            }
            verifiedIndices = verification.supported_indices;
        }
        // Persist the immutable result before applying decisions so a crash/retry cannot
        // ask the model for a different candidate list for an already-applied batch.
        if (!prepared) await this.conversations.prepare(batch, result, { verifiedIndices });
        for (let index = 0; index < result.candidates.length; index++) {
            const candidate = result.candidates[index];
            const proposal = candidate.proposal;
            const sources = groundedEvidence(candidate, batch.groups);
            const sourceText = sources?.map((source) => source.text).join("\n") ?? "";
            // Legacy exact quotes remain readable. Normalized summaries require a separate
            // model verification, in addition to deterministic evidence/source checks.
            const literal = !this.verify && !candidate.evidence
                && [candidate.quote, `ユーザーの発言: ${candidate.quote}`].includes(proposal.content);
            const topic = preferenceTopic(proposal.content);
            const conflict = topic && this.memory.list({ status: "accepted" }).some((item) =>
                item.subject === proposal.subject && item.kind === proposal.kind
                && preferenceTopic(item.content) === topic
                && item.content !== proposal.content && proposal.kind === "preference");
            const accept = Boolean(sources) && (verifiedIndices.includes(index) || literal) && candidate.explicit && !candidate.conflict && !conflict
                && proposal.retention === "long" && ["preference", "episodic", "semantic"].includes(proposal.kind)
                && proposal.subject === "user"
                && !FORBIDDEN.test(`${proposal.content} ${sourceText}`)
                && !UNCERTAIN.test(sourceText) && !CORRECTION.test(sourceText);
            // Never store a proposal referencing nonexistent or unrelated evidence.
            if (!proposal.evidence_event_ids.every((id) => batch.groups.some((item) => item.evidence_event_ids.includes(id)))) {
                throw new Error("Memory extraction references unknown evidence");
            }
            const digest = createHash("sha256").update(JSON.stringify([proposal.kind, proposal.subject,
                proposal.content, [...proposal.evidence_event_ids].sort(), proposal.retention])).digest("hex");
            const sourceKey = `live-extraction:${batch.from}:${batch.through}:${digest}`;
            const [record] = await this.memory.addProposals([proposal], { source: "live_memory_extraction", sourceKey,
                evidence: evidenceFor(candidate), verified: verifiedIndices.includes(index) });
            if (accept && record.status === "pending") await this.memory.decide(record.id, "accepted");
        }
        await this.conversations.commit(batch.through, fitText(result.summary, this.config.summaryBudgetTokens));
        this.retryAfter = 0;
        this.onStatus({ status: "completed", through: batch.through });
        // Pending flush remains armed until a later tick drains the last batch.
    }
}
