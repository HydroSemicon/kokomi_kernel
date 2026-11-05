import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ConversationStore } from "../live/conversation-store.js";
import { groundedEvidence, validateExtraction } from "../live/memory-extractor.js";

// Apply reviewed local repairs before the runtime starts writing memories.
// CLI listing only initializes MemoryStore and never applies these repairs.
export async function normalizeExistingMemories(memory, conversationPath) {
    const manifestPath = path.join(path.dirname(memory.filePath), "memory-normalization-v2.json");
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (manifest.version !== 2 || !Array.isArray(manifest.repairs)) throw new Error("Invalid memory normalization manifest");
    const pending = manifest.repairs.filter((repair) => !memory.list().some((record) => record.source_key === `memory-normalization-v2:${repair.id}`));
    if (!pending.length) return [];
    const entries = (await fs.readFile(conversationPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const groups = new ConversationStore({}).groups(entries);
    for (const repair of pending) {
        const candidate = { proposal: repair.proposal, evidence: repair.evidence, explicit: true, conflict: false };
        if (typeof repair.id !== "string" || !repair.id || validateExtraction({ summary: "", candidates: [candidate] })
            || !groundedEvidence(candidate, groups)) throw new Error("Memory normalization evidence does not match the conversation");
    }
    try { await fs.copyFile(memory.filePath, `${memory.filePath}.before-normalization-v2.json`, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const repaired = [];
    for (const repair of pending) repaired.push(await memory.normalizeAccepted(repair));
    return repaired;
}
