import test from "node:test";
import assert from "node:assert/strict";
import { sendBrowserJson } from "../src/browser/chat-input.js";
import { BrowserBackend } from "../src/live/browser-backend.js";
import { TurnRegistry } from "../src/behavior/turn-registry.js";

const config = { chatInputSelector: "#input", enabledSendButtonSelector: "#send:enabled",
    sendButtonSelector: "#send", inputTimeoutMs: 1000 };

function inputFixture({ mutate = (text) => text, confirm = async () => {} } = {}) {
    let text = "unfinished old draft";
    const inserts = [];
    const clicks = [];
    const page = { waitForSelector: async () => {},
        waitForFunction: async (_predicate, _options, selector) => selector === config.enabledSendButtonSelector
            ? { evaluate: async () => clicks.push(selector) } : confirm(),
        focus: async (selector) => clicks.push(selector),
        $eval: async () => text, type: () => assert.fail("Do not type prompts character by character"),
        keyboard: { down: async () => {}, up: async () => {},
            press: async (key) => { if (key === "Backspace") text = ""; },
            sendCharacter: async (value) => { inserts.push(value); text = mutate(value); } } };
    return { page, inserts, clicks };
}

test("large JSON with quoted Markdown and Japanese is inserted once, preserving every character", async () => {
    const f = inputFixture();
    const input = { turn_id: "one", instructions: '```json\n{"text":"こんにちは🌸"}\n```\r\n'.repeat(500) };
    await sendBrowserJson(f.page, input, { config });
    assert.deepEqual(f.inserts, [JSON.stringify(input)]);
    assert.deepEqual(f.clicks, ["#input", "#send:enabled"]);
});

test("modified or incomplete JSON is never submitted", async () => {
    const f = inputFixture({ mutate: (text) => text.slice(0, -1) });
    await assert.rejects(sendBrowserJson(f.page, { turn_id: "one" }, { config }), /complete JSON/u);
    assert.ok(!f.clicks.includes("#send:enabled"));
});

test("a request invalidated during insertion cannot click Send", async () => {
    let valid = true;
    const f = inputFixture({ mutate: (text) => { valid = false; return text; } });
    await assert.rejects(sendBrowserJson(f.page, { turn_id: "one" }, { config, isValid: () => valid }), /superseded/u);
    assert.ok(!f.clicks.includes("#send:enabled"));
});

test("a click that leaves the editor populated is reported as unconfirmed instead of successful", async () => {
    const f = inputFixture({ confirm: async () => { throw new Error("editor is still populated"); } });
    await assert.rejects(sendBrowserJson(f.page, { turn_id: "one" }, { config }), /send confirmation failed.*populated/u);
    assert.equal(f.clicks.filter((selector) => selector === "#send:enabled").length, 1);
});

function backendFixture(overrides = {}) {
    const pending = new Map();
    const turns = new TurnRegistry();
    const sent = [];
    const answer = (input) => {
        pending.get(input.turn_id).resolve({ turn_id: input.turn_id, result: "確認しました" });
        pending.delete(input.turn_id);
    };
    const backend = new BrowserBackend({ enqueue: (operation) => Promise.resolve().then(operation),
        send: async (input) => { sent.push(input); answer(input); }, loadInstructions: async () => "protocol instructions",
        attachImage: async () => "temporary-image", cleanupImage: () => {},
        turns, pending, responseTimeoutMs: 100, ...overrides });
    return { backend, pending, turns, sent, answer };
}

test("bootstrap shares the first correlated task and is omitted from subsequent tasks", async () => {
    const f = backendFixture();
    await f.backend.run({ turn_id: "one", task: "live_control" });
    await f.backend.run({ turn_id: "two", task: "live_memory" });
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0].turn_id, "one");
    assert.equal(f.sent[0].kernel_backend_bootstrap.instructions, "protocol instructions");
    assert.equal(f.sent[1].kernel_backend_bootstrap, undefined);
    assert.equal(f.pending.size, 0);
    assert.equal(f.turns.snapshot().count, 0);
});

test("queueing and insertion do not consume the model response timeout", async () => {
    const delay = () => new Promise((resolve) => setTimeout(resolve, 15));
    const f = backendFixture({ responseTimeoutMs: 5, enqueue: async (operation) => { await delay(); return operation(); } });
    f.backend.send = async (input) => { await delay(); f.answer(input); };
    const result = await f.backend.run({ turn_id: "slow-input", task: "live_memory" });
    assert.equal(result.turn_id, "slow-input");
    assert.equal(f.pending.size, 0);
});

test("failed submissions keep bootstrap available for a later successful attempt", async () => {
    const f = backendFixture();
    f.backend.send = async () => { throw new Error("input unavailable"); };
    await assert.rejects(f.backend.run({ turn_id: "failed" }), /input unavailable/u);
    assert.equal(f.pending.size, 0);
    assert.equal(f.turns.snapshot().count, 0);
    f.backend.send = async (input) => { f.sent.push(input); f.answer(input); };
    await f.backend.run({ turn_id: "retry" });
    assert.equal(f.sent[0].kernel_backend_bootstrap.instructions, "protocol instructions");
});

test("a missing response times out after submission and releases its pending turn", async () => {
    const f = backendFixture({ responseTimeoutMs: 5, send: async () => {} });
    await assert.rejects(f.backend.run({ turn_id: "no-response" }), /response timed out/u);
    assert.equal(f.pending.size, 0);
    assert.equal(f.turns.snapshot().count, 0);
});
