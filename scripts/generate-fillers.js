import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildElevenLabsTtsRequest } from "../src/speech/elevenlabs-tts.js";

const repositoryDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await fs.readFile(path.join(repositoryDirectory, "config.json"), "utf8"));
const outputDirectory = path.resolve(repositoryDirectory, config.filler.manifestPath, "..");
const apiKey = process.env.ELEVENLABS_API_KEY;
const voiceId = process.env.ELEVENLABS_VOICE_ID || config.tts.defaultVoiceId;
const modelId = process.env.ELEVENLABS_MODEL_ID || config.tts.defaultModelId;

if (!process.argv.includes("--execute")) {
    console.log("Dry run only. Add --execute to generate five ElevenLabs clips and consume API credits.");
    process.exit(0);
}
if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required in .env");

const definitions = [
    { id: "thinking_01", kind: "thinking", text: "んー", emotion: "thinking", intensity: 0.22, semantic_commitment: "none" },
    { id: "thinking_02", kind: "thinking", text: "ええと", emotion: "thinking", intensity: 0.2, semantic_commitment: "none" },
    { id: "thinking_03", kind: "thinking", text: "うーん", emotion: "thinking", intensity: 0.25, semantic_commitment: "none" },
    { id: "listening_01", kind: "listening", text: "うん", emotion: "calm", intensity: 0.18, semantic_commitment: "attention_only" },
    { id: "listening_02", kind: "listening", text: "うんうん", emotion: "calm", intensity: 0.2, semantic_commitment: "attention_only" },
];

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let outputText = "";
        let errorText = "";
        child.stdout.on("data", (chunk) => { outputText += chunk.toString(); });
        child.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
        child.once("error", () => reject(new Error(`${command} could not be started`)));
        child.once("close", (code) => code === 0 ? resolve(outputText) : reject(new Error(`${command} exited with code ${code}: ${errorText.slice(0, 300)}`)));
    });
}

async function durationMs(filePath) {
    const text = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
    const seconds = Number.parseFloat(text.trim());
    if (!Number.isFinite(seconds)) throw new Error(`Could not measure ${path.basename(filePath)}`);
    return Math.round(seconds * 1000);
}

await fs.mkdir(outputDirectory, { recursive: true });
const clips = [];
for (const definition of definitions) {
    const ttsConfig = { ...config.tts, defaultModelId: modelId };
    const prepared = buildElevenLabsTtsRequest(definition, ttsConfig);
    const url = `${config.tts.baseUrl}/${voiceId}?output_format=mp3_44100_128`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(prepared.body),
    });
    if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status} for ${definition.id}`);
    const mp3Path = path.join(outputDirectory, `${definition.id}.mp3`);
    const wavPath = path.join(outputDirectory, `${definition.id}.wav`);
    await fs.writeFile(mp3Path, Buffer.from(await response.arrayBuffer()));
    try {
        await run("ffmpeg", [
            "-y", "-loglevel", "error", "-i", mp3Path,
            "-af", "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:stop_periods=-1:stop_duration=0.08:stop_threshold=-45dB",
            "-ac", "1", "-ar", "44100", wavPath,
        ]);
    } finally {
        await fs.rm(mp3Path, { force: true });
    }
    const measuredDuration = await durationMs(wavPath);
    if (measuredDuration > config.filler.maxClipDurationMs) {
        throw new Error(`${definition.id} is ${measuredDuration} ms; max is ${config.filler.maxClipDurationMs} ms`);
    }
    clips.push({
        ...definition,
        path: `${definition.id}.wav`,
        duration_ms: measuredDuration,
    });
    console.log(`Generated ${definition.id} (${measuredDuration} ms)`);
}

const manifest = {
    schema_version: "1.0",
    set_id: "kokomi-fillers-ja-v1",
    voice_id: voiceId,
    generator: "elevenlabs",
    generator_model: modelId,
    created_at: new Date().toISOString(),
    clips,
};
await fs.writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.join(outputDirectory, "manifest.json")}`);
