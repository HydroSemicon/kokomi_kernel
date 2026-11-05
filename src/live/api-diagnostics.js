import fs from "node:fs/promises";
import path from "node:path";

// Callers provide structured metadata only. Keep the newest two files for local diagnosis.
export class ApiDiagnostics {
    constructor(filePath, { maxBytes = 2 * 1024 * 1024 } = {}) {
        this.filePath = filePath;
        this.maxBytes = maxBytes;
        this.queue = Promise.resolve();
        this.size = null;
        this.warned = false;
    }

    record(event, fields) {
        const line = JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n";
        const bytes = Buffer.byteLength(line);
        this.queue = this.queue.then(async () => {
            if (this.size === null) {
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                this.size = await fs.stat(this.filePath).then((stat) => stat.size, (error) => {
                    if (error.code !== "ENOENT") throw error;
                    return 0;
                });
            }
            if (this.size && this.size + bytes > this.maxBytes) {
                await fs.rename(this.filePath, `${this.filePath}.1`);
                this.size = 0;
            }
            await fs.appendFile(this.filePath, line, "utf8");
            this.size += bytes;
            this.warned = false;
        }).catch((error) => {
            this.size = null;
            if (!this.warned) console.warn("Live API diagnostic log unavailable:", error.code ?? "write_failed");
            this.warned = true;
        });
    }
}
