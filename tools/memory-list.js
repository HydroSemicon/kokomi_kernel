import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/memory-store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
    const args = process.argv.slice(2);
    let status = "accepted";
    let json = false;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--json") json = true;
        else if (args[index] === "--status") status = args[++index];
        else throw new Error(`Unknown option: ${args[index]}`);
    }
    if (!["accepted", "pending", "rejected", "superseded", "all"].includes(status)) throw new Error("Invalid --status");
    const configPath = process.env.KOKOMI_CONFIG_PATH ? path.resolve(process.env.KOKOMI_CONFIG_PATH) : path.join(root, "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const store = new MemoryStore({ filePath: path.resolve(root, config.memory.storagePath) });
    await store.initialize();
    const records = store.list({ status: status === "all" ? undefined : status }).filter((record) => record.retention === "long");
    if (json) console.log(JSON.stringify({ status, count: records.length, records }, null, 2));
    else {
        console.log(`長期記憶: ${records.length}件 (status=${status})`);
        for (const record of records) console.log(`\n[${record.status}] ${record.kind} / ${record.subject}\n${record.content}\nID: ${record.id}\n保存: ${record.created_at}`);
    }
} catch (error) { console.error(`Memory listing failed: ${error.message}`); process.exitCode = 1; }
