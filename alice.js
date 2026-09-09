import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { BskyAgent } from "@atproto/api";
import fetch from "node-fetch";
import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
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

if (TTS_ENABLED && !ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required. Set it in .env.");
}

let latestSensor = {};
let page = null;
let ttsQueue = Promise.resolve();
let chatOperationQueue = Promise.resolve();
let blueskyAgent = null;
let blueskyLoginPromise = null;
const processedVisionEventIds = new Set();

/* ---------------------------
   Operations dashboard state
--------------------------- */
const kernelStartedAt = Date.now();
const dashboardDirectory = fileURLToPath(new URL("./dashboard", import.meta.url));
const dashboardClients = new Set();
const recentActivity = [];
let activitySequence = 0;

const serviceState = {
    kernel: { status: "online", label: "Kernel API", detail: `Port ${config.server.port}` },
    chatgpt: { status: "checking", label: "ChatGPT bridge", detail: "Connecting to browser" },
    bme280: { status: "checking", label: "Environment sensor", detail: "Waiting for first sample" },
    brightness: { status: "checking", label: "Brightness sensor", detail: "Waiting for first sample" },
    actuators: { status: "idle", label: "Actuators", detail: "No command sent yet" },
    vision: { status: "idle", label: "Vision snapshot", detail: "No request sent yet" },
    faceMemory: { status: "idle", label: "Face memory", detail: "No request sent yet" },
    tts: {
        status: TTS_ENABLED ? "idle" : "disabled",
        label: "Voice output",
        detail: TTS_ENABLED ? "Ready" : "Disabled in config",
    },
};

const endpointState = new Map([
    [config.routes.userInput, { method: "POST", label: "ユーザー入力", calls: 0, errors: 0 }],
    [config.routes.touchSensorInput, { method: "POST", label: "タッチセンサー", calls: 0, errors: 0 }],
    [config.routes.yoloEvent, { method: "POST", label: "人物認識イベント", calls: 0, errors: 0 }],
    ["/api/dashboard/status", { method: "GET", label: "監視スナップショット", calls: 0, errors: 0, trackActivity: false }],
    ["/api/dashboard/events", { method: "GET", label: "リアルタイム監視", calls: 0, errors: 0, trackActivity: false }],
    ["/api/dashboard/actions", { method: "POST", label: "デバイス手動操作", calls: 0, errors: 0 }],
]);

function nowIso() {
    return new Date().toISOString();
}

function broadcastDashboard(event, payload) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of dashboardClients) {
        client.write(message);
    }
}

function updateService(id, patch) {
    const current = serviceState[id];
    if (!current) return;

    const previousStatus = current.status;
    Object.assign(current, patch, { updatedAt: nowIso() });
    if (patch.status === "online") current.lastSuccessAt = current.updatedAt;
    if (patch.status === "offline" || patch.status === "degraded") current.lastErrorAt = current.updatedAt;

    broadcastDashboard("service", { id, ...current });
    if (previousStatus !== current.status && current.status !== "checking") {
        recordActivity({
            category: "system",
            status: current.status === "online" ? "success" : current.status,
            title: `${current.label}: ${current.status}`,
            summary: current.detail,
            service: id,
        });
    }
}

function recordActivity({ category, status = "success", title, summary = "", direction = null, endpoint = null, service = null, payload = null, durationMs = null }) {
    const item = {
        id: ++activitySequence,
        timestamp: nowIso(),
        category,
        status,
        title,
        summary,
        direction,
        endpoint,
        service,
        durationMs,
        payload,
    };
    recentActivity.unshift(item);
    if (recentActivity.length > 100) recentActivity.length = 100;
    broadcastDashboard("activity", item);
    return item;
}

function markEndpointRequest(route, statusCode, durationMs, payload) {
    const endpoint = endpointState.get(route);
    if (!endpoint) return;

    endpoint.calls += 1;
    endpoint.lastStatusCode = statusCode;
    endpoint.lastCalledAt = nowIso();
    endpoint.lastDurationMs = durationMs;
    if (statusCode >= 400) endpoint.errors += 1;
    if (endpoint.trackActivity === false) return;

    recordActivity({
        category: "api",
        status: statusCode < 400 ? "success" : "error",
        title: `${endpoint.method} ${route}`,
        summary: `${endpoint.label} · HTTP ${statusCode}`,
        direction: "inbound",
        endpoint: route,
        payload,
        durationMs,
    });
}

function publicSensorState() {
    return {
        temperature: readSensorField("temperature") ?? null,
        humidity: readSensorField("humidity") ?? null,
        pressure: readSensorField("pressure") ?? null,
        brightness: readSensorField("brightness") ?? null,
        units: SENSOR_UNITS,
        updatedAt: serviceState.bme280.lastSuccessAt || serviceState.brightness.lastSuccessAt || null,
    };
}

function publicDashboardState() {
    const services = Object.entries(serviceState).map(([id, service]) => ({ id, ...service }));
    const endpoints = [...endpointState.entries()].map(([route, endpoint]) => ({
        route,
        ...endpoint,
        health: endpoint.lastStatusCode >= 500 ? "degraded" : "online",
    }));
    const unhealthyCount = services.filter((service) => ["offline", "degraded"].includes(service.status)).length;

    return {
        generatedAt: nowIso(),
        kernel: {
            status: unhealthyCount === 0 ? "online" : "degraded",
            startedAt: new Date(kernelStartedAt).toISOString(),
            uptimeSeconds: Math.floor((Date.now() - kernelStartedAt) / 1000),
            port: config.server.port,
            version: "1.0.0",
        },
        services,
        endpoints,
        sensors: publicSensorState(),
        activity: recentActivity.slice(0, 60),
        capabilities: {
            ttsEnabled: TTS_ENABLED,
            actions: ["led_change", "tear"],
        },
    };
}

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

    updateService("tts", { status: "busy", detail: "Generating speech" });
    ttsQueue = ttsQueue
        .catch((err) => {
            console.error("previous TTS failed:", err.message);
        })
        .then(() => speakTextNow(text))
        .then(() => {
            updateService("tts", { status: "online", detail: "Last speech completed" });
        })
        .catch((err) => {
            updateService("tts", { status: "degraded", detail: err.message });
            throw err;
        });

    return ttsQueue;
}

/* ---------------------------
   BME280 polling
--------------------------- */
async function pollSensor() {
    const startedAt = Date.now();
    try {
        const res = await fetch(config.sensors.bme280Url);
        if (!res.ok) {
            console.log("sensor fetch error:", res.status);
            updateService("bme280", {
                status: "degraded",
                detail: `HTTP ${res.status}`,
                latencyMs: Date.now() - startedAt,
            });
            return;
        }
        latestSensor = {
            ...latestSensor,
            ...(await res.json()),
        };
        updateService("bme280", {
            status: "online",
            detail: "Receiving environment data",
            latencyMs: Date.now() - startedAt,
        });
        broadcastDashboard("sensors", publicSensorState());
    } catch (err) {
        console.log("sensor fetch failed:", err.message);
        updateService("bme280", {
            status: "offline",
            detail: err.message,
            latencyMs: Date.now() - startedAt,
        });
    }
}
setInterval(pollSensor, config.sensors.bme280PollIntervalMs);
pollSensor();

/* ---------------------------
   CdS polling
--------------------------- */
async function pollBrightnessSensor() {
    const startedAt = Date.now();
    try {
        const res = await fetch(config.sensors.brightnessUrl);
        if (!res.ok) {
            console.log("brightness sensor fetch error:", res.status);
            updateService("brightness", {
                status: "degraded",
                detail: `HTTP ${res.status}`,
                latencyMs: Date.now() - startedAt,
            });
            return;
        }
        const data = await res.json();
        const brightness = data[config.sensors.brightnessResponseFields[0]] ?? data[config.sensors.brightnessResponseFields[1]];
        if (typeof brightness !== "number" || !Number.isFinite(brightness)) {
            console.log("brightness sensor response missing brightness:", data);
            updateService("brightness", {
                status: "degraded",
                detail: "Response did not contain brightness",
                latencyMs: Date.now() - startedAt,
            });
            return;
        }
        latestSensor = {
            ...latestSensor,
            brightness,
        };
        updateService("brightness", {
            status: "online",
            detail: "Receiving brightness data",
            latencyMs: Date.now() - startedAt,
        });
        broadcastDashboard("sensors", publicSensorState());
    } catch (err) {
        console.log("brightness sensor fetch failed:", err.message);
        updateService("brightness", {
            status: "offline",
            detail: err.message,
            latencyMs: Date.now() - startedAt,
        });
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

        if (action.type === "remember_person") {
            if (!hasExactlyKeys(action.params, ["track_id", "name"])) {
                return "remember_person params must contain exactly track_id and name";
            }
            const trackId = action.params.track_id;
            if ((typeof trackId !== "string" && !Number.isInteger(trackId)) || String(trackId).trim() === "") {
                return "remember_person track_id must be a non-empty string or integer";
            }
            if (typeof action.params.name !== "string" || action.params.name.trim() === "") {
                return "remember_person name must be a non-empty string";
            }
            if (action.params.name.trim().length > config.faceMemory.maxNameLength) {
                return `remember_person name must be ${config.faceMemory.maxNameLength} characters or fewer`;
            }
            if ([...action.params.name].some((character) => character.charCodeAt(0) < 32)) {
                return "remember_person name must not contain control characters";
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
function enqueueChatOperation(operation) {
    const queued = chatOperationQueue.then(operation);
    chatOperationQueue = queued.catch(() => {});
    return queued;
}

async function sendJsonToChatGPTNow(obj) {
    if (!page) {
        throw new Error("ChatGPT page is not ready");
    }
    const json = JSON.stringify(obj);

    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: config.browser.inputTimeoutMs });
    const existingText = await page.$eval(
        CHAT_INPUT_SELECTOR,
        (element) => ("value" in element ? element.value : element.innerText) || "",
    );
    if (existingText.trim()) {
        await page.click(CHAT_INPUT_SELECTOR);
        await page.keyboard.down("Control");
        await page.keyboard.press("A");
        await page.keyboard.up("Control");
        await page.keyboard.press("Backspace");
    }
    await page.type(CHAT_INPUT_SELECTOR, json, { delay: config.browser.typeDelayMs });
    await page.waitForSelector(config.browser.enabledSendButtonSelector);
    await page.click(config.browser.sendButtonSelector);

    console.log("ChatGPT JSON sent:", json);
}

function sendJsonToChatGPT(obj) {
    const startedAt = Date.now();
    return enqueueChatOperation(() => sendJsonToChatGPTNow(obj))
        .then((result) => {
            updateService("chatgpt", { status: "online", detail: "Browser bridge connected" });
            recordActivity({
                category: "communication",
                status: "success",
                title: "Sent to ChatGPT",
                summary: "Kernel message delivered through the browser bridge",
                direction: "outbound",
                service: "chatgpt",
                payload: obj,
                durationMs: Date.now() - startedAt,
            });
            return result;
        })
        .catch((err) => {
            updateService("chatgpt", { status: "degraded", detail: err.message });
            recordActivity({
                category: "communication",
                status: "error",
                title: "ChatGPT delivery failed",
                summary: err.message,
                direction: "outbound",
                service: "chatgpt",
                payload: obj,
                durationMs: Date.now() - startedAt,
            });
            throw err;
        });
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
    const startedAt = Date.now();
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

        updateService("vision", {
            status: "online",
            detail: "Snapshot available",
            latencyMs: Date.now() - startedAt,
        });
        return { buffer, mimeType };
    } catch (err) {
        updateService("vision", {
            status: "offline",
            detail: err.message,
            latencyMs: Date.now() - startedAt,
        });
        throw err;
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

        console.log("ChatGPT image attachment detected");
        return { imagePath, tempDirectory };
    } catch (err) {
        await fs.promises.unlink(imagePath).catch(() => {});
        await fs.promises.rmdir(tempDirectory).catch(() => {});
        throw err;
    }
}

function scheduleVisionTempFileCleanup({ imagePath, tempDirectory }) {
    const timer = setTimeout(async () => {
        await fs.promises.unlink(imagePath).catch((err) => {
            console.error("vision temp image cleanup failed:", err.message);
        });
        await fs.promises.rmdir(tempDirectory).catch((err) => {
            console.error("vision temp directory cleanup failed:", err.message);
        });
    }, config.vision.tempFileRetentionMs);

    // Cleanup must not keep the Kernel process alive during shutdown.
    timer.unref();
}

async function sendVisionImageToChatGPT(request) {
    const snapshot = await fetchVisionSnapshot();
    await enqueueChatOperation(async () => {
        const temporaryFile = await attachImageToChatGPT(snapshot);
        try {
            await sendJsonToChatGPTNow({
                vision: {
                    task: request.params.task,
                    query: config.vision.defaultQuery,
                    input: "attached_image",
                },
            });
        } finally {
            // DOM.setFileInputFiles creates a path-backed File. ChatGPT reads it
            // asynchronously while uploading to files.oaiusercontent.com, so an
            // immediate unlink makes an otherwise valid upload fail.
            scheduleVisionTempFileCleanup(temporaryFile);
        }
    });
}

async function sendActionToPi(action) {
    const url =
        action.type === "tear"
            ? config.actions.tear.endpointUrl
            : config.actions.ledChange.endpointUrl;

    const startedAt = Date.now();
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        updateService("actuators", {
            status: "online",
            detail: `${action.type} command accepted`,
            latencyMs: Date.now() - startedAt,
        });
        recordActivity({
            category: "control",
            status: "success",
            title: action.type === "tear" ? "Tear mechanism command" : "LED color changed",
            summary: action.type === "tear" ? `Speed ${action.params.speed} · Duration ${action.params.duration}` : action.params.color,
            direction: "outbound",
            service: "actuators",
            payload: action,
            durationMs: Date.now() - startedAt,
        });
        console.log("executed action:", action, "status:", res.status);
    } catch (err) {
        updateService("actuators", {
            status: "offline",
            detail: err.message,
            latencyMs: Date.now() - startedAt,
        });
        recordActivity({
            category: "control",
            status: "error",
            title: "Actuator command failed",
            summary: err.message,
            direction: "outbound",
            service: "actuators",
            payload: action,
            durationMs: Date.now() - startedAt,
        });
        throw err;
    }
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

async function rememberPerson(action) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.faceMemory.requestTimeoutMs);

    try {
        const response = await fetch(config.faceMemory.enrollUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                track_id: String(action.params.track_id),
                name: action.params.name.trim(),
            }),
            signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`face enrollment failed: ${response.status} ${body.error || "unknown error"}`);
        }
        if (body.status !== "collecting" || !isPlainObject(body.person) || body.person.status !== "collecting") {
            throw new Error("face enrollment returned an unexpected response");
        }
        updateService("faceMemory", {
            status: "online",
            detail: "Enrollment request accepted",
            latencyMs: Date.now() - startedAt,
        });
        console.log("face enrollment started:", body.person);
    } catch (err) {
        updateService("faceMemory", {
            status: "offline",
            detail: err.message,
            latencyMs: Date.now() - startedAt,
        });
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function executeAction(action) {
    if (action.type === "bluesky_post") {
        await sendBlueskyPost(action);
        return;
    }

    if (action.type === "remember_person") {
        await rememberPerson(action);
        return;
    }

    await sendActionToPi(action);
}

function normalizeVisionIdentity(identity) {
    if (!isPlainObject(identity) || !hasExactlyKeys(identity, ["status", "person_id", "name", "distance", "threshold"])) {
        throw new Error("vision identity has an invalid shape");
    }
    if (!["pending", "recognized", "unknown", "unavailable"].includes(identity.status)) {
        throw new Error("vision identity status is invalid");
    }
    if (identity.person_id !== null && typeof identity.person_id !== "string") {
        throw new Error("vision identity person_id must be a string or null");
    }
    if (identity.name !== null && typeof identity.name !== "string") {
        throw new Error("vision identity name must be a string or null");
    }
    if (identity.distance !== null && (typeof identity.distance !== "number" || !Number.isFinite(identity.distance))) {
        throw new Error("vision identity distance must be a finite number or null");
    }
    if (typeof identity.threshold !== "number" || !Number.isFinite(identity.threshold) || identity.threshold <= 0) {
        throw new Error("vision identity threshold must be a positive finite number");
    }
    if (identity.status === "recognized") {
        if (!identity.person_id || !identity.name || identity.distance === null) {
            throw new Error("recognized vision identity requires person_id, name, and distance");
        }
        if (identity.distance > identity.threshold) {
            throw new Error("recognized vision identity distance exceeds threshold");
        }
    } else if (identity.person_id !== null || identity.name !== null || identity.distance !== null) {
        throw new Error("unrecognized vision identity must not contain identity data");
    }
    return { ...identity };
}

function normalizeVisionEvent(body) {
    if (!isPlainObject(body.event)) {
        throw new Error("vision event must be an object");
    }
    const event = body.event;
    const allowedKeys = ["event_id", "source", "type", "track_id", "timestamp", "identity", "message", "position"];
    if (Object.keys(event).some((key) => !allowedKeys.includes(key))) {
        throw new Error("vision event contains an unknown field");
    }
    for (const key of ["event_id", "source", "type", "track_id", "timestamp", "identity", "message"]) {
        if (!Object.prototype.hasOwnProperty.call(event, key)) {
            throw new Error(`vision event is missing ${key}`);
        }
    }
    if (event.source !== "deepsort") {
        throw new Error("vision event source must be deepsort");
    }
    if (typeof event.event_id !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(event.event_id)) {
        throw new Error("vision event event_id is invalid");
    }
    if (!["person_disappeared", "person_recognized", "person_unknown", "person_enrolled"].includes(event.type)) {
        throw new Error("vision event type is invalid");
    }
    if ((typeof event.track_id !== "string" && !Number.isInteger(event.track_id)) || String(event.track_id).trim() === "") {
        throw new Error("vision event track_id is invalid");
    }
    if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) {
        throw new Error("vision event timestamp is invalid");
    }
    if (typeof event.message !== "string" || event.message.trim() === "") {
        throw new Error("vision event message is invalid");
    }
    if (event.position !== undefined && !["left", "center", "right"].includes(event.position)) {
        throw new Error("vision event position is invalid");
    }

    const identity = normalizeVisionIdentity(event.identity);
    if (["person_recognized", "person_enrolled"].includes(event.type) && identity.status !== "recognized") {
        throw new Error(`${event.type} requires a recognized identity`);
    }
    if (event.type === "person_unknown" && identity.status !== "unknown") {
        throw new Error("person_unknown requires an unknown identity");
    }
    if (event.type === "person_disappeared" && !["recognized", "unknown"].includes(identity.status)) {
        throw new Error("person_disappeared requires a resolved identity");
    }

    const normalized = {
        event_id: event.event_id,
        source: event.source,
        type: event.type,
        track_id: String(event.track_id),
        timestamp: event.timestamp,
        identity,
        message: event.message,
    };
    if (event.position !== undefined) normalized.position = event.position;
    return normalized;
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

app.use((req, res, next) => {
    if (!endpointState.has(req.path)) return next();

    const startedAt = Date.now();
    res.on("finish", () => {
        markEndpointRequest(req.path, res.statusCode, Date.now() - startedAt, req.body);
    });
    return next();
});

app.use("/dashboard", express.static(dashboardDirectory, {
    extensions: ["html"],
    etag: true,
    maxAge: "5m",
}));

app.get("/", (req, res) => {
    res.redirect("/dashboard/");
});

app.get("/api/dashboard/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(publicDashboardState());
});

app.get("/api/dashboard/events", (req, res) => {
    res.set({
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
    });
    res.flushHeaders();
    dashboardClients.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(publicDashboardState())}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: nowIso() })}\n\n`);
    }, 15000);
    heartbeat.unref();

    req.on("close", () => {
        clearInterval(heartbeat);
        dashboardClients.delete(res);
    });
});

app.post("/api/dashboard/actions", async (req, res) => {
    const action = req.body;
    if (!isPlainObject(action) || !["led_change", "tear"].includes(action.type)) {
        return res.status(400).json({ error: "Dashboard supports only led_change and tear actions" });
    }

    const validationError = validateActions([action]);
    if (validationError) return res.status(400).json({ error: validationError });

    try {
        await executeAction(action);
        return res.json({ status: "OK" });
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
});

app.post(config.routes.yoloEvent, async (req, res) => {
    console.log("YOLO event:", req.body);
    if (!page) {
        return res.status(503).json({ error: "ChatGPT page is not ready" });
    }
    let event;
    try {
        event = normalizeVisionEvent(req.body);
    } catch (err) {
        console.log("rejected vision event:", err.message, req.body);
        return res.status(400).json({ error: err.message });
    }

    if (processedVisionEventIds.has(event.event_id)) {
        console.log("ignored duplicate vision event:", event.event_id);
        return res.status(200).json({ status: "duplicate_ignored" });
    }
    if (processedVisionEventIds.size >= 1000) {
        const oldestEventId = processedVisionEventIds.values().next().value;
        processedVisionEventIds.delete(oldestEventId);
    }
    processedVisionEventIds.add(event.event_id);

    try {
        await sendJsonToChatGPT({ event });
        return res.sendStatus(200);
    } catch (err) {
        processedVisionEventIds.delete(event.event_id);
        console.error("vision event delivery failed:", err.message);
        return res.status(503).json({ error: "ChatGPT delivery failed" });
    }
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
    recordActivity({
        category: "system",
        status: "success",
        title: "Kernel API started",
        summary: `Dashboard and API listening on port ${config.server.port}`,
        service: "kernel",
    });
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
        updateService("chatgpt", { status: "checking", detail: "Connecting to Chrome" });
        browser = await puppeteer.connect({ browserURL: REMOTE_DEBUGGING_URL });
    } catch (err) {
        updateService("chatgpt", { status: "offline", detail: err.message });
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
    updateService("chatgpt", { status: "online", detail: "Browser bridge connected" });
    console.log("ChatGPT input detected");

    let streamBuffer = "";
    const processedJsonTextsByMessage = new Map();

    await page.exposeFunction("onPartialOutput", async (messageId, text) => {
        streamBuffer = `${text}\n`;

        const extracted = extractCompleteJsonObjects(streamBuffer);
        streamBuffer = extracted.rest;
        let processedJsonTexts = processedJsonTextsByMessage.get(messageId);
        if (!processedJsonTexts) {
            processedJsonTexts = new Set();
            processedJsonTextsByMessage.set(messageId, processedJsonTexts);
        }

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
                recordActivity({
                    category: "audit",
                    status: "error",
                    title: "Invalid ChatGPT response",
                    summary: "Response was not valid JSON",
                    direction: "inbound",
                    service: "chatgpt",
                    payload: { raw: jsonText },
                });
                continue;
            }

            const audit = auditLLMJson(payload);
            if (!audit.ok) {
                console.log("rejected JSON:", audit.reason, payload);
                recordActivity({
                    category: "audit",
                    status: "error",
                    title: "ChatGPT response rejected",
                    summary: audit.reason,
                    direction: "inbound",
                    service: "chatgpt",
                    payload,
                });
                continue;
            }

            console.log("accepted JSON:", audit.payload);
            recordActivity({
                category: "communication",
                status: "success",
                title: "ChatGPT response accepted",
                summary: audit.payload.speech || `${(audit.payload.actions || []).length} actions · ${(audit.payload.requests || []).length} requests`,
                direction: "inbound",
                service: "chatgpt",
                payload: audit.payload,
            });
            await executeAuditedPayload(audit.payload);
        }
    });

    const startupAssistantTurnBoundary = await page.evaluate(({ assistantOutputSelector, outputPollIntervalMs }) => {
        const lastContents = new Map();

        function getMessageIdentity(container) {
            const message = container.closest('[data-message-author-role="assistant"]');
            const turn = container.closest('[data-testid^="conversation-turn-"]');
            const turnMatch = turn?.getAttribute("data-testid")?.match(/^conversation-turn-(\d+)$/);
            if (!message || !turnMatch) return null;

            return {
                messageId: message.getAttribute("data-message-id") || turnMatch[1],
                turnIndex: Number(turnMatch[1]),
            };
        }

        function getCurrentText(container) {
            return container.innerText.trim();
        }

        const initialContainers = [...document.querySelectorAll(assistantOutputSelector)];
        const startupTurnBoundary = initialContainers.reduce((highestTurn, container) => {
            const identity = getMessageIdentity(container);
            if (!identity) return highestTurn;

            lastContents.set(identity.messageId, getCurrentText(container));
            return Math.max(highestTurn, identity.turnIndex);
        }, -1);

        function pollTexts() {
            const containers = document.querySelectorAll(assistantOutputSelector);

            containers.forEach((container) => {
                const identity = getMessageIdentity(container);
                if (!identity) return;

                const currentText = getCurrentText(container);
                const lastText = lastContents.get(identity.messageId) || "";

                if (currentText && currentText !== lastText) {
                    lastContents.set(identity.messageId, currentText);

                    // ChatGPT lazily prepends historical turns when the user
                    // scrolls upward. Their DOM nodes are new, but their turn
                    // indexes are at or below the startup boundary.
                    if (identity.turnIndex <= startupTurnBoundary) return;

                    window.onPartialOutput(identity.messageId, currentText);
                }
            });
        }

        console.log("ChatGPT output monitor started");
        setInterval(pollTexts, outputPollIntervalMs);
        return startupTurnBoundary;
    }, {
        assistantOutputSelector: config.browser.assistantOutputSelector,
        outputPollIntervalMs: config.browser.outputPollIntervalMs,
    });
    console.log("ChatGPT output monitor started after turn:", startupAssistantTurnBoundary);
})().catch((err) => {
    updateService("chatgpt", { status: "offline", detail: err.message });
    console.error("ChatGPT bridge initialization failed:", err.message);
    console.error("Kernel API and dashboard remain available for diagnostics.");
});
