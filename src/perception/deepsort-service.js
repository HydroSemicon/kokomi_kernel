import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

async function checkPort(host, port) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, host, () => probe.close(resolve));
    });
}

async function stopProcess(child) {
    if (process.platform === "win32") {
        // A Windows venv's python.exe is a launcher with a separate interpreter process.
        const taskkill = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe");
        await execFileAsync(taskkill, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 });
    } else {
        child.kill("SIGKILL");
    }
}

export class DeepSortService {
    constructor({ config, repositoryDirectory, storagePath, onChange }) {
        Object.assign(this, { config, repositoryDirectory, storagePath, onChange });
        this.enabled = false;
        this.status = "stopped";
        this.error = null;
        this.child = null;
        this.closed = false;
        this.queue = Promise.resolve();
    }

    snapshot() {
        return { enabled: this.enabled, status: this.status, error: this.error };
    }

    change(status, error = null) {
        this.status = status;
        this.error = error;
        this.onChange(this.snapshot());
    }

    serialize(run) {
        const job = this.queue.then(run);
        this.queue = job.catch(() => {});
        return job;
    }

    initialize(kernelUrl) {
        this.kernelUrl = kernelUrl;
        return this.serialize(async () => {
            this.enabled = this.config.deepSort?.enabled === true;
            try {
                const saved = JSON.parse(await fs.readFile(this.storagePath, "utf8"));
                if (typeof saved.enabled !== "boolean") throw new Error("Invalid DeepSORT settings");
                this.enabled = saved.enabled;
            } catch (error) {
                if (error.code !== "ENOENT") {
                    this.enabled = false;
                    this.change("error", "Could not load the saved DeepSORT switch setting");
                    return;
                }
            }
            if (this.enabled && !this.closed) await this.start();
        });
    }

    setEnabled(enabled) {
        return this.serialize(async () => {
            if (this.closed) throw new Error("Kernel is shutting down");
            await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
            const temporary = `${this.storagePath}.tmp`;
            await fs.writeFile(temporary, `${JSON.stringify({ enabled })}\n`, "utf8");
            await fs.rename(temporary, this.storagePath);
            this.enabled = enabled;
            if (!this.closed) {
                if (enabled) await this.start();
                else await this.stop();
            }
            return this.snapshot();
        });
    }

    async start() {
        if (this.child) return;
        this.change("starting");
        try {
            const settings = this.config.deepSort ?? {};
            const cwd = path.resolve(this.repositoryDirectory, settings.directory ?? "../embodied-vision");
            const python = path.resolve(cwd, settings.python ?? (process.platform === "win32"
                ? "deepsort-py311/Scripts/python.exe" : "deepsort-py311/bin/python"));
            const script = path.join(cwd, "deepsort.py");
            if (!(await fs.stat(python).catch(() => null))?.isFile()) {
                throw new Error("DeepSORT Python was not found. Check vision.deepSort.directory and vision.deepSort.python");
            }
            if (!(await fs.stat(script).catch(() => null))?.isFile()) {
                throw new Error("deepsort.py was not found. Check vision.deepSort.directory");
            }

            const url = new URL(this.config.snapshotUrl);
            if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
                throw new Error("Managed DeepSORT requires a local HTTP vision.snapshotUrl");
            }
            const host = url.hostname === "[::1]" ? "::1" : "127.0.0.1";
            const port = Number(url.port || 80);
            await checkPort(host, port);
            if (this.closed) return;
            const child = spawn(python, [script], {
                cwd, shell: false, windowsHide: true, stdio: "ignore",
                env: { ...process.env, VISION_EVENT_URL: this.kernelUrl,
                    VISION_HTTP_HOST: host, VISION_HTTP_PORT: String(port) },
            });
            this.child = child;
            let processError;
            child.once("spawn", () => {
                if (this.status === "starting") this.change("running");
            });
            child.on("error", (error) => { processError = `DeepSORT process error (${error.code ?? "unknown"})`; });
            child.once("close", (code, signal) => {
                this.child = null;
                if (this.enabled && !this.closed) {
                    this.change("error", processError ?? `DeepSORT exited (${signal ?? code})`);
                } else this.change("stopped");
            });
        } catch (error) {
            this.change("error", error.code === "EADDRINUSE"
                ? "The Vision port is already in use. Stop the manually started service before enabling DeepSORT"
                : error.message);
        }
    }

    async stop() {
        const child = this.child;
        if (!child) {
            this.change("stopped");
            return;
        }
        this.change("stopping");
        let timer;
        let onClose;
        const ended = new Promise((resolve) => { onClose = resolve; });
        child.once("close", onClose);
        try {
            if (child.pid) await stopProcess(child);
            await Promise.race([ended, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("DeepSORT stop timed out")), 3000);
            })]);
        } catch {
            if (this.child === child) this.change("error", "Could not stop the managed DeepSORT process");
        } finally {
            clearTimeout(timer);
            child.off("close", onClose);
        }
    }

    close() {
        this.closed = true;
        return this.serialize(() => this.stop());
    }
}

export function mountDeepSortRoutes(app, route, service) {
    app.get(route, async (_req, res) => {
        await service.queue;
        res.set("Cache-Control", "no-store").json(service.snapshot());
    });
    app.post(route, async (req, res) => {
        if (!loopbackHosts.has(req.hostname) || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
            return res.status(403).json({ error: "DeepSORT can only be controlled from the local Kernel console" });
        }
        if (typeof req.body?.enabled !== "boolean") {
            return res.status(400).json({ error: "enabled must be a boolean" });
        }
        try {
            res.json(await service.setEnabled(req.body.enabled));
        } catch {
            res.status(503).json({ error: "Could not save the DeepSORT switch setting" });
        }
    });
}
