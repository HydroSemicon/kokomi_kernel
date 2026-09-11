function codePoints(value) {
    return [...value];
}

export function normalizeSpeechText(value) {
    if (typeof value !== "string") return "";
    return value
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/[\p{P}\p{S}\s]/gu, "");
}

export function normalizedEditSimilarity(left, right) {
    const a = codePoints(normalizeSpeechText(left));
    const b = codePoints(normalizeSpeechText(right));
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export class TtsEchoGuard {
    constructor({ echoGuardMs = 1000, similarityThreshold = 0.72, minMeaningfulLength = 4, maxEntries = 16 } = {}) {
        this.echoGuardMs = echoGuardMs;
        this.similarityThreshold = similarityThreshold;
        this.minMeaningfulLength = minMeaningfulLength;
        this.maxEntries = maxEntries;
        this.entries = [];
    }

    start({ turnId, text, startedAt }) {
        const normalizedText = normalizeSpeechText(text);
        if (!normalizedText) return;
        this.entries.push({
            turnId,
            text: normalizedText,
            startedAtMs: Date.parse(startedAt),
            completedAtMs: null,
        });
        while (this.entries.length > this.maxEntries) this.entries.shift();
    }

    finish({ turnId, completedAt }) {
        const entry = [...this.entries].reverse().find((candidate) => candidate.turnId === turnId && candidate.completedAtMs === null);
        if (entry) entry.completedAtMs = Date.parse(completedAt);
    }

    match(text, observedAt = new Date().toISOString()) {
        const candidate = normalizeSpeechText(text);
        if (!candidate) return null;
        const observedAtMs = Date.parse(observedAt);
        if (!Number.isFinite(observedAtMs)) return null;

        for (const entry of [...this.entries].reverse()) {
            const windowEnd = (entry.completedAtMs ?? observedAtMs) + this.echoGuardMs;
            if (observedAtMs < entry.startedAtMs || observedAtMs > windowEnd) continue;

            const shorterLength = Math.min(codePoints(candidate).length, codePoints(entry.text).length);
            const contains = shorterLength >= this.minMeaningfulLength
                && (candidate.includes(entry.text) || entry.text.includes(candidate));
            const similarity = normalizedEditSimilarity(candidate, entry.text);
            if (contains || similarity >= this.similarityThreshold) {
                return {
                    matched: true,
                    method: contains ? "containment" : "edit_similarity",
                    similarity,
                    turnId: entry.turnId,
                };
            }
        }
        return null;
    }
}
