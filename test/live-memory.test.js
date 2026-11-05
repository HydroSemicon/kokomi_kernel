import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConversationStore } from "../src/live/conversation-store.js";
import { MemoryExtractor } from "../src/live/memory-extractor.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { BackendQueue } from "../src/live/backend-queue.js";
import { fitText, textChunks, textCost } from "../src/live/text-budget.js";
import { LlmResponseProtocol } from "../src/protocol/llm-response.js";
import { normalizeExistingMemories } from "../src/memory/normalize-existing.js";

const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));

async function fixture(t) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-live-memory-"));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    let now = 10000;
    const options = { filePath: path.join(folder, "log.jsonl"), checkpointPath: path.join(folder, "checkpoint.json"), clock: () => now };
    const journal = new ConversationStore(options);
    await journal.initialize();
    const memory = new MemoryStore({ filePath: path.join(folder, "memory.json") });
    await memory.initialize();
    return { journal, memory, options, setNow: (value) => { now = value; }, clock: () => now };
}

function candidate(group, overrides = {}) {
    return { proposal: { kind: "preference", subject: "user", content: group.text.trim(), confidence: 0.9,
        evidence_event_ids: group.evidence_event_ids, retention: "long", ...overrides },
    quote: group.text.trim(), explicit: true, conflict: false };
}

test("conversation log preserves exact fragments, deduplicates, and resumes its durable checkpoint", async (t) => {
    const f = await fixture(t);
    const fragment = { sessionId: "live_one", role: "user", text: "紅茶が", eventId: "a", startMs: 0, endMs: 100 };
    await f.journal.append(fragment);
    assert.equal(await f.journal.append(fragment), null);
    await f.journal.append({ ...fragment, eventId: "b", text: "好きです。", startMs: 100, endMs: 200 });
    assert.equal(f.journal.recent()[0].text, "紅茶が好きです。");
    assert.equal(f.journal.batch({ stableMs: 2000, maxBytes: 1000 }), null);
    f.setNow(13000);
    const batch = f.journal.batch({ stableMs: 2000, maxBytes: 1000 });
    assert.equal(batch.through, 2);
    await f.journal.commit(2, "紅茶の話");
    const reload = new ConversationStore(f.options);
    await reload.initialize();
    assert.equal(reload.checkpoint.summary, "紅茶の話");
    assert.equal(reload.snapshot().pendingFragments, 0);
    assert.equal(reload.has(batch.groups[0].evidence_event_ids[0]), true);
});

test("a torn last log record is repaired but interior corruption fails explicitly", async (t) => {
    const f = await fixture(t);
    await f.journal.append({ sessionId: "live_one", role: "user", text: "こんばんは", eventId: "a" });
    await fs.appendFile(f.options.filePath, '{"seq":2');
    const reload = new ConversationStore(f.options);
    await reload.initialize();
    await reload.append({ sessionId: "live_one", role: "assistant", text: "こんばんは", eventId: "b" });
    const again = new ConversationStore(f.options);
    await again.initialize();
    assert.equal(again.entries.length, 2);
    await fs.writeFile(f.options.filePath, '{bad}\n{}\n{}\n');
    await assert.rejects(new ConversationStore(f.options).initialize(), /Corrupt/u);
});

test("explicit user facts auto-accept; assistant claims, extra inferences, permissions, and uncertainty stay pending", async (t) => {
    const f = await fixture(t);
    for (const [role, text] of [["user", "紅茶が好きです。"], ["assistant", "ユーザーは京都に住んでいます。"],
        ["user", "たとえば犬を飼ったら楽しそう。"], ["user", "投稿を常に許可します。"], ["user", "猫が好きです。"]]) {
        await f.journal.append({ sessionId: "live_one", role, text, eventId: text });
        f.setNow(f.clock() + 3000);
    }
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        clock: f.clock, run: async ({ batch }) => ({ summary: "好みについて会話した。", candidates: batch.groups.map((group, index) =>
            candidate(group, index === 4 ? { content: `${group.text} 猫を三匹飼っている。` } : {})) }) });
    await extractor.tick({ flush: true });
    assert.equal(f.memory.list({ status: "accepted" }).length, 1);
    assert.equal(f.memory.list({ status: "pending" }).length, 4);
    assert.equal(f.journal.snapshot().pendingFragments, 0);
});

test("unrelated preferences both auto-accept and a conflicting same-topic preference stays pending", async (t) => {
    const f = await fixture(t);
    for (const text of ["紅茶が好きです。", "猫が好きです。", "紅茶が嫌いです。"] ) {
        await f.journal.append({ sessionId: "live_one", role: "user", text, eventId: text });
        f.setNow(f.clock() + 3000);
    }
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        clock: f.clock, run: async ({ batch }) => ({ summary: "好み", candidates: batch.groups.map((group) => candidate(group)) }) });
    await extractor.tick({ flush: true });
    assert.equal(f.memory.list({ status: "accepted" }).length, 2);
    assert.equal(f.memory.list({ status: "pending" }).length, 1);
});

test("failed extraction retains the cursor, retries only after backoff, and cannot create concurrent jobs", async (t) => {
    const f = await fixture(t);
    await f.journal.append({ sessionId: "live_one", role: "user", text: "紅茶が好き", eventId: "a" });
    let attempts = 0;
    let release;
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        clock: f.clock, run: async () => { attempts++; await new Promise((resolve) => { release = resolve; }); throw new Error("offline"); } });
    const first = extractor.tick({ flush: true });
    assert.equal(extractor.tick({ flush: true }), first);
    release();
    await first;
    assert.equal(f.journal.checkpoint.through, 0);
    await extractor.tick();
    assert.equal(attempts, 1);
    f.setNow(f.clock() + 31000);
    extractor.run = async ({ batch }) => { attempts++; return { summary: "好み", candidates: [candidate(batch.groups[0])] }; };
    await extractor.tick();
    assert.equal(attempts, 2);
    assert.equal(f.memory.list({ status: "accepted" }).length, 1);
});

test("replaying a persisted extraction after a checkpoint failure does not duplicate its memory", async (t) => {
    const f = await fixture(t);
    await f.journal.append({ sessionId: "live_one", role: "user", text: "紅茶が好き", eventId: "a" });
    const realCommit = f.journal.commit.bind(f.journal);
    f.journal.commit = async () => { throw new Error("disk full"); };
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        clock: f.clock, run: async ({ batch }) => ({ summary: "好み", candidates: [candidate(batch.groups[0])] }) });
    await extractor.tick({ flush: true });
    assert.equal(f.memory.list().length, 1);
    assert.equal(f.journal.checkpoint.through, 0);
    f.journal.commit = realCommit;
    f.setNow(f.clock() + 31000);
    await extractor.tick();
    assert.equal(f.memory.list().length, 1);
    assert.equal(f.journal.checkpoint.through, 1);
});

test("backend queue serializes jobs in a lane and orders pending jobs by priority", async () => {
    const queue = new BackendQueue();
    const order = [];
    let release;
    const first = queue.submit(async () => { order.push("running"); await new Promise((resolve) => { release = resolve; }); });
    const memory = queue.submit(async () => order.push("memory"));
    const control = queue.submit(async () => order.push("control"), { priority: 100 });
    const cancelled = queue.submit(() => assert.fail("stale task ran"), { priority: 200, valid: () => false });
    const rejected = assert.rejects(cancelled, /superseded/u);
    release();
    await Promise.all([first, memory, control, rejected]);
    assert.deepEqual(order, ["running", "control", "memory"]);
});

test("task-specific audits allow memory-only results and reject actions on the extraction path", () => {
    const protocol = new LlmResponseProtocol(config);
    const payload = { turn_id: "m_1", memory_extraction: { summary: "", candidates: [] } };
    assert.equal(protocol.audit(payload, { task: "live_memory" }).ok, true);
    assert.equal(protocol.audit({ ...payload, actions: [] }, { task: "live_memory" }).ok, false);
    assert.equal(protocol.audit(payload).ok, false);
    const review = { turn_id: "review", memory_verification: { supported_indices: [0] } };
    assert.equal(protocol.audit(review, { task: "live_memory_review" }).ok, true);
    assert.equal(protocol.audit({ ...review, actions: [] }, { task: "live_memory_review" }).ok, false);
    assert.equal(protocol.audit({ ...review, memory_verification: { supported_indices: [0, 0] } }, { task: "live_memory_review" }).ok, false);
    assert.equal(protocol.audit(review).ok, false);
    assert.equal(protocol.audit({ turn_id: "c_1", result: "赤いカップがあります。" }, { task: "live_control" }).ok, true);
    assert.equal(protocol.audit({ turn_id: "c_1", result: "完了", speech: "完了", emotion: "calm", intensity: 0.1 }, { task: "live_control" }).ok, false);
});

function normalizedCandidate(groups, content = "ユーザーは最近、黒いブルゾンのようなストリート系の服を購入したと話した。") {
    return { proposal: { kind: "episodic", subject: "user", content, confidence: 0.95, retention: "long",
        evidence_event_ids: groups.flatMap((group) => group.evidence_event_ids) },
    evidence: groups.map((group) => ({ quote: group.text, evidence_event_ids: group.evidence_event_ids })),
    explicit: true, conflict: false };
}

async function clothingConversation(f) {
    for (const [role, text] of [["user", "えっと、最近服を買った"], ["assistant", "どんな服？"],
        ["user", "ストリート系"], ["assistant", "色は？"], ["user", "黒のブルゾンみたいな"]]) {
        await f.journal.append({ sessionId: "clothes", role, text, eventId: text });
        f.setNow(f.clock() + 3000);
    }
    return f.journal.groups().filter((group) => group.role === "user");
}

test("related user utterances become one verified normalized memory with separate exact evidence", async (t) => {
    const f = await fixture(t);
    const users = await clothingConversation(f);
    const proposal = normalizedCandidate(users);
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        run: async () => ({ summary: "服の話", candidates: [proposal] }), verify: async ({ batch }) => {
            assert.equal(batch.groups.length, 5);
            return { supported_indices: [0] };
        } });
    await extractor.tick({ flush: true });
    const records = f.memory.list({ status: "accepted" });
    assert.equal(records.length, 1);
    assert.equal(records[0].content, proposal.proposal.content);
    assert.deepEqual(records[0].evidence.map((evidence) => evidence.quote), users.map((group) => group.text));
    assert.equal(records[0].semantic_verification, "supported");
});

test("normalized content requires independent approval even when evidence quotes exist", async (t) => {
    const f = await fixture(t);
    const users = await clothingConversation(f);
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        run: async () => ({ summary: "服の話", candidates: [normalizedCandidate(users, "ユーザーは高級ブランドの服を購入した。"), candidate(users[1])] }),
        verify: async () => ({ supported_indices: [] }) });
    await extractor.tick({ flush: true });
    assert.equal(f.memory.list({ status: "accepted" }).length, 0);
    assert.equal(f.memory.list({ status: "pending" }).length, 2);
});

test("review approval cannot bypass fabricated quotes or assistant-only evidence", async (t) => {
    const f = await fixture(t);
    const users = await clothingConversation(f);
    const wrongQuote = normalizedCandidate(users);
    wrongQuote.evidence[0].quote = "高級ブランドの服を買った";
    const assistantClaim = normalizedCandidate(f.journal.groups().filter((group) => group.role === "assistant"), "ユーザーは京都に住む。");
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        run: async () => ({ summary: "服の話", candidates: [wrongQuote, assistantClaim] }),
        verify: async () => ({ supported_indices: [0, 1] }) });
    await extractor.tick({ flush: true });
    assert.equal(f.memory.list({ status: "accepted" }).length, 0);
    assert.equal(f.memory.list({ status: "pending" }).length, 2);
});

test("a checkpoint retry reuses normalized content and its persisted review without another model decision", async (t) => {
    const f = await fixture(t);
    const users = await clothingConversation(f);
    let reviews = 0;
    const commit = f.journal.commit.bind(f.journal);
    f.journal.commit = async () => { throw new Error("disk unavailable"); };
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        clock: f.clock, run: async () => ({ summary: "服の話", candidates: [normalizedCandidate(users)] }),
        verify: async () => { reviews++; return { supported_indices: [0] }; } });
    await extractor.tick({ flush: true });
    assert.deepEqual(f.journal.checkpoint.prepared.verifiedIndices, [0]);
    f.journal.commit = commit;
    f.setNow(f.clock() + 31000);
    await extractor.tick();
    assert.equal(reviews, 1);
    assert.equal(f.memory.list({ status: "accepted" }).length, 1);
});

test("reviewed repairs preserve originals, make a backup, and are idempotent", async (t) => {
    const f = await fixture(t);
    const users = await clothingConversation(f);
    const originals = await f.memory.addProposals(users.map((group) => ({ ...candidate(group).proposal, kind: "episodic" })), { source: "live_memory_extraction" });
    for (const record of originals) await f.memory.decide(record.id, "accepted");
    const before = await fs.readFile(f.memory.filePath, "utf8");
    const candidateData = normalizedCandidate(users);
    const manifestPath = path.join(path.dirname(f.memory.filePath), "memory-normalization-v2.json");
    await fs.writeFile(manifestPath, JSON.stringify({ version: 2, repairs: [{ id: "clothes", proposal: candidateData.proposal,
        evidence: candidateData.evidence, supersedes: originals.map((record) => record.id) }] }));
    await normalizeExistingMemories(f.memory, f.options.filePath);
    await normalizeExistingMemories(f.memory, f.options.filePath);
    assert.equal(f.memory.list({ status: "accepted" }).length, 1);
    assert.equal(f.memory.list({ status: "superseded" }).length, 3);
    assert.equal(f.memory.list().length, 4);
    assert.equal(await fs.readFile(`${f.memory.filePath}.before-normalization-v2.json`, "utf8"), before);
});

test("repair source mismatches cannot change existing memory", async (t) => {
    const f = await fixture(t);
    const users = await clothingConversation(f);
    const broken = normalizedCandidate(users);
    broken.evidence[0].quote = "invented quote";
    const before = JSON.stringify(f.memory.list());
    await fs.writeFile(path.join(path.dirname(f.memory.filePath), "memory-normalization-v2.json"), JSON.stringify({ version: 2,
        repairs: [{ id: "bad", proposal: broken.proposal, evidence: broken.evidence, supersedes: ["unknown"] }] }));
    await assert.rejects(normalizeExistingMemories(f.memory, f.options.filePath), /evidence/u);
    assert.equal(JSON.stringify(f.memory.list()), before);
});

test("context chunk budgets never split a Unicode character or exceed the token upper bound", () => {
    const text = "心海🙂".repeat(300);
    const chunks = textChunks(text, 450);
    assert.equal(chunks.join(""), text);
    assert.ok(chunks.every((chunk) => textCost(chunk) <= 450 && !chunk.includes("�")));
    assert.ok(textCost(fitText(text, 6000)) <= 6000);
});

test("complete sentence extraction handles long turns without dropping negation from a quoted clause", async (t) => {
    const f = await fixture(t);
    await f.journal.append({ sessionId: "live_one", role: "user", text: "紅茶が好きじゃない。猫は好きです。", eventId: "a" });
    const extractor = new MemoryExtractor({ config: config.memory.extraction, conversations: f.journal, memory: f.memory,
        clock: f.clock, run: async ({ batch }) => {
            const group = batch.groups[0];
            return { summary: "好みの話", candidates: [
                { ...candidate(group, { content: "紅茶が好き" }), quote: "紅茶が好き" },
                { ...candidate(group, { content: "猫は好きです。" }), quote: "猫は好きです。" },
            ] };
        } });
    await extractor.tick({ flush: true });
    assert.equal(f.memory.list({ status: "accepted" }).length, 1);
    assert.equal(f.memory.list({ status: "accepted" })[0].content, "猫は好きです。");
    assert.equal(f.memory.list({ status: "pending" })[0].content, "紅茶が好き");
});
