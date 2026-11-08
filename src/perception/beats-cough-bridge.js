import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function detectorCommand({ detectorDirectory, python, inferenceDevice = "cuda", device,
    head = "artifacts/beats-cough-public/head_calibrated.npz",
    detectorConfig = "artifacts/beats-cough-public/config_calibrated.json", eventLog }) {
    const resolve = (file) => path.resolve(detectorDirectory, file);
    python ??= resolve(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    const checkpoint = resolve("checkpoints/BEATs_iter3+_AS2M.pt");
    const source = resolve("vendor/unilm/beats/BEATs.py");
    for (const file of [python, resolve(head), resolve(detectorConfig), checkpoint, source]) {
        if (!fs.existsSync(file)) throw new Error(`Missing detector file: ${file}`);
    }
    const settings = JSON.parse(fs.readFileSync(resolve(detectorConfig), "utf8"));
    if (settings.enabled_labels?.length !== 1 || settings.enabled_labels[0] !== "cough") {
        throw new Error("The BEATs bridge requires a cough-only detector configuration");
    }
    if (!["cpu", "cuda"].includes(inferenceDevice)) throw new Error("inference-device must be cpu or cuda");
    return { executable: python, args: ["-u", "-m", "daily_sound_detector.cli", "live", "--model", "beats_transfer",
        "--head", resolve(head), "--checkpoint", checkpoint, "--beats-source", source,
        "--config", resolve(detectorConfig), "--event-log", eventLog,
        "--inference-device", inferenceDevice, "--stdout-jsonl", ...(device == null ? [] : ["--device", String(device)])],
    cwd: detectorDirectory };
}

export function configuredDetectorCommand(config, repositoryDirectory) {
    const detector = config.coughDetection?.detector ?? {};
    return detectorCommand({
        detectorDirectory: path.resolve(repositoryDirectory, detector.directory ?? "../embodied-YAMNet"),
        python: detector.python ? path.resolve(repositoryDirectory, detector.python) : undefined,
        inferenceDevice: detector.inferenceDevice ?? "cuda", device: detector.device,
        head: detector.head, detectorConfig: detector.config,
        eventLog: path.resolve(repositoryDirectory, path.dirname(config.persistence.eventLogPath), "beats", "cough-events.jsonl"),
    });
}

export class BeatsCoughBridge {
    constructor({ kernelUrl, routes, command, fetchImpl = fetch, spawnImpl = spawn,
        clock = () => Date.now(), log = (message) => console.error(`[BEATs] ${message}`) }) {
        Object.assign(this, { kernelUrl, routes, command, fetchImpl, spawnImpl, clock, log });
        this.child = null;
        this.generation = 0;
        this.status = "stopped";
        this.lastError = null;
        this.retryAt = 0;
        this.deliveryQueue = Promise.resolve();
        this.pending = 0;
        this.closed = false;
    }

    async request(route, body) {
        const response = await this.fetchImpl(new URL(route, this.kernelUrl), {
            ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
        });
        const result = await response.json();
        if (!response.ok) {
            const error = new Error(result.error || `HTTP ${response.status}`);
            error.retryable = response.status >= 500;
            throw error;
        }
        return result;
    }

    async tick() {
        if (this.closed || this.ticking) return;
        this.ticking = true;
        try {
            const settings = await this.request(this.routes.coughDetection);
            if (this.closed) return;
            if (!settings.enabled) await this.stopDetector();
            else if (!this.child && this.clock() >= this.retryAt) {
                try { this.startDetector(); }
                catch (error) {
                    this.status = "error";
                    this.lastError = error.message.slice(0, 500);
                    this.retryAt = this.clock() + 5000;
                    this.log(this.lastError);
                }
            }
            if (!this.closed) await this.request(this.routes.beatsHeartbeat, { status: this.status, error: this.lastError });
        } catch (error) {
            // A lost Kernel/control connection must not leave the microphone running.
            await this.stopDetector();
            this.log(`Kernel unavailable: ${error.message}`);
        } finally { this.ticking = false; }
    }

    startPolling() {
        if (this.closed || this.timer) return;
        this.timer = setInterval(() => this.tick(), 1000);
        this.timer.unref();
        this.tick();
    }

    startDetector() {
        const command = typeof this.command === "function" ? this.command() : this.command;
        const generation = ++this.generation;
        this.lastError = null;
        const child = this.spawnImpl(command.executable, command.args, {
            cwd: command.cwd, windowsHide: true, shell: false,
            env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        this.status = "running";
        this.log("Detector started (model loading may take a while)");
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => {
            if (this.child !== child || this.closed) return;
            try {
                const event = JSON.parse(line);
                if (event.label === "cough") this.enqueue(event, generation);
            } catch { this.log("Ignored non-JSON detector output"); }
        });
        let stderrTail = "";
        child.stderr.on("data", (chunk) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-500);
            this.log(chunk.toString().trim());
        });
        child.once("error", (error) => { this.lastError = error.message.slice(0, 500); });
        child.once("close", (code) => {
            lines.close();
            if (this.child !== child) return;
            this.child = null;
            this.status = "error";
            this.lastError ||= (stderrTail || `Detector exited with code ${code}`).slice(-500);
            this.retryAt = this.clock() + 5000;
            this.log(this.lastError);
        });
    }

    enqueue(event, generation) {
        if (this.pending >= 16) { this.log("Delivery queue full; dropped cough event"); return; }
        this.pending++;
        this.deliveryQueue = this.deliveryQueue.then(async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (generation !== this.generation || this.closed || !this.child) return;
                try {
                    const result = await this.request(this.routes.beatsCough, event);
                    this.log(`${event.event_id}: ${result.status}`);
                    return;
                } catch (error) {
                    if (error.retryable === false || attempt === 2) { this.log(`Cough delivery failed: ${error.message}`); return; }
                    await new Promise((resolve) => setTimeout(resolve, 300));
                }
            }
        }).finally(() => { this.pending--; });
    }

    async stopDetector() {
        const child = this.child;
        this.child = null;
        this.generation++;
        this.status = "stopped";
        this.lastError = null;
        this.retryAt = 0;
        if (!child) return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
            child.once("close", () => { clearTimeout(timer); resolve(); });
            child.kill();
        });
        this.log("Detector stopped; microphone released");
    }

    async close() {
        clearInterval(this.timer);
        this.timer = null;
        this.closed = true;
        await this.stopDetector();
        await this.deliveryQueue;
    }
}
