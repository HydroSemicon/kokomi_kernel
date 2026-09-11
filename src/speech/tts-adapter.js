import { sanitizeTtsError } from "./elevenlabs-tts.js";

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class TtsAdapter {
    constructor({ enabled, provider, validEmotions, intensityMin = 0, intensityMax = 1, onObservation, echoGuard, outputLifecycle = null, clock = () => new Date().toISOString() }) {
        this.enabled = enabled;
        this.provider = provider;
        this.validEmotions = new Set(validEmotions);
        this.intensityMin = intensityMin;
        this.intensityMax = intensityMax;
        this.onObservation = onObservation;
        this.echoGuard = echoGuard;
        this.outputLifecycle = outputLifecycle;
        this.clock = clock;
        this.queue = Promise.resolve();
    }

    speak(request) {
        this.#validate(request);
        const operation = this.queue.catch(() => {}).then(() => this.#execute(request));
        this.queue = operation.catch(() => {});
        return operation;
    }

    #validate(request) {
        if (!isPlainObject(request)) throw new TypeError("TTS request must be an object");
        if (typeof request.turnId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(request.turnId)) {
            throw new TypeError("TTS turnId must be a safe identifier");
        }
        if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 2000) {
            throw new TypeError("TTS text must be a non-empty string of at most 2000 characters");
        }
        if (!this.validEmotions.has(request.emotion)) throw new TypeError("TTS emotion is invalid");
        if (typeof request.intensity !== "number" || !Number.isFinite(request.intensity)
            || request.intensity < this.intensityMin || request.intensity > this.intensityMax) {
            throw new TypeError("TTS intensity is out of range");
        }
    }

    async #emit(type, payload) {
        await this.onObservation({
            type,
            source: "tts_adapter",
            observed_at: this.clock(),
            payload,
        });
    }

    #basePayload(request, renderedText, requestedAt) {
        return {
            turn_id: request.turnId,
            emotion: request.emotion,
            intensity: request.intensity,
            provider: this.provider.name,
            model_id: this.provider.modelId,
            requested_at: requestedAt,
            original_text: request.text,
            rendered_text: renderedText,
        };
    }

    async #execute(request) {
        const requestedAt = this.clock();
        const prepared = this.provider.buildRequest(request);
        const base = this.#basePayload(request, prepared.renderedText, requestedAt);
        await this.#emit("speech.output_requested", { ...base, status: "requested", error: null });

        if (!this.enabled) {
            const completedAt = this.clock();
            const outcome = { ...base, status: "skipped", completed_at: completedAt, reason: "tts_disabled", error: null };
            await this.#emit("speech.output_skipped", outcome);
            return outcome;
        }

        let startedAt = null;
        let outputContext = null;
        try {
            await this.provider.speak({
                body: prepared.body,
                onBeforePlayback: async () => {
                    outputContext = await this.outputLifecycle?.begin({
                        kind: "main_tts",
                        outputId: request.turnId,
                        pauseCapture: true,
                    });
                },
                onPlaybackStarted: async () => {
                    if (startedAt) return;
                    startedAt = this.clock();
                    this.echoGuard?.start({ turnId: request.turnId, text: request.text, startedAt });
                    await this.#emit("speech.output_started", {
                        ...base,
                        status: "started",
                        started_at: startedAt,
                        error: null,
                    });
                },
            });
            const completedAt = this.clock();
            this.echoGuard?.finish({ turnId: request.turnId, completedAt });
            const outcome = {
                ...base,
                status: "completed",
                started_at: startedAt,
                completed_at: completedAt,
                error: null,
            };
            await this.#emit("speech.output_completed", outcome);
            return outcome;
        } catch (error) {
            const completedAt = this.clock();
            if (startedAt) this.echoGuard?.finish({ turnId: request.turnId, completedAt });
            const outcome = {
                ...base,
                status: "failed",
                started_at: startedAt,
                completed_at: completedAt,
                error: sanitizeTtsError(error),
            };
            await this.#emit("speech.output_failed", outcome);
            return outcome;
        } finally {
            if (outputContext) this.outputLifecycle?.end(outputContext);
        }
    }
}
