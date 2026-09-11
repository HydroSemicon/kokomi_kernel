const ELEVENLABS_CLIENT_URL = "https://esm.sh/@elevenlabs/client@1.15.1";

let sdkPromise = null;

function loadSdk() {
    sdkPromise ??= import(ELEVENLABS_CLIENT_URL);
    return sdkPromise;
}

function safeId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function errorMessage(error) {
    if (typeof error?.message === "string" && error.message) return error.message;
    if (typeof error?.error === "string" && error.error) return error.error;
    return "音声認識でエラーが発生しました";
}

async function readJsonResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Kernel returned HTTP ${response.status}`);
    return body;
}

export class AliceAsrClient {
    constructor({
        config = {},
        getConfig,
        tokenUrl = "/api/asr/token",
        transcriptUrl = "/asr/transcript",
        sdkLoader = loadSdk,
        fetchImpl = (...args) => fetch(...args),
        onStatus = () => {},
        onPartial = () => {},
        onCommitted = () => {},
        onDelivered = () => {},
        onDeliveryError = () => {},
    } = {}) {
        this.config = config;
        this.getConfig = getConfig;
        this.tokenUrl = tokenUrl;
        this.transcriptUrl = transcriptUrl;
        this.sdkLoader = sdkLoader;
        this.fetchImpl = fetchImpl;
        this.onStatus = onStatus;
        this.onPartial = onPartial;
        this.onCommitted = onCommitted;
        this.onDelivered = onDelivered;
        this.onDeliveryError = onDeliveryError;
        this.connection = null;
        this.active = false;
        this.desiredActive = false;
        this.capturePaused = false;
        this.pauseReason = null;
        this.runId = 0;
        this.sessionId = null;
        this.segmentNumber = 0;
        this.segmentId = null;
        this.revision = 0;
    }

    get isActive() {
        return this.active;
    }

    get isStarted() {
        return this.desiredActive;
    }

    #status(state, message) {
        this.onStatus({ state, message });
    }

    #beginSegment() {
        this.segmentNumber += 1;
        this.revision = 0;
        this.segmentId = `segment_${this.segmentNumber}`;
    }

    #transcriptEvent(kind, text, languageCode) {
        const suffix = kind === "partial" ? `revision${this.revision}` : "committed";
        return {
            event_id: `asr_${this.sessionId}_${this.segmentId}_${suffix}`,
            session_id: this.sessionId,
            segment_id: this.segmentId,
            kind,
            revision: this.revision,
            text,
            observed_at: new Date().toISOString(),
            ...(languageCode ? { language_code: languageCode } : {}),
        };
    }

    async #postTranscript(event, { retries = 0 } = {}) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const response = await this.fetchImpl(this.transcriptUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(event),
                });
                return await readJsonResponse(response);
            } catch (error) {
                lastError = error;
                if (attempt < retries) {
                    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
                }
            }
        }
        throw lastError;
    }

    async start() {
        this.desiredActive = true;
        return this.#connect();
    }

    async #connect() {
        if (this.active || this.capturePaused || !this.desiredActive) return;
        const runId = ++this.runId;
        this.active = true;
        this.#status("connecting", "マイクへ接続中");
        try {
            const [sdk, tokenResponse] = await Promise.all([
                this.sdkLoader(),
                this.fetchImpl(this.tokenUrl, { method: "POST" }).then(readJsonResponse),
            ]);
            if (!this.active || this.capturePaused || !this.desiredActive || runId !== this.runId) return;

            const configured = this.getConfig?.() ?? this.config;
            const clientConfig = tokenResponse.client_config ?? {};
            const config = { ...configured, ...clientConfig };
            this.sessionId = safeId("session");
            this.segmentNumber = 0;
            this.#beginSegment();

            const connection = sdk.Scribe.connect({
                token: tokenResponse.token,
                modelId: tokenResponse.model_id || config.modelId || "scribe_v2_realtime",
                languageCode: config.languageCode || "ja",
                commitStrategy: (config.commitStrategy || "vad") === "vad"
                    ? sdk.CommitStrategy.VAD
                    : sdk.CommitStrategy.MANUAL,
                vadSilenceThresholdSecs: config.vadSilenceThresholdSecs ?? 0.8,
                minSpeechDurationMs: config.minSpeechDurationMs ?? 250,
                microphone: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
            this.connection = connection;

            connection.on(sdk.RealtimeEvents.OPEN, () => {
                if (this.connection !== connection) return;
                this.#status("listening", "音声入力中 — 話し終えると自動送信します");
            });
            connection.on(sdk.RealtimeEvents.ERROR, (error) => {
                if (this.connection !== connection) return;
                this.#status("error", errorMessage(error));
            });
            connection.on(sdk.RealtimeEvents.CLOSE, () => {
                if (this.connection !== connection) return;
                this.connection = null;
                this.active = false;
                this.#status(this.capturePaused ? "paused" : "idle", this.capturePaused
                    ? "心海の発話中 — マイクを一時停止しています"
                    : "音声入力は停止しています");
            });
            connection.on(sdk.RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
                if (this.connection !== connection || this.capturePaused) return;
                this.revision += 1;
                const text = data.text ?? "";
                this.onPartial(text);
                const event = this.#transcriptEvent("partial", text, data.language_code);
                this.#postTranscript(event).catch((error) => {
                    this.onDeliveryError(error, event);
                });
            });
            connection.on(sdk.RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
                if (this.connection !== connection || this.capturePaused) return;
                const text = data.text ?? "";
                const event = this.#transcriptEvent("committed", text, data.language_code);
                this.onCommitted(text);
                this.#beginSegment();
                this.#postTranscript(event, { retries: 3 })
                    .then((result) => this.onDelivered({ text, event, result }))
                    .catch((error) => this.onDeliveryError(error, event));
            });
        } catch (error) {
            if (runId !== this.runId) return;
            this.connection = null;
            this.active = false;
            this.#status("error", errorMessage(error));
            throw error;
        }
    }

    stop() {
        this.desiredActive = false;
        this.runId += 1;
        this.active = false;
        const connection = this.connection;
        this.connection = null;
        connection?.close();
        this.#status("idle", "音声入力は停止しています");
    }

    async setCapturePaused(paused, reason = null) {
        if (typeof paused !== "boolean") throw new TypeError("paused must be boolean");
        this.pauseReason = reason;
        if (paused) {
            this.capturePaused = true;
            this.runId += 1;
            this.active = false;
            const connection = this.connection;
            this.connection = null;
            connection?.close();
            this.#status("paused", "心海の発話中 — マイクを一時停止しています");
            return;
        }
        this.capturePaused = false;
        if (!this.desiredActive) {
            this.#status("idle", "音声入力は停止しています");
            return;
        }
        await this.#connect();
    }
}
