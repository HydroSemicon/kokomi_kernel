import { spawn } from "child_process";
import "dotenv/config";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JgWCVquTJEvtfo5gWQkx";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_v3";
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";

if (!ELEVENLABS_API_KEY) {
  throw new Error("ELEVENLABS_API_KEY is required. Set it in .env.");
}

const res = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
  {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: "水中の世界は陸の上ほど明るくはありませんが、あそこに留まる度、心がゆっくりと落ち着いていくような気がします。遠くには魚の群れが泳ぎ、そばにはクラゲが舞い、自分でも気づかないうちに、すべての心配事を置き去りにできるのです。機会があれば、あなたもそこに連れていってあげましょうか？",
      model_id: ELEVENLABS_MODEL_ID
    })
  }
);

if (!res.ok) {
  console.log(await res.text());
  throw new Error("TTS failed");
}

const buffer = Buffer.from(await res.arrayBuffer());

const ffplay = spawn("ffplay", [
  "-nodisp",
  "-autoexit",
  "-"
]);

ffplay.stdin.write(buffer);
ffplay.stdin.end();
