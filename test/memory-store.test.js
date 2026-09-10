import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore, validateMemoryProposals } from "../src/memory/memory-store.js";

const validProposal = {
    kind: "preference",
    subject: "user",
    content: "ユーザーは静かな部屋を好む",
    confidence: 0.9,
    evidence_event_ids: ["obs_1"],
    retention: "long",
};

test("memory proposals remain pending until the Kernel accepts them", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-memory-test-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "memory.json");
    const store = new MemoryStore({ filePath });
    await store.initialize();

    const [pending] = await store.addProposals([validProposal]);
    assert.equal(pending.status, "pending");
    assert.deepEqual(store.retrieve("静かな部屋"), []);

    await store.decide(pending.id, "accepted");
    const retrieved = store.retrieve("静かな部屋が好き");
    assert.equal(retrieved.length, 1);
    assert.equal(retrieved[0].id, pending.id);

    const reloaded = new MemoryStore({ filePath });
    await reloaded.initialize();
    assert.equal(reloaded.list({ status: "accepted" }).length, 1);
});

test("memory proposal schema rejects ungrounded or malformed records", () => {
    assert.equal(validateMemoryProposals([validProposal]), null);
    assert.match(
        validateMemoryProposals([{ ...validProposal, confidence: 2 }]),
        /between 0 and 1/,
    );
    assert.match(
        validateMemoryProposals([{ ...validProposal, evidence_event_ids: "obs_1" }]),
        /observation IDs/,
    );
    assert.match(
        validateMemoryProposals([{ ...validProposal, evidence_event_ids: [] }]),
        /observation IDs/,
    );
});
