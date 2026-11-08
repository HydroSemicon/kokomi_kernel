import { BskyAgent } from "@atproto/api";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { BehaviorArchitecture } from "./src/behavior/index.js";
import { observationSearchText } from "./src/behavior/observation.js";
import { hasEnvironmentReading } from "./src/behavior/environment-text.js";
import { MemoryStore } from "./src/memory/memory-store.js";
import { normalizeExistingMemories } from "./src/memory/normalize-existing.js";
import { EventStore } from "./src/behavior/event-store.js";
import { ActionGate } from "./src/behavior/action-gate.js";
import { SocialStateStore } from "./src/social/social-state-store.js";
import { LlmResponseProtocol } from "./src/protocol/llm-response.js";
import WebSocket from "ws";
import { ConversationStore } from "./src/live/conversation-store.js";
import { LiveSessionService, LiveError } from "./src/live/session-service.js";
import { LiveKernelBridge } from "./src/live/kernel-bridge.js";
import { MemoryExtractor } from "./src/live/memory-extractor.js";
import { mountLiveRoutes } from "./src/live/http-routes.js";
import { bodyContext } from "./src/live/body-context.js";
import { ResponsesBackend } from "./src/live/responses-backend.js";
import { ApiDiagnostics } from "./src/live/api-diagnostics.js";

const config = JSON.parse(fs.readFileSync(process.env.KOKOMI_CONFIG_PATH
    ? path.resolve(process.env.KOKOMI_CONFIG_PATH) : new URL("./config.json", import.meta.url), "utf8"));

const SENSOR_UNITS = config.sensors.units;

/* ---------------------------
   Touch sensor bindings
--------------------------- */
const TOUCH_SENSOR_BINDINGS = config.touch.sensorBindings;

const LIVE_ENABLED = config.live?.enabled === true;
const BSKY_IDENTIFIER = process.env.BSKY_IDENTIFIER;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD;
const repositoryDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDiagnostics = new ApiDiagnostics(path.join(
    path.dirname(path.resolve(repositoryDirectory, config.live.conversationPath)), "live-api-diagnostics.jsonl"));
const logApi = (event, fields) => apiDiagnostics.record(event, fields);
const behaviorArchitecture = new BehaviorArchitecture({
    config: config.behavior,
});
const memoryStore = new MemoryStore({
    filePath: path.resolve(repositoryDirectory, config.memory.storagePath),
});
const memoryReady = memoryStore.initialize().then(() => LIVE_ENABLED
    ? normalizeExistingMemories(memoryStore, path.resolve(repositoryDirectory, config.live.conversationPath)) : undefined);
const eventStore = new EventStore({
    filePath: path.resolve(repositoryDirectory, config.persistence.eventLogPath),
    maxReplayEvents: config.persistence.maxReplayEvents,
    sensorCheckpointMs: config.persistence.sensorCheckpointMs,
});
const socialStore = new SocialStateStore({
    filePath: path.resolve(repositoryDirectory, config.social.storagePath),
    visiblePersonTtlMs: config.behavior.freshness.person_ms,
});
const actionGate = new ActionGate({
    config: config.actionGate,
    boundaryProvider: socialStore,
});
const responseProtocol = new LlmResponseProtocol(config);
const eventReady = eventStore.initialize();
const socialReady = socialStore.initialize();
const runtimeReady = Promise.all([memoryReady, socialReady, eventReady]).then(async ([, , observations]) => {
    for (const observation of observations) {
        behaviorArchitecture.observe(observation, { generateProposals: false });
        socialStore.observe(observation);
        if (observation.type === "action.intention") actionGate.restoreIntention(observation.payload);
        if (observation.type === "action.outcome") actionGate.restoreOutcome(observation.payload);
    }
    const interruptedTts = behaviorArchitecture.reconcileInterruptedTts();
    if (interruptedTts) {
        const observation = behaviorArchitecture.observe(
            interruptedTts,
            { generateProposals: false },
        ).observation;
        socialStore.observe(observation);
        await eventStore.append(observation, { force: true });
    }
    const interruptedFiller = behaviorArchitecture.reconcileInterruptedFiller();
    if (interruptedFiller) {
        const observation = behaviorArchitecture.observe(
            interruptedFiller,
            { generateProposals: false },
        ).observation;
        socialStore.observe(observation);
        await eventStore.append(observation, { force: true });
    }
    for (const outcome of actionGate.reconcileInterrupted()) {
        const observation = behaviorArchitecture.observe({
            type: "action.outcome",
            source: "kernel_recovery",
            observed_at: outcome.completed_at,
            payload: outcome,
        }, { generateProposals: false }).observation;
        socialStore.observe(observation);
        await eventStore.append(observation, { force: true });
    }
});

let latestSensor = {};
let liveService;
let liveBridge;
let memoryExtractor;
let lastMemoryTickAt = Date.now();
let lastLiveDiagnostic;
const controlInstructions = fs.readFileSync(new URL("./control_prompt.md", import.meta.url), "utf8");
const responsesBackend = new ResponsesBackend({
    config,
    apiKey: process.env.OPENAI_API_KEY,
    instructions: `Execution role: Responses backend.\n\n${controlInstructions}`,
    audit: (payload, options) => responseProtocol.audit(payload, options),
    onDiagnostic: logApi,
    onRequest: ({ error, durationMs }) => updateService("responses", {
        status: error ? "degraded" : "online", detail: error || config.responses.model, latencyMs: durationMs,
    }),
});
const conversationStore = new ConversationStore({
    filePath: path.resolve(repositoryDirectory, config.live.conversationPath),
    checkpointPath: path.resolve(repositoryDirectory, config.live.checkpointPath),
});
const conversationReady = conversationStore.initialize();
let blueskyAgent = null;
let blueskyLoginPromise = null;
const processedVisionEventIds = new Set();

async function ingestObservation(input, { forcePersist = false, persist = true } = {}) {
    await runtimeReady;
    const result = behaviorArchitecture.observe(input);
    socialStore.observe(result.observation);
    if (persist) await eventStore.append(result.observation, { force: forcePersist });
    broadcastDashboard("behavior", dashboardBehaviorSnapshot());
    return result;
}

async function buildCognitiveContext(input, { consumeProposals = true, minimumProposalPriority = 0 } = {}) {
    const { observation } = await ingestObservation(input, { forcePersist: true });
    const memories = memoryStore.retrieve(observationSearchText(observation), {
        limit: config.memory.retrievalLimit,
    });
    return behaviorArchitecture.composeContext(observation, {
        memories,
        social: socialStore.context(),
        actionGate: actionGate.snapshot(),
        consumeProposals: false,
        leaseProposals: consumeProposals,
        minimumProposalPriority,
    });
}

async function submitObservation(input, options) {
    const context = await buildCognitiveContext(input, options);
    await dispatchCognitiveContext(context);
    return context;
}

async function dispatchCognitiveContext(context, { releaseLeaseOnFailure = true, waitForResult = false } = {}) {
    const job = liveBridge.submitContext(context).then((result) => {
        behaviorArchitecture.acknowledgeProposalLease(context.turn_id);
        return result;
    }).catch((error) => {
        if (releaseLeaseOnFailure) behaviorArchitecture.releaseProposalLease(context.turn_id);
        updateService("responses", { status: "degraded", detail: error.message });
        recordActivity({ category: "communication", status: "error", title: "Responses request failed",
            summary: error.message, service: "responses" });
        throw error;
    });
    if (waitForResult) return job;
    job.catch(() => {}); // Sensor and behavior events acknowledge enqueueing.
}

/* ---------------------------
   Operations dashboard state
--------------------------- */
const kernelStartedAt = Date.now();
const dashboardDirectory = fileURLToPath(new URL("./dashboard", import.meta.url));
const dashboardClients = new Set();
const recentActivity = [];
let activitySequence = 0;

const serviceState = {
    live: { status: LIVE_ENABLED ? "idle" : "disabled", label: "Live conversation",
        detail: LIVE_ENABLED ? (process.env.OPENAI_API_KEY ? "Start from the dashboard" : "Set OPENAI_API_KEY") : "Disabled in config" },
    kernel: { status: "online", label: "Kernel API", detail: `Port ${config.server.port}` },
    responses: { status: process.env.OPENAI_API_KEY ? "idle" : "offline", label: "Responses API",
        detail: process.env.OPENAI_API_KEY ? config.responses.model : "Set OPENAI_API_KEY" },
    bme280: { status: "checking", label: "Environment sensor", detail: "Waiting for first sample" },
    brightness: { status: "checking", label: "Brightness sensor", detail: "Waiting for first sample" },
    actuators: { status: "idle", label: "Actuators", detail: "No command sent yet" },
    vision: { status: "idle", label: "Vision snapshot", detail: "No request sent yet" },
    faceMemory: { status: "idle", label: "Face memory", detail: "No request sent yet" },
};

const endpointState = new Map([
    [config.routes.userInput, { method: "POST", label: "ユーザー入力", calls: 0, errors: 0 }],
    [config.routes.touchSensorInput, { method: "POST", label: "タッチセンサー", calls: 0, errors: 0 }],
    [config.routes.yoloEvent, { method: "POST", label: "人物認識イベント", calls: 0, errors: 0 }],
    [config.routes.audioClassification, { method: "POST", label: "音声分類イベント", calls: 0, errors: 0 }],
    [config.routes.internalState, { method: "POST", label: "身体内部状態", calls: 0, errors: 0 }],
    [config.routes.behaviorState, { method: "GET", label: "行動状態スナップショット", calls: 0, errors: 0, trackActivity: false }],
    [config.routes.behaviorTick, { method: "POST", label: "自発行動ティック", calls: 0, errors: 0 }],
    [config.routes.memoryProposals, { method: "GET", label: "記憶候補一覧", calls: 0, errors: 0, trackActivity: false }],
    [config.routes.socialProposals, { method: "GET", label: "社会状態候補一覧", calls: 0, errors: 0, trackActivity: false }],
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

function recordActivity({ category, status = "success", title, summary = "", direction = null, endpoint = null, service = null, payload = null, durationMs = null, sources = null }) {
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
        ...(sources?.length ? { sources } : {}),
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

function dashboardBehaviorSnapshot() {
    const snapshot = behaviorArchitecture.snapshot();
    const partial = snapshot.state?.interaction?.asr_partial;
    if (partial?.value?.text) {
        partial.value = {
            ...partial.value,
            text_length: partial.value.text.length,
        };
        delete partial.value.text;
    }
    return snapshot;
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
        behavior: dashboardBehaviorSnapshot(),
        memory: {
            pendingProposalCount: memoryStore.list({ status: "pending" }).length,
            acceptedCount: memoryStore.list({ status: "accepted" }).length,
        },
        social: {
            ...socialStore.context(),
            pendingProposalCount: socialStore.list({ status: "pending" }).length,
        },
        actionGate: actionGate.snapshot(),
        live: liveService?.snapshot() ?? { status: "idle" },
        persistence: eventStore.snapshot(),
        activity: recentActivity.slice(0, 60),
        capabilities: {
            memoryEndpoint: config.routes.memoryProposals,
            live: { enabled: LIVE_ENABLED, iceTimeoutMs: config.live.iceTimeoutMs,
                silenceWarningSeconds: config.live.silenceWarningSeconds,
                silenceWarningRepeatSeconds: config.live.silenceWarningRepeatSeconds,
                silenceAudioLevel: config.live.silenceAudioLevel, audioStatsIntervalMs: config.live.audioStatsIntervalMs,
                ready: Boolean(process.env.OPENAI_API_KEY) },
            actions: ["led_change", "tear"],
        },
    };
}

function liveBodyContext() {
    return bodyContext(behaviorArchitecture.snapshot(), config.live);
}

liveService = new LiveSessionService({
    config: config.live,
    apiKey: process.env.OPENAI_API_KEY,
    fetchImpl: fetch,
    socketFactory: (url, options) => new WebSocket(url, options),
    conversations: conversationStore,
    memory: memoryStore,
    bootstrap: async () => {
        const searchNotice = config.responses.webSearchEnabled ? "" : "\nこのセッションでは公開 Web 検索は利用できません。";
        return `Execution role: Live voice frontend.\n\n${controlInstructions}${searchNotice}`;
    },
    getContext: liveBodyContext,
    onDelegation: async (task) => {
        recordActivity({ category: "communication", direction: "inbound", service: "live",
            title: "Live delegation requested", summary: "Live requested a backend task" });
        try {
            await liveBridge.delegate(task);
        } catch (error) {
            if (liveService.isCurrent(task)) {
                recordActivity({ category: "communication", status: "error", service: "responses",
                    title: "Live delegation failed", summary: error.message });
            }
            throw error;
        }
    },
    onTranscript: (entry) => {
        if (entry.role !== "user") return;
        liveBridge.observeTranscript(entry);
        // Update interaction recency without turning every transcript fragment into an LLM request.
        return ingestObservation({ id: entry.id, type: "interaction.live_activity", source: "live",
            payload: { session_id: entry.session_id } }, { persist: false });
    },
    onStatus: (status) => {
        const diagnostic = { sessionId: status.sessionId, status: status.status,
            closeConfirmed: status.closeConfirmed, eventErrorCode: status.lastEventError?.code };
        const signature = JSON.stringify(diagnostic);
        if (signature !== lastLiveDiagnostic) {
            lastLiveDiagnostic = signature;
            logApi("live.state", diagnostic);
        }
        if (status.status === "active") lastMemoryTickAt = Date.now();
        updateService("live", { status: status.contextWarning ? "degraded" : status.status === "active" ? "online"
            : status.status === "error" ? "degraded" : status.status,
        label: "Live conversation", detail: status.lastError || status.contextWarning || status.status });
        broadcastDashboard("live", status);
    },
    onFlush: () => {
        if (config.memory.extraction.flushOnSessionEnd) memoryExtractor?.tick({ flush: true });
    },
});
liveBridge = new LiveKernelBridge({
    config: config.live, live: liveService, conversations: conversationStore, memory: memoryStore,
    buildContext: buildCognitiveContext, runBackend: (context, options) => responsesBackend.run(context, options),
    executeAction: executeGatedAction, snapshot: fetchVisionSnapshot,
    onRemember: () => memoryExtractor.tick({ flush: true }),
    search: config.responses.webSearchEnabled ? (query, valid) => responsesBackend.search(query, valid) : null,
    onSearch: ({ text, sources }) => recordActivity({ category: "communication", service: "responses",
        title: "Web search result", summary: text, sources }),
    onCamera: ({ fromTranscript }) => recordActivity({ category: "communication", service: "vision",
        title: "Camera request accepted", summary: fromTranscript ? "Matched a direct camera question in the transcript" : "Delegated by Live" }),
    query: async (request) => {
        if (typeof request === "string") {
            const environment = behaviorArchitecture.snapshot().world.environment;
            const fact = request === "temperature" ? environment.thermal_condition
                : request === "brightness" ? environment.lighting_condition : null;
            return { resource: request, status: fact?.status ?? "unavailable",
                result: fact?.status === "known" ? fact.value : null };
        }
        return buildKernelQueryResult(request);
    },
    onResult: (text, { error = false } = {}) => recordActivity({ category: "communication", service: "responses", direction: "inbound",
        status: error ? "error" : "success", title: error ? "Camera request failed" : "Backend result", summary: text }),
});
memoryExtractor = new MemoryExtractor({ config: config.memory.extraction, conversations: conversationStore,
    memory: memoryStore, run: (input) => liveBridge.extract(input),
    verify: (input) => liveBridge.verify(input), onDiagnostic: logApi,
    onStatus: (status) => {
        broadcastDashboard("memory_extraction", status);
        recordActivity({ category: "memory", service: "kernel", title: "Memory extraction",
            status: status.status === "error" ? "error" : "success", summary: status.message || status.status });
    },
});
if (LIVE_ENABLED) {
    let liveTickRunning = false;
    Promise.all([runtimeReady, conversationReady]).then(() => {
        if (conversationStore.snapshot().pendingFragments) memoryExtractor.tick({ flush: true });
    }).catch((error) => console.error("Live state initialization failed:", error.message));
    const liveTimer = setInterval(async () => {
        if (liveTickRunning) return;
        liveTickRunning = true;
        try {
            await Promise.all([runtimeReady, conversationReady]);
            await liveService.tick();
            if (memoryExtractor.flushRequested || (liveService.status === "active"
                && Date.now() - lastMemoryTickAt >= config.memory.extraction.intervalSeconds * 1000)
                || (memoryExtractor.retryAfter && Date.now() >= memoryExtractor.retryAfter)) {
                lastMemoryTickAt = Date.now();
                // Do not await Responses in the session heartbeat loop.
                memoryExtractor.tick();
            }
        } catch (error) {
            console.error("Live maintenance failed:", error.message);
        } finally { liveTickRunning = false; }
    }, config.live.stateSyncIntervalMs);
    liveTimer.unref();
}

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
        const data = await res.json();
        latestSensor = {
            ...latestSensor,
            ...data,
        };
        await ingestObservation({
            type: "sensor.environment_sample",
            source: "bme280",
            payload: {
                temperature: data.temperature ?? data.temp,
                humidity: data.humidity,
                pressure: data.pressure,
                units: SENSOR_UNITS,
            },
        });
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
        await ingestObservation({
            type: "sensor.brightness_sample",
            source: "cds",
            payload: {
                brightness,
                unit: SENSOR_UNITS.brightness,
            },
        });
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
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(obj, keys) {
    const actual = Object.keys(obj);
    return actual.length === keys.length && keys.every((key) => actual.includes(key));
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
        console.log("fetching camera snapshot for Responses...");
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
        return { accepted: true, status_code: res.status };
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

    const result = await agent.post({ text });
    console.log("posted to Bluesky:", text);
    return { accepted: true, uri: result?.uri ?? null };
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
        return { accepted: true, enrollment_status: body.person.status, track_id: String(action.params.track_id) };
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
        return sendBlueskyPost(action);
    }

    if (action.type === "remember_person") {
        return rememberPerson(action);
    }

    return sendActionToPi(action);
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

function buildKernelQueryResult(request) {
    const resource = request.params.resource;
    const behavior = behaviorArchitecture.snapshot();
    const result = {
        state: { ...behavior.state, environment: behavior.world.environment },
        world: behavior.world,
        drives: behavior.drives,
        social: socialStore.context(),
        memory: memoryStore.retrieve(request.params.query ?? "", { limit: config.memory.retrievalLimit })
            .filter((item) => !hasEnvironmentReading(item.content)),
        action: actionGate.snapshot(),
    }[resource];
    return { resource, result };
}

async function reportActionOutcome(outcome, { reportToLlm = config.outcomes.reportToLlm } = {}) {
    const observation = {
        type: "action.outcome",
        source: "kernel_action_gate",
        observed_at: outcome.completed_at,
        payload: outcome,
    };
    if (!reportToLlm) {
        await ingestObservation(observation);
        return;
    }
    try {
        await submitObservation(observation, { consumeProposals: false });
    } catch (error) {
        console.error("action outcome persisted but could not be reported to Responses:", error.message);
    }
}

async function executeGatedAction(action, { turnId, context, reportToLlm = true, valid = () => true } = {}) {
    const proposal = actionGate.propose({ turnId, action, context });
    if (!proposal.allowed) {
        const outcome = actionGate.deniedOutcome({
            turnId,
            action,
            reason: proposal.reason,
            hash: proposal.hash,
        });
        recordActivity({
            category: "control",
            status: "error",
            title: "Action denied by Kernel",
            summary: proposal.reason,
            direction: "outbound",
            service: "action-gate",
            payload: { action, outcome },
        });
        await reportActionOutcome(outcome, { reportToLlm });
        return outcome;
    }

    await ingestObservation({
        type: "action.intention",
        source: "kernel_action_gate",
        observed_at: proposal.intention.proposed_at,
        payload: proposal.intention,
    });

    let outcome;
    try {
        if (valid()) {
            const result = await executeAction(action);
            outcome = actionGate.close(proposal.intention, { status: "succeeded", result });
        } else {
            outcome = actionGate.close(proposal.intention, { status: "denied", error: "request_superseded" });
        }
    } catch (error) {
        outcome = actionGate.close(proposal.intention, { status: "failed", error: error.message });
    }
    await reportActionOutcome(outcome, { reportToLlm });
    return outcome;
}

/* ---------------------------
   YOLO event listener
--------------------------- */
const app = express();
app.use(express.json({ limit: "128kb" }));
mountLiveRoutes(app, { service: liveService, config: config.live,
    ready: Promise.all([runtimeReady, conversationReady]) });

app.use((req, res, next) => {
    if (!endpointState.has(req.path)) return next();

    const startedAt = Date.now();
    res.on("finish", () => {
        markEndpointRequest(
            req.path,
            res.statusCode,
            Date.now() - startedAt,
            req.body,
        );
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

    const validationError = responseProtocol.validateActions([action]);
    if (validationError) return res.status(400).json({ error: validationError });

    const turnId = `operator_${Date.now()}`;
    const outcome = await executeGatedAction(action, {
        turnId,
        context: {
            turn_id: turnId,
            trigger: { type: "interaction.operator_command", payload: action },
        },
        reportToLlm: false,
    });
    if (outcome.status === "succeeded") return res.json({ status: "OK", outcome });
    return res.status(outcome.status === "denied" ? 409 : 502).json({ error: outcome.error, outcome });
});

app.post(config.routes.yoloEvent, async (req, res) => {
    console.log("YOLO event:", req.body);
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
        await submitObservation({
            id: event.event_id,
            type: `vision.${event.type}`,
            source: event.source,
            observed_at: event.timestamp,
            payload: {
                track_id: event.track_id,
                identity: event.identity,
                message: event.message,
                ...(event.position ? { position: event.position } : {}),
            },
        });
        return res.sendStatus(200);
    } catch (err) {
        processedVisionEventIds.delete(event.event_id);
        console.error("vision event delivery failed:", err.message);
        return res.status(503).json({ error: "Backend delivery failed" });
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

    const action = event.type === config.touch.startedType ? config.touch.startedAction : config.touch.endedAction;
    const semanticEvent = {
        source: config.touch.source,
        action,
        body_part: bodyPart,
        timestamp: event.timestamp,
    };

    console.log("accepted touch event:", semanticEvent);
    try {
        await submitObservation({
            type: `touch.${action}`,
            source: config.touch.source,
            observed_at: event.timestamp,
            payload: { body_part: bodyPart },
        });
        return res.json({ status: "OK" });
    } catch (err) {
        console.error("touch event delivery failed:", err.message);
        return res.status(503).json({ error: "Backend delivery failed" });
    }
});

app.post(config.routes.audioClassification, async (req, res) => {
    const event = isPlainObject(req.body.event) ? req.body.event : req.body;
    if (typeof event.label !== "string" || !event.label.trim() || event.label.length > 100) {
        return res.status(400).json({ error: "label must be a non-empty string of at most 100 characters" });
    }
    if (event.level != null && !config.audio.allowedLevels.includes(event.level)) {
        return res.status(400).json({ error: `level must be one of ${config.audio.allowedLevels.join(", ")}` });
    }
    if (event.confidence != null && (typeof event.confidence !== "number" || event.confidence < 0 || event.confidence > 1)) {
        return res.status(400).json({ error: "confidence must be between 0 and 1" });
    }

    const input = {
        ...(typeof event.event_id === "string" ? { id: event.event_id } : {}),
        type: "audio.classification",
        source: typeof event.source === "string" ? event.source : config.audio.source,
        ...(event.timestamp ? { observed_at: event.timestamp } : {}),
        confidence: event.confidence ?? 1,
        payload: { label: event.label.trim(), level: event.level ?? null },
    };
    try {
        if (config.audio.forwardToLlm) await submitObservation(input);
        else await ingestObservation(input);
        return res.json({ status: "OK", forwarded_to_llm: config.audio.forwardToLlm });
    } catch (error) {
        return res.status(503).json({ error: error.message });
    }
});

app.post(config.routes.internalState, async (req, res) => {
    const signals = req.body.signals;
    if (!isPlainObject(signals) || Object.keys(signals).length === 0 || Object.keys(signals).length > 32) {
        return res.status(400).json({ error: "signals must be an object containing 1 to 32 values" });
    }
    for (const [name, value] of Object.entries(signals)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            return res.status(400).json({ error: "signal names must be lowercase identifiers and values must be between 0 and 1" });
        }
    }
    try {
        await ingestObservation({
            type: "internal.homeostasis_sample",
            source: typeof req.body.source === "string" ? req.body.source : "body_controller",
            ...(req.body.timestamp ? { observed_at: req.body.timestamp } : {}),
            payload: { signals },
        });
        return res.json({ status: "OK", drives: behaviorArchitecture.snapshot().drives });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.get(config.routes.behaviorState, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(behaviorArchitecture.snapshot());
});

async function runSpontaneousBehaviorTick() {
    const eligible = behaviorArchitecture.peekPendingProposals()
        .some((proposal) => proposal.priority >= config.behavior.spontaneous.minimum_priority);
    if (!eligible) return null;
    return submitObservation({
        type: "system.spontaneous_tick",
        source: "kernel",
        payload: { reason: "pending_behavior_proposal" },
    }, { minimumProposalPriority: config.behavior.spontaneous.minimum_priority });
}

app.post(config.routes.behaviorTick, async (req, res) => {
    try {
        const context = await runSpontaneousBehaviorTick();
        if (!context) return res.status(204).send();
        return res.json({ status: "sent", proposal_count: context.behavior_proposals?.length ?? 0 });
    } catch (err) {
        return res.status(503).json({ error: err.message });
    }
});

app.get(config.routes.memoryProposals, async (req, res) => {
    await memoryReady;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.set("Cache-Control", "no-store");
    res.json({ records: memoryStore.list({ status }) });
});

app.post(`${config.routes.memoryProposals}/:id/decision`, async (req, res) => {
    await memoryReady;
    try {
        const record = await memoryStore.decide(req.params.id, req.body.decision);
        if (!record) return res.status(404).json({ error: "memory proposal not found" });
        return res.json(record);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

app.get(config.routes.socialProposals, async (req, res) => {
    await socialReady;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.set("Cache-Control", "no-store");
    res.json({ records: socialStore.list({ status, kind }) });
});

app.post(`${config.routes.socialProposals}/:id/decision`, async (req, res) => {
    await socialReady;
    try {
        const record = await socialStore.decide(req.params.id, req.body.decision);
        if (!record) return res.status(404).json({ error: "social proposal not found" });
        return res.json(record);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

const kernelServer = app.listen(config.server.port, () => {
    console.log(`Kernel HTTP port: ${kernelServer.address().port}`);
    console.log(`YOLO event server listening on :${config.server.port}`);
    recordActivity({
        category: "system",
        status: "success",
        title: "Kernel API started",
        summary: `Dashboard and API listening on port ${config.server.port}`,
        service: "kernel",
    });
});

if (LIVE_ENABLED) {
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
        try {
            if (liveService.session && !liveService.session.closeConfirmed) await liveService.stop(liveService.session.token);
            await conversationStore.queue;
            await apiDiagnostics.queue;
        } finally { kernelServer.close(); process.exit(0); }
    });
}

if (config.behavior.spontaneous.enabled && config.behavior.spontaneous.armed) {
    let spontaneousTickRunning = false;
    const timer = setInterval(async () => {
        if (spontaneousTickRunning || !responsesBackend.apiKey) return;
        spontaneousTickRunning = true;
        try {
            await runSpontaneousBehaviorTick();
        } catch (err) {
            console.error("spontaneous behavior tick failed:", err.message);
        } finally {
            spontaneousTickRunning = false;
        }
    }, config.behavior.spontaneous.interval_ms);
    timer.unref();
} else if (config.behavior.spontaneous.enabled) {
    console.warn("spontaneous behavior is enabled but not armed; automatic ticks will not run");
}

/* ---------------------------
   User input endpoint
--------------------------- */
app.post(config.routes.userInput, async (req, res) => {
    const text = req.body?.text;

    if (typeof text !== "string" || text.trim() === "" || text.length > 2000) {
        return res.status(400).json({ error: "text must be a non-empty string of at most 2000 characters" });
    }

    try {
        const context = await buildCognitiveContext({
            type: "interaction.user_input",
            source: "user_input_api",
            payload: { text: text.trim() },
        });
        const result = await dispatchCognitiveContext(context, { waitForResult: true });
        return res.json({ status: "OK", result });
    } catch (err) {
        return res.status(503).json({ error: "Backend delivery failed" });
    }
});
