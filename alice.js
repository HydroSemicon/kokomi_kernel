import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { BskyAgent } from "@atproto/api";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import fetch from "node-fetch";
import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { BehaviorArchitecture } from "./src/behavior/index.js";
import { observationSearchText } from "./src/behavior/observation.js";
import { MemoryStore } from "./src/memory/memory-store.js";
import { EventStore } from "./src/behavior/event-store.js";
import { ActionGate } from "./src/behavior/action-gate.js";
import { SocialStateStore } from "./src/social/social-state-store.js";
import { TurnRegistry } from "./src/behavior/turn-registry.js";
import { LlmResponseProtocol } from "./src/protocol/llm-response.js";
import { AsrTranscriptService, AsrValidationError } from "./src/speech/asr-transcript.js";
import { AsrTokenService } from "./src/speech/asr-token.js";
import { TtsEchoGuard } from "./src/speech/echo-guard.js";
import { ElevenLabsTtsProvider } from "./src/speech/elevenlabs-tts.js";
import { TtsAdapter } from "./src/speech/tts-adapter.js";
import { AsrCaptureCoordinator } from "./src/speech/asr-capture-coordinator.js";
import { PlaybackCoordinator } from "./src/speech/playback-coordinator.js";
import { AudioOutputLifecycle } from "./src/speech/audio-output-lifecycle.js";
import { loadFillerManifest } from "./src/speech/filler-manifest.js";
import { LocalClipPlayer } from "./src/speech/local-clip-player.js";
import { FillerController } from "./src/speech/filler-controller.js";

const config = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));

puppeteer.use(StealthPlugin());

const CHAT_INPUT_SELECTOR = config.browser.chatInputSelector;
const REMOTE_DEBUGGING_URL = config.browser.remoteDebuggingUrl;
const CHATGPT_URL = config.browser.chatgptUrl;
const SENSOR_UNITS = config.sensors.units;

/* ---------------------------
   Touch sensor bindings
--------------------------- */
const TOUCH_SENSOR_BINDINGS = config.touch.sensorBindings;

const TTS_ENABLED = config.tts.enabled;
const ASR_ENABLED = config.asr.enabled;
const FILLER_ENABLED = config.filler.enabled;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || config.tts.defaultVoiceId;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || config.tts.defaultModelId;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || config.tts.defaultOutputFormat;
const BSKY_IDENTIFIER = process.env.BSKY_IDENTIFIER;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD;
const repositoryDirectory = path.dirname(fileURLToPath(import.meta.url));
const behaviorArchitecture = new BehaviorArchitecture({
    config: config.behavior,
    asrPartialTtlMs: config.asr.partialTtlMs,
});
const memoryStore = new MemoryStore({
    filePath: path.resolve(repositoryDirectory, config.memory.storagePath),
});
const memoryReady = memoryStore.initialize();
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
const turnRegistry = new TurnRegistry({
    maxPending: config.audit.maxPendingTurns,
    ttlMs: config.audit.pendingTurnTtlMs,
});
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

if ((TTS_ENABLED || ASR_ENABLED) && !ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required. Set it in .env.");
}

let latestSensor = {};
let page = null;
let chatOperationQueue = Promise.resolve();
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

async function sendObservationToChatGPT(input, options) {
    const context = await buildCognitiveContext(input, options);
    await dispatchCognitiveContext(context);
    return context;
}

async function dispatchCognitiveContext(context, { releaseLeaseOnFailure = true } = {}) {
    turnRegistry.register(context);
    try {
        await sendJsonToChatGPT(context);
        behaviorArchitecture.acknowledgeProposalLease(context.turn_id);
    } catch (error) {
        turnRegistry.remove(context.turn_id);
        if (releaseLeaseOnFailure) behaviorArchitecture.releaseProposalLease(context.turn_id);
        throw error;
    }
    return context;
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
    asr: {
        status: ASR_ENABLED ? "idle" : "disabled",
        label: "Voice input",
        detail: ASR_ENABLED ? "Ready for client connection" : "Disabled in config",
    },
    filler: {
        status: FILLER_ENABLED ? "checking" : "disabled",
        label: "Local filler",
        detail: FILLER_ENABLED ? "Loading local clips" : "Disabled in config",
    },
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
    [config.routes.asrToken, { method: "POST", label: "ASR一時トークン", calls: 0, errors: 0 }],
    [config.routes.asrTranscript, { method: "POST", label: "ASR文字起こし", calls: 0, errors: 0 }],
    [config.routes.asrControl, { method: "GET", label: "ASR再生制御", calls: 0, errors: 0, trackActivity: false }],
    [config.routes.asrControlAck, { method: "POST", label: "ASR制御確認", calls: 0, errors: 0, trackActivity: false }],
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

function dashboardEndpointPayload(route, payload) {
    if (route !== config.routes.asrTranscript || !isPlainObject(payload)) return payload;
    const { text, ...safe } = payload;
    return { ...safe, text_length: typeof text === "string" ? text.length : 0 };
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

function publicAsrClientConfig() {
    return {
        enabled: ASR_ENABLED,
        modelId: config.asr.modelId,
        languageCode: config.asr.languageCode,
        commitStrategy: config.asr.commitStrategy,
        vadSilenceThresholdSecs: config.asr.vadSilenceThresholdSecs,
        minSpeechDurationMs: config.asr.minSpeechDurationMs,
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
        cognitiveTurns: turnRegistry.snapshot(),
        audio: {
            capture: asrCaptureCoordinator.snapshot(),
            playback: playbackCoordinator.snapshot(),
            filler: fillerController.snapshot(),
        },
        persistence: eventStore.snapshot(),
        activity: recentActivity.slice(0, 60),
        capabilities: {
            ttsEnabled: TTS_ENABLED,
            asrEnabled: ASR_ENABLED,
            asr: publicAsrClientConfig(),
            fillerEnabled: FILLER_ENABLED,
            actions: ["led_change", "tear"],
        },
    };
}

/* ---------------------------
   ElevenLabs TTS
--------------------------- */
const echoGuard = new TtsEchoGuard({ echoGuardMs: config.tts.echoGuardMs });
const asrCaptureCoordinator = new AsrCaptureCoordinator({
    ackTimeoutMs: config.asr.captureAckTimeoutMs,
    resumeGuardMs: config.asr.resumeGuardMs,
});
const playbackCoordinator = new PlaybackCoordinator();
const audioOutputLifecycle = new AudioOutputLifecycle({ playbackCoordinator, captureCoordinator: asrCaptureCoordinator });
let fillerManifest = null;
let fillerManifestError = null;
if (FILLER_ENABLED) {
    try {
        fillerManifest = await loadFillerManifest({
            manifestPath: path.resolve(repositoryDirectory, config.filler.manifestPath),
            maxClipDurationMs: config.filler.maxClipDurationMs,
            validEmotions: config.audit.validEmotions,
        });
    } catch (error) {
        fillerManifestError = error.message;
        console.warn(`Local filler disabled: ${error.message}`);
    }
}
const fillerPlayer = new LocalClipPlayer({
    command: config.filler.playerCommand,
    args: config.filler.playerArgs,
    spawnImpl: spawn,
});
const fillerController = new FillerController({
    config: { ...config.filler, armed: config.filler.armed && Boolean(fillerManifest) },
    manifest: fillerManifest,
    player: fillerPlayer,
    outputLifecycle: audioOutputLifecycle,
    echoGuard,
    onObservation: async (input) => {
        await ingestObservation(input, { forcePersist: true });
        const status = input.payload.status;
        updateService("filler", {
            status: status === "failed" ? "degraded" : status === "started" ? "busy" : "online",
            detail: `${input.payload.kind ?? "filler"} ${status}: ${input.payload.reason ?? ""}`.trim(),
        });
        recordActivity({
            category: "communication",
            status: status === "failed" ? "error" : ["cancelled", "suppressed"].includes(status) ? "skipped" : "success",
            title: `Filler ${status}`,
            summary: `${input.payload.kind ?? "unknown"} · ${input.payload.reason ?? ""}`,
            service: "filler",
            payload: input.payload,
        });
    },
});
updateService("filler", {
    status: !FILLER_ENABLED ? "disabled" : fillerManifest ? "online" : "degraded",
    detail: !FILLER_ENABLED ? "Disabled in config" : fillerManifest ? `Loaded ${fillerManifest.clips.length} local clips` : fillerManifestError,
});
const ttsProvider = new ElevenLabsTtsProvider({
    config: {
        ...config.tts,
        defaultVoiceId: ELEVENLABS_VOICE_ID,
        defaultModelId: ELEVENLABS_MODEL_ID,
        defaultOutputFormat: ELEVENLABS_OUTPUT_FORMAT,
    },
    apiKey: ELEVENLABS_API_KEY,
    fetchImpl: fetch,
    spawnImpl: spawn,
});
const ttsAdapter = new TtsAdapter({
    enabled: TTS_ENABLED,
    provider: ttsProvider,
    validEmotions: config.audit.validEmotions,
    intensityMin: config.audit.intensityMin,
    intensityMax: config.audit.intensityMax,
    echoGuard,
    outputLifecycle: audioOutputLifecycle,
    onObservation: async (input) => {
        await ingestObservation(input, { forcePersist: true });
        const status = input.payload.status;
        updateService("tts", {
            status: status === "failed" ? "degraded" : status === "skipped" ? "disabled" : status === "completed" ? "online" : "busy",
            detail: status === "failed" ? input.payload.error : `Speech output ${status}`,
        });
        recordActivity({
            category: "communication",
            status: status === "failed" ? "error" : status === "skipped" ? "skipped" : "success",
            title: `TTS ${status}`,
            summary: `${input.payload.emotion} · intensity ${input.payload.intensity}`,
            service: "tts",
            payload: input.payload,
        });
    },
});

function speakTTS(request) {
    return ttsAdapter.speak(request);
}

const elevenlabsClient = ELEVENLABS_API_KEY
    ? new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY })
    : null;
const asrTokenService = new AsrTokenService({
    enabled: ASR_ENABLED,
    provider: config.asr.provider,
    modelId: config.asr.modelId,
    loopbackOnly: config.asr.tokenRouteLoopbackOnly,
    apiKey: ELEVENLABS_API_KEY,
    client: elevenlabsClient,
});
const asrTranscriptService = new AsrTranscriptService({
    config: config.asr,
    ingestPartial: async (input, options) => {
        await fillerController.userSpeechStarted({
            sessionId: input.payload.session_id,
            segmentId: input.payload.segment_id,
        });
        fillerController.observePartial({
            sessionId: input.payload.session_id,
            segmentId: input.payload.segment_id,
            revision: input.payload.revision,
            text: input.payload.text,
            observedAt: input.observed_at,
        });
        await ingestObservation(input, options);
        updateService("asr", { status: "online", detail: "Receiving partial speech" });
        recordActivity({
            category: "communication",
            status: "success",
            title: "ASR partial updated",
            summary: `Session ${input.payload.session_id} · revision ${input.payload.revision}`,
            direction: "inbound",
            service: "asr",
            payload: {
                session_id: input.payload.session_id,
                segment_id: input.payload.segment_id,
                revision: input.payload.revision,
                text_length: input.payload.text.length,
            },
        });
    },
    prepareCommitted: (input) => {
        fillerController.commitSegment({
            sessionId: input.payload.asr.session_id,
            segmentId: input.payload.asr.segment_id,
        });
        return buildCognitiveContext(input);
    },
    dispatchCommitted: async (context) => {
        await dispatchCognitiveContext(context, { releaseLeaseOnFailure: false });
        const asr = context.trigger.payload.asr;
        fillerController.scheduleThinking({
            turnId: context.turn_id,
            sessionId: asr.session_id,
            segmentId: asr.segment_id,
            committedAt: context.trigger.observed_at,
        });
    },
    hasPersistedId: (eventId) => eventStore.has(eventId),
    echoGuard,
    isCapturePaused: (event, receivedAt) => asrCaptureCoordinator.shouldSuppress(event.observed_at ?? receivedAt),
    onCaptureSuppressed: async ({ event, receivedAt }) => {
        if (event.kind !== "committed") return;
        await ingestObservation({
            id: event.event_id,
            type: "speech.capture_suppressed",
            source: "kernel_capture_gate",
            observed_at: receivedAt,
            payload: {
                asr_event_id: event.event_id,
                session_id: event.session_id,
                segment_id: event.segment_id,
                capture_revision: asrCaptureCoordinator.snapshot().revision,
                reason: "audio_output_active",
            },
        }, { forcePersist: true });
        recordActivity({
            category: "communication",
            status: "skipped",
            title: "ASR capture suppressed",
            summary: "Transcript arrived while Kokomi audio output was active",
            direction: "inbound",
            service: "asr",
            payload: { event_id: event.event_id },
        });
    },
    onEchoSuppressed: async ({ event, echo, receivedAt }) => {
        await ingestObservation({
            id: event.event_id,
            type: "speech.echo_suppressed",
            source: "kernel_echo_guard",
            observed_at: receivedAt,
            payload: {
                asr_event_id: event.event_id,
                session_id: event.session_id,
                segment_id: event.segment_id,
                matched_turn_id: echo.turnId,
                method: echo.method,
                similarity: Math.round(echo.similarity * 1000) / 1000,
            },
        }, { forcePersist: true });
        recordActivity({
            category: "communication",
            status: "skipped",
            title: "ASR echo suppressed",
            summary: `Matched recent TTS by ${echo.method}`,
            direction: "inbound",
            service: "asr",
            payload: { event_id: event.event_id, similarity: echo.similarity },
        });
    },
});

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

function validateProposalEvidence(payload) {
    const proposals = [
        ...(payload.memory_proposals ?? []),
        ...(payload.social_proposals ?? []),
    ];
    for (const proposal of proposals) {
        for (const eventId of proposal.evidence_event_ids) {
            if (!eventStore.has(eventId)) return `proposal evidence event does not exist: ${eventId}`;
        }
    }
    return null;
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

    console.log("ChatGPT JSON sent:", {
        turn_id: obj.turn_id ?? null,
        trigger_type: obj.trigger?.type ?? obj.type,
        bytes: Buffer.byteLength(json, "utf8"),
    });
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
    const context = await buildCognitiveContext({
        type: "request.vision_input",
        source: "kernel",
        payload: {
            task: request.params.task,
            query: config.vision.defaultQuery,
            input: "attached_image",
        },
    });
    await enqueueChatOperation(async () => {
        const temporaryFile = await attachImageToChatGPT(snapshot);
        try {
            await sendJsonToChatGPTNow(context);
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

function buildKernelQueryResult(request) {
    const resource = request.params.resource;
    const behavior = behaviorArchitecture.snapshot();
    const result = {
        state: behavior.state,
        world: behavior.world,
        drives: behavior.drives,
        social: socialStore.context(),
        memory: memoryStore.retrieve(request.params.query ?? "", { limit: config.memory.retrievalLimit }),
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
        await sendObservationToChatGPT(observation, { consumeProposals: false });
    } catch (error) {
        console.error("action outcome persisted but could not be reported to ChatGPT:", error.message);
    }
}

async function executeGatedAction(action, { turnId, context, reportToLlm = true } = {}) {
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
        const result = await executeAction(action);
        outcome = actionGate.close(proposal.intention, { status: "succeeded", result });
    } catch (error) {
        outcome = actionGate.close(proposal.intention, { status: "failed", error: error.message });
    }
    await reportActionOutcome(outcome, { reportToLlm });
    return outcome;
}

async function executeAuditedPayload(payload, { context } = {}) {
    if ("memory_proposals" in payload && payload.memory_proposals.length > 0) {
        const added = await memoryStore.addProposals(payload.memory_proposals, { source: "chatgpt" });
        console.log("memory proposals queued for review:", added.map((record) => record.id));
        recordActivity({
            category: "memory",
            status: "success",
            title: "Memory proposals queued",
            summary: `${added.length} proposal(s) require Kernel review`,
            service: "kernel",
            payload: added,
        });
    }

    if ("social_proposals" in payload && payload.social_proposals.length > 0) {
        const added = await socialStore.addProposals(payload.social_proposals, { source: "chatgpt" });
        recordActivity({
            category: "social",
            status: "success",
            title: "Social proposals queued",
            summary: `${added.length} proposal(s) require Kernel review`,
            service: "kernel",
            payload: added,
        });
    }

    if ("speech" in payload) {
        console.log("speech:", {
            speech: payload.speech,
            emotion: payload.emotion,
            intensity: payload.intensity,
        });
        const speechGate = actionGate.evaluateSpeech(context);
        if (speechGate.allowed) {
            speakTTS({
                turnId: payload.turn_id,
                text: payload.speech,
                emotion: payload.emotion,
                intensity: payload.intensity,
            }).catch((err) => {
                console.error("TTS failed:", err.message);
            });
        } else {
            recordActivity({
                category: "control",
                status: "error",
                title: "Speech output denied by Kernel",
                summary: speechGate.reason,
                service: "action-gate",
                payload: { turn_id: payload.turn_id },
            });
        }
    }

    if ("actions" in payload) {
        for (const action of payload.actions) {
            const outcome = await executeGatedAction(action, {
                turnId: payload.turn_id,
                context,
            });
            console.log("action outcome:", outcome);
        }
    }

    if ("requests" in payload) {
        console.log("executed requests:", payload.requests);

        const sensorResponse = buildSensorResponse(payload.requests);
        if (sensorResponse) {
            await sendObservationToChatGPT({
                type: "request.sensor_result",
                source: "kernel",
                payload: sensorResponse,
            });
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
            if (typeof request === "object" && request.type === "kernel_query") {
                await sendObservationToChatGPT({
                    type: "request.kernel_result",
                    source: "kernel",
                    payload: buildKernelQueryResult(request),
                }, { consumeProposals: false });
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
        markEndpointRequest(
            req.path,
            res.statusCode,
            Date.now() - startedAt,
            dashboardEndpointPayload(req.path, req.body),
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

app.get(["/asr", "/asr/"], async (req, res) => {
    try {
        const clientPath = path.join(repositoryDirectory, "realtime_stt.html");
        const template = await fs.promises.readFile(clientPath, "utf8");
        const publicConfig = JSON.stringify(publicAsrClientConfig()).replace(/</gu, "\\u003c");
        res.type("html").set("Cache-Control", "no-store").send(
            template.replace('"__ALICE_ASR_CONFIG__"', publicConfig),
        );
    } catch {
        res.status(500).send("ASR client is unavailable");
    }
});

app.post(config.routes.asrToken, async (req, res) => {
    try {
        const payload = await asrTokenService.issue(req.socket.remoteAddress);
        updateService("asr", { status: "online", detail: "Client token issued" });
        return res.json({ ...payload, client_config: publicAsrClientConfig() });
    } catch (error) {
        const statusCode = error.statusCode ?? 502;
        updateService("asr", {
            status: statusCode === 403 ? "online" : statusCode === 503 ? "disabled" : "degraded",
            detail: error.message,
        });
        return res.status(statusCode).json({ error: error.message });
    }
});

app.post(config.routes.asrTranscript, async (req, res) => {
    if (!ASR_ENABLED) return res.status(503).json({ error: "ASR is disabled" });
    try {
        await runtimeReady;
        const result = await asrTranscriptService.handle(req.body);
        updateService("asr", {
            status: "online",
            detail: result.status === "accepted" ? `${result.kind} transcript accepted` : result.status,
        });
        return res.json(result);
    } catch (error) {
        if (error instanceof AsrValidationError) return res.status(400).json({ error: error.message });
        updateService("asr", { status: "degraded", detail: "Transcript delivery failed" });
        console.error("ASR transcript delivery failed:", error.message);
        return res.status(503).json({ error: "ChatGPT delivery failed" });
    }
});

app.get(config.routes.asrControl, (req, res) => {
    res.set({
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
    });
    res.flushHeaders();
    const clientId = asrCaptureCoordinator.connect((message) => res.write(message));
    req.on("close", () => asrCaptureCoordinator.disconnect(clientId));
});

app.post(config.routes.asrControlAck, (req, res) => {
    const accepted = asrCaptureCoordinator.acknowledge({
        clientId: req.body?.client_id,
        revision: req.body?.revision,
        paused: req.body?.paused,
    });
    if (!accepted) return res.status(409).json({ status: "stale_or_unknown_ack" });
    return res.json({ status: "accepted" });
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
        await sendObservationToChatGPT({
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

    const action = event.type === config.touch.startedType ? config.touch.startedAction : config.touch.endedAction;
    const semanticEvent = {
        source: config.touch.source,
        action,
        body_part: bodyPart,
        timestamp: event.timestamp,
    };

    console.log("accepted touch event:", semanticEvent);
    try {
        await sendObservationToChatGPT({
            type: `touch.${action}`,
            source: config.touch.source,
            observed_at: event.timestamp,
            payload: { body_part: bodyPart },
        });
        return res.json({ status: "OK" });
    } catch (err) {
        console.error("touch event delivery failed:", err.message);
        return res.status(503).json({ error: "ChatGPT delivery failed" });
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
        if (config.audio.forwardToLlm) await sendObservationToChatGPT(input);
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
    return sendObservationToChatGPT({
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

if (config.behavior.spontaneous.enabled && config.behavior.spontaneous.armed) {
    let spontaneousTickRunning = false;
    const timer = setInterval(async () => {
        if (spontaneousTickRunning || !page) return;
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
    const text = req.body.text;

    if (typeof text !== "string" || text.trim() === "" || text.length > 2000) {
        return res.status(400).json({ error: "text must be a non-empty string of at most 2000 characters" });
    }

    try {
        await sendObservationToChatGPT({
            type: "interaction.user_input",
            source: "user_input_api",
            payload: { text: text.trim() },
        });
        return res.json({ status: "OK" });
    } catch (err) {
        return res.status(503).json({ error: "ChatGPT delivery failed" });
    }
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

            const turnContext = typeof payload.turn_id === "string"
                ? turnRegistry.get(payload.turn_id)
                : null;
            if (!turnContext) {
                recordActivity({
                    category: "audit",
                    status: "error",
                    title: "Uncorrelated ChatGPT response",
                    summary: "turn_id did not match a pending cognitive context",
                    direction: "inbound",
                    service: "chatgpt",
                    payload,
                });
                continue;
            }

            const audit = responseProtocol.audit(payload);
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

            const evidenceError = validateProposalEvidence(audit.payload);
            if (evidenceError) {
                recordActivity({
                    category: "audit",
                    status: "error",
                    title: "Ungrounded proposal rejected",
                    summary: evidenceError,
                    direction: "inbound",
                    service: "chatgpt",
                    payload,
                });
                continue;
            }

            turnRegistry.consume(payload.turn_id);
            await fillerController.markResponseReady(payload.turn_id);
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
            await executeAuditedPayload(audit.payload, { context: turnContext });
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
