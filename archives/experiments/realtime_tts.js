import { spawn } from "child_process";
import fetch from "node-fetch";
import "dotenv/config";

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JgWCVquTJEvtfo5gWQkx";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_v3";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";

if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required. Set it in .env.");
}

let ttsQueue = Promise.resolve();

function streamToFfplay(body) {
    return new Promise(async (resolve, reject) => {
        const ffplay = spawn("ffplay", [
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "quiet",
            "-",
        ]);

        ffplay.on("error", reject);
        ffplay.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffplay exited with code ${code}`));
            }
        });

        const reader = body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!ffplay.stdin.write(Buffer.from(value))) {
                    await new Promise((drainResolve) => ffplay.stdin.once("drain", drainResolve));
                }
            }
            ffplay.stdin.end();
        } catch (err) {
            ffplay.stdin.destroy();
            reject(err);
        }
    });
}

async function speakTextNow(text) {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            text: trimmedText,
            model_id: ELEVENLABS_MODEL_ID,
        }),
    });

    if (!res.ok || !res.body) {
        const body = await res.text();
        throw new Error(`TTS failed: ${res.status} ${body}`);
    }

    await streamToFfplay(res.body);
}

export function speakTTS(text) {
    ttsQueue = ttsQueue
        .catch((err) => {
            console.error("previous TTS failed:", err.message);
        })
        .then(() => speakTextNow(text));

    return ttsQueue;
}
