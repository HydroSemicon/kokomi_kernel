import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BeatsCoughBridge, detectorCommand } from "../src/perception/beats-cough-bridge.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: {
    "kernel-url": { type: "string" }, "detector-dir": { type: "string" }, python: { type: "string" },
    device: { type: "string" }, "inference-device": { type: "string" },
    head: { type: "string" }, "detector-config": { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
    console.log(`Usage: node tools/beats-cough-bridge.js [options]
  --kernel-url URL          Kernel origin (default http://127.0.0.1:3000)
  --detector-dir PATH       Detector repository (default ../embodied-YAMNet)
  --python PATH             Detector virtualenv Python executable
  --device INDEX           Explicit microphone index (list with sound-detector list-input-devices)
  --inference-device TYPE  cuda (default) or cpu
  --head PATH              Classifier head, relative to detector repository
  --detector-config PATH   Cough-only config, relative to detector repository
Uses KOKOMI_CONFIG_PATH when set. Polls the console switch every second.
For external-process mode only (coughDetection.managedProcess: false).
Ctrl+C stops the detector and releases its microphone.`);
} else {
    const config = JSON.parse(fs.readFileSync(process.env.KOKOMI_CONFIG_PATH
        ? path.resolve(process.env.KOKOMI_CONFIG_PATH) : path.join(root, "config.json"), "utf8"));
    if (config.coughDetection?.managedProcess !== false) {
        throw new Error("The Kernel now starts BEATs automatically. Use the console switch. For an external bridge, set coughDetection.managedProcess to false.");
    }
    const detector = config.coughDetection?.detector ?? {};
    const eventLog = path.resolve(root, path.dirname(config.persistence.eventLogPath), "beats", "cough-events.jsonl");
    const command = () => detectorCommand({
        detectorDirectory: values["detector-dir"] ? path.resolve(values["detector-dir"])
            : path.resolve(root, detector.directory ?? "../embodied-YAMNet"),
        python: values.python ? path.resolve(values.python) : detector.python ? path.resolve(root, detector.python) : undefined,
        inferenceDevice: values["inference-device"] ?? detector.inferenceDevice ?? "cuda", device: values.device ?? detector.device,
        head: values.head ?? detector.head, detectorConfig: values["detector-config"] ?? detector.config, eventLog });
    const bridge = new BeatsCoughBridge({ kernelUrl: values["kernel-url"] ?? `http://127.0.0.1:${config.server.port}`,
        routes: { beatsCough: "/api/perception/beats/cough", coughDetection: "/api/perception/beats/cough-detection",
            beatsHeartbeat: "/api/perception/beats/heartbeat", ...config.routes }, command });
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.error("BEATs bridge ready. Enable 咳検出 in the Kernel console.");
    try {
        while (!stopping) {
            await bridge.tick();
            if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    } finally { await bridge.close(); }
}
