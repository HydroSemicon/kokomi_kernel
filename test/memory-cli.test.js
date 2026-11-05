import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("memory console lists only accepted long-term records by default and does not modify storage", async (t) => {
    const prefix = path.join(os.tmpdir(), "kokomi-memory-cli-");
    const folder = await fs.mkdtemp(prefix);
    t.after(async () => { assert.ok(path.resolve(folder).startsWith(path.resolve(prefix))); await fs.rm(folder, { recursive: true, force: true }); });
    const memoryPath = path.join(folder, "memory.json");
    const configPath = path.join(folder, "config.json");
    await fs.writeFile(memoryPath, JSON.stringify({ schema_version: "1.0", records: [
        { id: "saved", content: "紅茶が好き", status: "accepted", retention: "long" },
        { id: "review", content: "確認待ちの候補", status: "pending", retention: "long" },
        { id: "temporary", content: "セッション限定", status: "accepted", retention: "session" },
    ] }));
    await fs.writeFile(configPath, JSON.stringify({ memory: { storagePath: memoryPath } }));
    const before = await fs.readFile(memoryPath, "utf8");
    const env = { ...process.env, KOKOMI_CONFIG_PATH: configPath };
    delete env.NODE_TEST_CONTEXT;
    const command = fileURLToPath(new URL("../tools/memory-list.js", import.meta.url));
    const run = async (args) => JSON.parse((await promisify(execFile)(process.execPath, [command, ...args, "--json"], { env, windowsHide: true })).stdout);
    assert.deepEqual((await run([])).records.map((record) => record.id), ["saved"]);
    assert.deepEqual((await run(["--status", "pending"])).records.map((record) => record.id), ["review"]);
    assert.equal((await run(["--status", "all"])).count, 2);
    assert.equal(await fs.readFile(memoryPath, "utf8"), before);
});
