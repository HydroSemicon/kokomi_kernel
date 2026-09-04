import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { BskyAgent } from "@atproto/api";
import fetch from "node-fetch";
import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import "dotenv/config";

const config = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));

puppeteer.use(StealthPlugin());

const CHAT_INPUT_SELECTOR = config.browser.chatInputSelector;
const REMOTE_DEBUGGING_URL = config.browser.remoteDebuggingUrl;
const CHATGPT_URL = config.browser.chatgptUrl;
const VALID_TOP_LEVEL_FIELDS = new Set(config.audit.validTopLevelFields);
const VALID_EMOTIONS = new Set(config.audit.validEmotions);
const SENSOR_UNITS = config.sensors.units;

/* ---------------------------
   Touch sensor bindings
--------------------------- */
const TOUCH_SENSOR_BINDINGS = config.touch.sensorBindings;

const TTS_ENABLED = config.tts.enabled;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || config.tts.defaultVoiceId;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || config.tts.defaultModelId;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || config.tts.defaultOutputFormat;
const BSKY_IDENTIFIER = process.env.BSKY_IDENTIFIER;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD;

if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required. Set it in .env.");
}

let latestSensor = {};
let page = null;
let ttsQueue = Promise.resolve();
let blueskyAgent = null;
let blueskyLoginPromise = null;

/* ---------------------------
   ElevenLabs TTS
--------------------------- */
function streamToFfplay(body) {
    return new Promise(async (resolve, reject) => {
        const ffplay = spawn(config.tts.playerCommand, config.tts.playerArgs);

        ffplay.on("error", reject);
        ffplay.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffplay exited with code ${code}`));
            }
        });

        try {
            if (typeof body.getReader === "function") {
                const reader = body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!ffplay.stdin.write(Buffer.from(value))) {
                        await new Promise((drainResolve) => ffplay.stdin.once("drain", drainResolve));
                    }
                }
            } else {
                for await (const chunk of body) {
                    if (!ffplay.stdin.write(Buffer.from(chunk))) {
                        await new Promise((drainResolve) => ffplay.stdin.once("drain", drainResolve));
                    }
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

    const url = `${config.tts.baseUrl}/${ELEVENLABS_VOICE_ID}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
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

function speakTTS(text) {
    if (!TTS_ENABLED) {
        console.log("TTS skipped: disabled");
        return Promise.resolve();
    }

    ttsQueue = ttsQueue
        .catch((err) => {
            console.error("previous TTS failed:", err.message);
        })
        .then(() => speakTextNow(text));

    return ttsQueue;
}

/* ---------------------------
   BME280 polling
--------------------------- */
async function pollSensor() {
    try {
        const res = await fetch(config.sensors.bme280Url);
        if (!res.ok) {
            console.log("sensor fetch error:", res.status);
            return;
        }
        latestSensor = {
            ...latestSensor,
            ...(await res.json()),
        };
    } catch (err) {
        console.log("sensor fetch failed:", err.message);
    }
}
setInterval(pollSensor, config.sensors.bme280PollIntervalMs);
pollSensor();

/* ---------------------------
   CdS polling
--------------------------- */
async function pollBrightnessSensor() {
    try {
        const res = await fetch(config.sensors.brightnessUrl);
        if (!res.ok) {
            console.log("brightness sensor fetch error:", res.status);
            return;
        }
        const data = await res.json();
        const brightness = data[config.sensors.brightnessResponseFields[0]] ?? data[config.sensors.brightnessResponseFields[1]];
        if (typeof brightness !== "number" || !Number.isFinite(brightness)) {
            console.log("brightness sensor response missing brightness:", data);
            return;
        }
        latestSensor = {
            ...latestSensor,
            brightness,
        };
    } catch (err) {
        console.log("brightness sensor fetch failed:", err.message);
    }
}
setInterval(pollBrightnessSensor, config.sensors.brightnessPollIntervalMs);
pollBrightnessSensor();

/* ---------------------------
   JSON stream extraction and audit
--------------------------- */
function extractCompleteJsonObjects(buffer) {
    const objects = [];
    let firstObjectStart = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStart = -1;
    let consumedUntil = 0;

    for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i];

        if (objectStart === -1) {
            if (char === "{") {
                objectStart = i;
                if (firstObjectStart === -1) firstObjectStart = i;
                depth = 1;
                inString = false;
                escapeNext = false;
            }
            continue;
        }

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\") {
            if (inString) escapeNext = true;
            continue;
        }

        if (char === "\"") {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                objects.push(buffer.slice(objectStart, i + 1));
                consumedUntil = i + 1;
                objectStart = -1;
            }
        }
    }

    if (objectStart !== -1) {
        return {
            objects,
            rest: buffer.slice(objectStart),
        };
    }

    return {
        objects,
        rest: consumedUntil > 0 ? buffer.slice(consumedUntil) : "",
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(obj, keys) {
    const actual = Object.keys(obj);
    return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validateSpeech(payload) {
    const hasSpeech = Object.prototype.hasOwnProperty.call(payload, "speech");
    const hasEmotion = Object.prototype.hasOwnProperty.call(payload, "emotion");
    const hasIntensity = Object.prototype.hasOwnProperty.call(payload, "intensity");

    if (!hasSpeech) {
        if (hasEmotion || hasIntensity) {
            return "emotion and intensity must not exist without speech";
        }
        return null;
    }

    if (!hasEmotion || !hasIntensity) {
        return "speech requires emotion and intensity";
    }
    if (typeof payload.speech !== "string") {
        return "speech must be a string";
    }
    if (!VALID_EMOTIONS.has(payload.emotion)) {
        return "emotion is invalid";
    }
    if (typeof payload.intensity !== "number" || !Number.isFinite(payload.intensity)) {
        return "intensity must be a finite number";
    }
    if (payload.intensity < config.audit.intensityMin || payload.intensity > config.audit.intensityMax) {
        return `intensity must be from ${config.audit.intensityMin.toFixed(1)} to ${config.audit.intensityMax.toFixed(1)}`;
    }

    return null;
}

function validateActions(actions) {
    if (!Array.isArray(actions)) {
        return "actions must be an array";
    }

    for (const action of actions) {
        if (!isPlainObject(action) || !hasExactlyKeys(action, ["type", "params"])) {
            return "each action must be an object with exactly type and params";
        }
        if (!isPlainObject(action.params)) {
            return "action params must be an object";
        }

        if (action.type === "tear") {
            if (!hasExactlyKeys(action.params, ["speed", "duration"])) {
                return "tear params must contain exactly speed and duration";
            }
            if (!Number.isInteger(action.params.speed) || action.params.speed < config.actions.tear.speedMin || action.params.speed > config.actions.tear.speedMax) {
                return `tear speed must be an integer from ${config.actions.tear.speedMin} to ${config.actions.tear.speedMax}`;
            }
            if (!Number.isInteger(action.params.duration) || action.params.duration < config.actions.tear.durationMin || action.params.duration > config.actions.tear.durationMax) {
                return `tear duration must be an integer from ${config.actions.tear.durationMin} to ${config.actions.tear.durationMax}`;
            }
            continue;
        }

        if (action.type === "led_change") {
            if (!hasExactlyKeys(action.params, ["color"])) {
                return "led_change params must contain exactly color";
            }
            if (typeof action.params.color !== "string" || !new RegExp(config.actions.ledChange.colorPattern).test(action.params.color)) {
                return "led_change color must be #RRGGBB";
            }
            continue;
        }

        if (action.type === "bluesky_post") {
            if (!hasExactlyKeys(action.params, ["text"])) {
                return "bluesky_post params must contain exactly text";
            }
            if (typeof action.params.text !== "string" || action.params.text.trim() === "") {
                return "bluesky_post text must be a non-empty string";
            }
            if (action.params.text.length > config.actions.blueskyPost.maxTextLength) {
                return `bluesky_post text must be ${config.actions.blueskyPost.maxTextLength} characters or fewer`;
            }
            continue;
        }

        return `unknown action type: ${action.type}`;
    }

    return null;
}

function validateRequests(requests) {
    if (!Array.isArray(requests)) {
        return "requests must be an array";
    }

    const validSensorRequests = new Set(Object.keys(config.sensors.units));

    for (const request of requests) {
        if (typeof request === "string") {
            if (!validSensorRequests.has(request)) {
                return `unknown request: ${request}`;
            }
            continue;
        }

        if (!isPlainObject(request) || !hasExactlyKeys(request, ["type", "params"])) {
            return "object request must contain exactly type and params";
        }
        if (request.type !== "vision") {
            return `unknown request type: ${request.type}`;
        }
        if (!isPlainObject(request.params) || !hasExactlyKeys(request.params, ["task"])) {
            return "vision params must contain exactly task";
        }
        if (request.params.task !== config.vision.task) {
            return `vision task must be ${config.vision.task}`;
        }
    }

    return null;
}

function auditLLMJson(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, reason: "payload must be a JSON object" };
    }

    for (const field of Object.keys(payload)) {
        if (!VALID_TOP_LEVEL_FIELDS.has(field)) {
            return { ok: false, reason: `unknown top-level field: ${field}` };
        }
    }

    if (!("speech" in payload) && !("actions" in payload) && !("requests" in payload)) {
        return { ok: false, reason: "payload must include speech, actions, or requests" };
    }

    const speechError = validateSpeech(payload);
    if (speechError) return { ok: false, reason: speechError };

    if ("actions" in payload) {
        const actionsError = validateActions(payload.actions);
        if (actionsError) return { ok: false, reason: actionsError };
    }

    if ("requests" in payload) {
        const requestsError = validateRequests(payload.requests);
        if (requestsError) return { ok: false, reason: requestsError };
    }

    return { ok: true, payload };
}

/* ---------------------------
   Kernel output
--------------------------- */
async function sendJsonToChatGPT(obj) {
    if (!page) {
        console.log("ChatGPT send skipped: page is not ready", obj);
        return;
    }
    const json = JSON.stringify(obj);

    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: config.browser.inputTimeoutMs });
    await page.type(CHAT_INPUT_SELECTOR, json, { delay: config.browser.typeDelayMs });
    await page.waitForSelector(config.browser.enabledSendButtonSelector);
    await page.click(config.browser.sendButtonSelector);

    console.log("ChatGPT JSON sent:", json);
}

function getVisionMimeType(contentType, buffer) {
    const mimeType = contentType?.split(";", 1)[0].trim().toLowerCase();
    if (mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp") {
        return mimeType;
    }

    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
        return "image/webp";
    }

    throw new Error(`snapshot returned unsupported content type: ${contentType || "missing"}`);
}

async function fetchVisionSnapshot() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.vision.snapshotTimeoutMs);

    try {
        console.log("fetching snapshot for ChatGPT...");
        const response = await fetch(config.vision.snapshotUrl, {
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`snapshot fetch failed: ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
            throw new Error("snapshot was empty");
        }
        if (buffer.length > config.vision.maxImageBytes) {
            throw new Error(`snapshot exceeded ${config.vision.maxImageBytes} bytes`);
        }
        const mimeType = getVisionMimeType(response.headers.get("content-type"), buffer);

        return { buffer, mimeType };
    } finally {
        clearTimeout(timeout);
    }
}

async function attachImageToChatGPT({ buffer, mimeType }) {
    if (!page) {
        throw new Error("ChatGPT page is not ready");
    }

    await page.bringToFront();
    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: config.browser.inputTimeoutMs });

    const attachmentStateBeforeUpload = await page.evaluate(({
        chatInputSelector,
        enabledSendButtonSelector,
    }) => {
        const input = document.querySelector(chatInputSelector);
        const composer = input?.closest("form") || input?.parentElement?.parentElement?.parentElement;
        const attachmentSelector = 'img, [data-testid*="attachment"], [data-testid*="file"]';
        return {
            attachmentCount: composer?.querySelectorAll(attachmentSelector).length || 0,
            sendEnabled: Boolean(document.querySelector(enabledSendButtonSelector)),
        };
    }, {
        chatInputSelector: CHAT_INPUT_SELECTOR,
        enabledSendButtonSelector: config.browser.enabledSendButtonSelector,
    });

    const extensionByMimeType = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    };
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "alice-vision-"));
    const imagePath = path.join(tempDirectory, `snapshot${extensionByMimeType[mimeType]}`);

    try {
        await fs.promises.writeFile(imagePath, buffer);
        const fileInput = await page.waitForSelector(config.browser.imageUploadSelector, {
            timeout: config.browser.inputTimeoutMs,
        });
        if (!fileInput) {
            throw new Error("ChatGPT image upload input was not found");
        }

        // ElementHandle.uploadFile uses CDP's DOM.setFileInputFiles internally.
        // This avoids OS clipboard permissions while producing the same attached
        // image state as pasting or selecting a file in the ChatGPT composer.
        await fileInput.uploadFile(imagePath);

        await page.waitForFunction(({
            chatInputSelector,
            enabledSendButtonSelector,
            before,
        }) => {
            const input = document.querySelector(chatInputSelector);
            const composer = input?.closest("form") || input?.parentElement?.parentElement?.parentElement;
            const attachmentSelector = 'img, [data-testid*="attachment"], [data-testid*="file"]';
            const attachmentCount = composer?.querySelectorAll(attachmentSelector).length || 0;
            const sendEnabled = Boolean(document.querySelector(enabledSendButtonSelector));

            return attachmentCount > before.attachmentCount || (!before.sendEnabled && sendEnabled);
        }, {
            timeout: config.vision.attachmentTimeoutMs,
        }, {
            chatInputSelector: CHAT_INPUT_SELECTOR,
            enabledSendButtonSelector: config.browser.enabledSendButtonSelector,
            before: attachmentStateBeforeUpload,
        });
    } finally {
        await fs.promises.unlink(imagePath).catch(() => {});
        await fs.promises.rmdir(tempDirectory).catch(() => {});
    }

    console.log("ChatGPT image attachment detected");
}

async function sendVisionImageToChatGPT(request) {
    const snapshot = await fetchVisionSnapshot();
    await attachImageToChatGPT(snapshot);
    await sendJsonToChatGPT({
        vision: {
            task: request.params.task,
            query: config.vision.defaultQuery,
            input: "attached_image",
        },
    });
}

async function sendActionToPi(action) {
    const url =
        action.type === "tear"
            ? config.actions.tear.endpointUrl
            : config.actions.ledChange.endpointUrl;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
    });

    console.log("executed action:", action, "status:", res.status);
}

async function getBlueskyAgent() {
    if (!BSKY_IDENTIFIER || !BSKY_PASSWORD) {
        throw new Error("BSKY_IDENTIFIER and BSKY_PASSWORD are required. Set them in .env.");
    }

    if (blueskyAgent) return blueskyAgent;
    if (!blueskyLoginPromise) {
        blueskyLoginPromise = (async () => {
            const agent = new BskyAgent({
                service: config.actions.blueskyPost.serviceUrl,
            });

            await agent.login({
                identifier: BSKY_IDENTIFIER,
                password: BSKY_PASSWORD,
            });

            blueskyAgent = agent;
            return agent;
        })().catch((err) => {
            blueskyLoginPromise = null;
            throw err;
        });
    }

    return blueskyLoginPromise;
}

async function sendBlueskyPost(action) {
    const text = action.params.text.trim();
    const agent = await getBlueskyAgent();

    await agent.post({ text });
    console.log("posted to Bluesky:", text);
}

async function executeAction(action) {
    if (action.type === "bluesky_post") {
        await sendBlueskyPost(action);
        return;
    }

    await sendActionToPi(action);
}

function readSensorField(field) {
    if (field === "temperature") {
        return latestSensor.temperature ?? latestSensor.temp;
    }
    return latestSensor[field];
}

function buildSensorResponse(requests) {
    const sensor = {};
    const units = {};

    for (const request of requests) {
        if (typeof request !== "string") continue;

        const value = readSensorField(request);
        if (typeof value !== "number" || !Number.isFinite(value)) {
            console.log("sensor field unavailable:", request);
            continue;
        }

        sensor[request] = value;
        units[request] = SENSOR_UNITS[request];
    }

    if (Object.keys(sensor).length === 0) return null;
    return { sensor, units };
}

async function executeAuditedPayload(payload) {
    if ("speech" in payload) {
        console.log("speech:", {
            speech: payload.speech,
            emotion: payload.emotion,
            intensity: payload.intensity,
        });
        speakTTS(payload.speech).catch((err) => {
            console.error("TTS failed:", err.message);
        });
    }

    if ("actions" in payload) {
        for (const action of payload.actions) {
            try {
                await executeAction(action);
            } catch (err) {
                console.error("action execution failed:", action, err.message);
            }
        }
    }

    if ("requests" in payload) {
        console.log("executed requests:", payload.requests);

        const sensorResponse = buildSensorResponse(payload.requests);
        if (sensorResponse) {
            await sendJsonToChatGPT(sensorResponse);
        } else if (payload.requests.some((request) => typeof request === "string")) {
            console.log("sensor response skipped: no requested sensor values available");
        }

        for (const request of payload.requests) {
            if (typeof request === "object" && request.type === "vision") {
                try {
                    await sendVisionImageToChatGPT(request);
                } catch (err) {
                    console.error("vision request failed:", err.message);
                }
            }
        }
    }
}

/* ---------------------------
   YOLO event listener
--------------------------- */
const app = express();
app.use(express.json());

app.post(config.routes.yoloEvent, async (req, res) => {
    console.log("YOLO event:", req.body);
    await sendJsonToChatGPT({
        event: config.events.personAppeared,
    });
    res.sendStatus(200);
});

app.post(config.routes.touchSensorInput, async (req, res) => {
    const event = req.body.event;

    if (!isPlainObject(event)) {
        console.log("rejected touch event: event must be an object", req.body);
        return res.status(400).json({ error: "event must be an object" });
    }
    if (event.source !== config.touch.source) {
        console.log("rejected touch event: invalid source", event);
        return res.status(400).json({ error: `source must be ${config.touch.source}` });
    }
    if (event.type !== config.touch.startedType && event.type !== config.touch.endedType) {
        console.log("rejected touch event: invalid type", event);
        return res.status(400).json({ error: "unknown touch event type" });
    }

    const bodyPart = TOUCH_SENSOR_BINDINGS[event.sensor_id];
    if (!bodyPart) {
        console.log("rejected touch event: unknown sensor_id", event.sensor_id);
        return res.status(400).json({ error: "unknown touch sensor" });
    }

    const semanticEvent = {
        event: {
            source: config.touch.source,
            action: event.type === config.touch.startedType ? config.touch.startedAction : config.touch.endedAction,
            body_part: bodyPart,
            timestamp: event.timestamp,
        },
    };

    console.log("accepted touch event:", semanticEvent);
    await sendJsonToChatGPT(semanticEvent);

    return res.json({ status: "OK" });
});

app.listen(config.server.port, () => {
    console.log(`YOLO event server listening on :${config.server.port}`);
});

/* ---------------------------
   User input endpoint
--------------------------- */
app.post(config.routes.userInput, async (req, res) => {
    const text = req.body.text;

    if (typeof text !== "string" || text.trim() === "") {
        return res.status(400).json({ error: "text must be a non-empty string" });
    }

    await sendJsonToChatGPT({
        user_input: text.trim(),
    });

    return res.json({ status: "OK" });
});

/* ==========================================================================
   LEGACY LLAVA START

   This path is intentionally kept for reference/fallback, but it is no longer
   called by the active vision request flow. The active flow pastes the camera
   image directly into ChatGPT so visual features and reasoning stay in the
   same multimodal model invocation.
============================================================================ */
async function runLLaVA(prompt) {
    const instruction = config.vision.instructionTemplate.replace("{maxWords}", config.vision.maxWords);
    console.log("fetching snapshot...");
    const img = await fetch(config.vision.snapshotUrl);
    if (!img.ok) throw new Error("snapshot fetch failed");

    const buffer = await img.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    console.log("running LLaVA...");
    const res = await fetch(config.vision.generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: config.vision.model,
            prompt: instruction + prompt,
            images: [base64],
            stream: config.vision.stream,
        }),
    });

    if (!res.ok) throw new Error(`LLaVA request failed: ${res.status}`);

    const data = await res.json();
    return data.response;
}
/* ============================ LEGACY LLAVA END ============================ */

/* ---------------------------
   Puppeteer boot and ChatGPT monitor
--------------------------- */
(async () => {
    let browser;
    try {
        browser = await puppeteer.connect({ browserURL: REMOTE_DEBUGGING_URL });
    } catch (err) {
        console.error(config.browser.chromeConnectErrorMessage);
        throw err;
    }

    const pages = await browser.pages();
    page = pages.find((browserPage) => {
        const url = browserPage.url();
        return config.browser.existingPageUrlIncludes.some((urlPart) => url.includes(urlPart));
    });

    if (!page) {
        page = await browser.newPage();
        await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    }

    await page.bringToFront();
    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: config.browser.inputTimeoutMs });
    console.log("ChatGPT input detected");

    let streamBuffer = "";
    const processedJsonTexts = new Set();

    await page.exposeFunction("onPartialOutput", async (text) => {
        streamBuffer = `${text}\n`;

        const extracted = extractCompleteJsonObjects(streamBuffer);
        streamBuffer = extracted.rest;

        for (const jsonText of extracted.objects) {
            if (processedJsonTexts.has(jsonText)) {
                continue;
            }
            processedJsonTexts.add(jsonText);

            let payload;
            try {
                payload = JSON.parse(jsonText);
                console.log("parsed JSON:", payload);
            } catch (err) {
                console.log("rejected JSON: invalid JSON", err.message, jsonText);
                continue;
            }

            const audit = auditLLMJson(payload);
            if (!audit.ok) {
                console.log("rejected JSON:", audit.reason, payload);
                continue;
            }

            console.log("accepted JSON:", audit.payload);
            await executeAuditedPayload(audit.payload);
        }
    });

    await page.evaluate(({ assistantOutputSelector, outputPollIntervalMs }) => {
        const lastContents = new Map();
        const ignoredInitialContainers = new WeakSet();
        let initialScanDone = false;

        function getCurrentText(container) {
            return container.innerText.trim();
        }

        function pollTexts() {
            const containers = document.querySelectorAll(assistantOutputSelector);

            if (!initialScanDone) {
                containers.forEach((container) => {
                    lastContents.set(container, getCurrentText(container));
                    ignoredInitialContainers.add(container);
                });
                initialScanDone = true;
                return;
            }

            containers.forEach((container) => {
                const currentText = getCurrentText(container);
                const lastText = lastContents.get(container) || "";

                if (currentText && currentText !== lastText) {
                    lastContents.set(container, currentText);
                    if (ignoredInitialContainers.has(container)) {
                        return;
                    }
                    window.onPartialOutput(currentText);
                }
            });
        }

        console.log("ChatGPT output monitor started");
        pollTexts();
        setInterval(pollTexts, outputPollIntervalMs);
    }, {
        assistantOutputSelector: config.browser.assistantOutputSelector,
        outputPollIntervalMs: config.browser.outputPollIntervalMs,
    });
})();
