import fs from "node:fs/promises";
import path from "node:path";

const TOP_FIELDS = new Set(["schema_version", "set_id", "voice_id", "generator", "generator_model", "created_at", "clips"]);
const CLIP_FIELDS = new Set(["id", "kind", "text", "path", "duration_ms", "emotion", "intensity", "semantic_commitment"]);
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

export class FillerManifestError extends TypeError {}

function assertExactFields(value, allowed, label) {
    for (const field of Object.keys(value)) {
        if (!allowed.has(field)) throw new FillerManifestError(`unknown ${label} field: ${field}`);
    }
}

function withinDirectory(filePath, directory) {
    const relative = path.relative(directory, filePath);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function loadFillerManifest({
    manifestPath,
    maxClipDurationMs = 1200,
    validEmotions = [],
    allowEmpty = false,
} = {}) {
    const absoluteManifest = path.resolve(manifestPath);
    let manifest;
    try {
        manifest = JSON.parse(await fs.readFile(absoluteManifest, "utf8"));
    } catch (error) {
        throw new FillerManifestError(error.code === "ENOENT" ? "filler manifest does not exist" : "filler manifest is invalid JSON");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new FillerManifestError("filler manifest must be an object");
    assertExactFields(manifest, TOP_FIELDS, "manifest");
    if (manifest.schema_version !== "1.0") throw new FillerManifestError("unsupported filler manifest schema_version");
    if (typeof manifest.set_id !== "string" || !SAFE_ID.test(manifest.set_id)) throw new FillerManifestError("manifest set_id is invalid");
    if (!Array.isArray(manifest.clips) || (!allowEmpty && manifest.clips.length === 0)) throw new FillerManifestError("filler manifest must contain clips");

    const baseDirectory = path.dirname(absoluteManifest);
    const emotions = new Set(validEmotions);
    const ids = new Set();
    const clips = [];
    for (const clip of manifest.clips) {
        if (!clip || typeof clip !== "object" || Array.isArray(clip)) throw new FillerManifestError("filler clip must be an object");
        assertExactFields(clip, CLIP_FIELDS, "clip");
        if (typeof clip.id !== "string" || !SAFE_ID.test(clip.id) || ids.has(clip.id)) throw new FillerManifestError("filler clip id is invalid or duplicated");
        ids.add(clip.id);
        if (clip.kind !== "thinking" && clip.kind !== "listening") throw new FillerManifestError("filler clip kind is invalid");
        if (typeof clip.text !== "string" || !clip.text.trim()) throw new FillerManifestError("filler clip text is required");
        if (clip.semantic_commitment !== "none" && clip.semantic_commitment !== "attention_only") throw new FillerManifestError("filler semantic commitment is not allowed");
        if (clip.kind === "thinking" && clip.semantic_commitment !== "none") throw new FillerManifestError("thinking filler must have no semantic commitment");
        if (clip.kind === "listening" && clip.semantic_commitment !== "attention_only") throw new FillerManifestError("listening filler must be attention_only");
        if (!Number.isFinite(clip.duration_ms) || clip.duration_ms <= 0 || clip.duration_ms > maxClipDurationMs) throw new FillerManifestError("filler clip duration is invalid");
        if (!emotions.has(clip.emotion)) throw new FillerManifestError("filler clip emotion is invalid");
        if (!Number.isFinite(clip.intensity) || clip.intensity < 0 || clip.intensity > 1) throw new FillerManifestError("filler clip intensity is invalid");
        if (typeof clip.path !== "string" || path.extname(clip.path).toLowerCase() !== ".wav") throw new FillerManifestError("filler clip path must be WAV");
        const absolutePath = path.resolve(baseDirectory, clip.path);
        if (!withinDirectory(absolutePath, baseDirectory)) throw new FillerManifestError("filler clip path escapes the manifest directory");
        try {
            const stat = await fs.stat(absolutePath);
            if (!stat.isFile()) throw new Error("not a file");
        } catch {
            throw new FillerManifestError(`filler clip file is missing: ${clip.id}`);
        }
        clips.push(Object.freeze({ ...clip, absolutePath }));
    }
    return Object.freeze({ ...manifest, manifestPath: absoluteManifest, clips: Object.freeze(clips) });
}
