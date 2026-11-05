import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiDiagnostics } from "../src/live/api-diagnostics.js";
import { ResponsesBackend } from "../src/live/responses-backend.js";
import { LlmResponseProtocol } from "../src/protocol/llm-response.js";

const config = JSON.parse(await fs.readFile(new URL("../config.json", import.meta.url), "utf8"));

test("diagnostics correlate provider metadata and rejected evidence counts without writing content", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-api-diagnostics-"));
    const filePath = path.join(directory, "diagnostics.jsonl");
    t.after(async () => {
        await fs.rm(filePath, { force: true });
        await fs.rmdir(directory);
    });
    const log = new ApiDiagnostics(filePath);
    const protocol = new LlmResponseProtocol(config);
    let sentId;
    const backend = new ResponsesBackend({ config, apiKey: "private-test-key", instructions: "private instruction",
        audit: protocol.audit.bind(protocol), onDiagnostic: log.record.bind(log), fetchImpl: async (_url, request) => {
            sentId = request.headers["X-Client-Request-Id"];
            const proposal = { kind: "preference", subject: "user", content: "private proposal", confidence: 1,
                retention: "long", evidence_event_ids: Array.from({ length: 28 }, (_, i) => `private_evidence_${i}`) };
            const text = JSON.stringify({ turn_id: "memory_test", memory_extraction: { summary: "private summary",
                candidates: [{ proposal, evidence: [{ quote: "private quote", evidence_event_ids: ["private_evidence_0"] }], explicit: true, conflict: false }] } });
            return Response.json({ id: "resp_example", status: "completed", usage: { input_tokens: 500, output_tokens: 50 },
                output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] },
            { headers: { "x-request-id": "req_example", "openai-processing-ms": "132" } });
        } });
    await assert.rejects(backend.run({ task: "live_memory", turn_id: "memory_test", conversation: "private conversation" },
        { attemptId: "attempt_1" }), /evidence_event_ids/u);
    await log.queue;
    const raw = await fs.readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /private|Authorization/u);
    const [start, end, audit] = raw.trim().split("\n").map(JSON.parse);
    assert.equal(start.clientRequestId, sentId);
    assert.equal(end.clientRequestId, sentId);
    assert.equal(audit.clientRequestId, sentId);
    assert.equal(audit.attemptId, "attempt_1");
    assert.equal(end.requestId, "req_example");
    assert.equal(end.openaiProcessingMs, 132);
    assert.equal(end.usage.outputTokens, 50);
    assert.equal(audit.outcome, "invalid_evidence_ids");
    assert.equal(audit.candidates[0].proposalEvidenceIds, 28);
});

test("timeout before headers is distinguishable from timeout while reading a response", async () => {
    for (const headers of [false, true]) {
        const events = [];
        const backend = new ResponsesBackend({ config: { ...config, responses: { ...config.responses, timeoutMs: 15 } },
            apiKey: "test", onDiagnostic: (event, details) => events.push({ event, ...details }),
            fetchImpl: async (_url, { signal }) => {
                const wait = () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
                if (headers) return { ok: true, status: 200, headers: new Headers({ "x-request-id": "req_example" }), json: wait };
                return wait();
            } });
        await assert.rejects(backend.search("test"), /timed out/u);
        const finished = events.at(-1);
        assert.equal(finished.outcome, "timeout");
        assert.equal(finished.phase, headers ? "reading_body" : "awaiting_headers");
        assert.equal(finished.requestId, headers ? "req_example" : undefined);
    }
});
