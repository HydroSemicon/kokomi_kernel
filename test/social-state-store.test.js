import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SocialStateStore, validateSocialProposals } from "../src/social/social-state-store.js";

test("social boundaries remain pending until accepted and then constrain actions", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kokomi-social-test-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new SocialStateStore({ filePath: path.join(directory, "social.json") });
    await store.initialize();
    const [proposal] = await store.addProposals([{
        kind: "boundary",
        subject: "user",
        content: "公開投稿をしない",
        action_type: "bluesky_post",
        permission: "deny",
        confidence: 1,
        evidence_event_ids: ["obs_1"],
    }]);
    assert.equal(store.isActionDenied("bluesky_post"), false);
    await store.decide(proposal.id, "accepted");
    assert.equal(store.isActionDenied("bluesky_post"), true);
    assert.equal(store.context().boundaries[0].permission, "deny");
    await assert.rejects(store.decide(proposal.id, "rejected"), /already been decided/u);

    const [replacement] = await store.addProposals([{
        kind: "boundary",
        subject: "user",
        content: "依頼した投稿だけ許可する",
        action_type: "bluesky_post",
        permission: "allow",
        confidence: 1,
        evidence_event_ids: ["obs_2"],
    }]);
    await store.decide(replacement.id, "accepted");
    assert.equal(store.isActionDenied("bluesky_post"), false);
    assert.equal(store.list({ status: "superseded" })[0].id, proposal.id);
});

test("social proposal validation rejects ungrounded commitments", () => {
    assert.match(validateSocialProposals([{
        kind: "commitment",
        subject: "user",
        content: "あとで確認する",
        confidence: 0.7,
        evidence_event_ids: [],
    }]), /evidence/u);
});
