import { hasEnvironmentReading } from "../behavior/environment-text.js";

export function memoryConversation(groups) {
    const sources = new Map();
    const conversation = groups.flatMap((group, index) => {
        if (group.role !== "user" && hasEnvironmentReading(group.text)) return [];
        const ref = `u${index + 1}`;
        const eligible = group.role === "user" && group.text.trim() && group.evidence_event_ids.length;
        if (eligible) sources.set(ref, group);
        return [{ role: group.role, text: group.text, ...(eligible ? { ref } : {}) }];
    });
    return { conversation, sources };
}

export function restoreMemoryEvidence(payload, sources) {
    const extraction = payload?.memory_extraction;
    if (!Array.isArray(extraction?.candidates)) return payload; // The normal protocol audit rejects it.
    return { ...payload, memory_extraction: { ...extraction, candidates: extraction.candidates.map((candidate) => {
        if (!candidate || !Array.isArray(candidate.evidence_refs) || !candidate.evidence_refs.length
            || candidate.evidence_refs.length > 10 || new Set(candidate.evidence_refs).size !== candidate.evidence_refs.length
            || !candidate.evidence_refs.every((ref) => sources.has(ref))) {
            throw new Error("Memory extraction returned invalid evidence references");
        }
        const { kind, content, confidence, retention, explicit, conflict } = candidate;
        const evidence = candidate.evidence_refs.map((ref) => {
            const group = sources.get(ref);
            return { quote: group.text.trim(), evidence_event_ids: [group.evidence_event_ids[0]] };
        });
        return { proposal: { kind, subject: "user", content, confidence, retention,
            evidence_event_ids: evidence.map((item) => item.evidence_event_ids[0]) }, evidence, explicit, conflict };
    }) } };
}

export function reviewCandidates(candidates, sources) {
    const refs = new Map([...sources].map(([ref, group]) => [group.evidence_event_ids[0], ref]));
    return candidates.map(({ proposal }, index) => ({ index, content: proposal.content,
        evidence_refs: proposal.evidence_event_ids.map((id) => refs.get(id)).filter(Boolean) }));
}

export function knownMemoryFacts(known) {
    return known.filter(({ content }) => !hasEnvironmentReading(content)).map(({ kind, subject, content }) => ({ kind, subject, content }));
}
