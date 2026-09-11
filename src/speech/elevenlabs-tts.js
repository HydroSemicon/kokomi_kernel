function clamp01(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError("TTS voice setting must be a finite number");
    }
    return Math.min(1, Math.max(0, value));
}

function interpolate(start, end, amount) {
    return start + (end - start) * amount;
}

function round(value, decimals = 4) {
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}

export function buildElevenLabsTtsRequest({ text, emotion, intensity }, config) {
    if (!Object.hasOwn(config.emotionTags ?? {}, emotion)) {
        throw new TypeError("TTS emotion does not have a configured provider mapping");
    }
    const tag = config.emotionTags?.[emotion];
    const boundedIntensity = clamp01(intensity);
    const providerSafeText = text.replaceAll("[", "［").replaceAll("]", "］");
    const renderedText = tag ? `${tag} ${providerSafeText}` : providerSafeText;
    const voiceSettings = {
        stability: round(clamp01(interpolate(
            config.stabilityAtIntensityZero,
            config.stabilityAtIntensityOne,
            boundedIntensity,
        ))),
    };
    if (config.defaultModelId !== "eleven_v3") {
        voiceSettings.similarity_boost = round(clamp01(config.similarityBoost));
        voiceSettings.style = round(clamp01(interpolate(
            config.styleAtIntensityZero,
            config.styleAtIntensityOne,
            boundedIntensity,
        )));
        voiceSettings.use_speaker_boost = Boolean(config.speakerBoost);
    }
    return {
        originalText: text,
        renderedText,
        body: {
            text: renderedText,
            model_id: config.defaultModelId,
            voice_settings: voiceSettings,
        },
    };
}

export function sanitizeTtsError(error) {
    if (error?.safeMessage) return error.safeMessage;
    const message = typeof error?.message === "string" ? error.message : "unknown TTS error";
    return message
        .replace(/xi-api-key\s*[:=]\s*\S+/giu, "xi-api-key=[redacted]")
        .replace(/sk_[A-Za-z0-9_-]+/gu, "[redacted]")
        .slice(0, 300);
}

function safeError(message) {
    const error = new Error(message);
    error.safeMessage = message;
    return error;
}

async function* streamChunks(body) {
    if (typeof body?.getReader === "function") {
        const reader = body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value?.length) yield Buffer.from(value);
        }
    } else if (body?.[Symbol.asyncIterator]) {
        for await (const chunk of body) {
            if (chunk?.length) yield Buffer.from(chunk);
        }
    } else {
        throw safeError("TTS provider returned an unreadable audio stream");
    }
}

export class ElevenLabsTtsProvider {
    constructor({ config, apiKey, fetchImpl, spawnImpl }) {
        this.config = config;
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
        this.spawnImpl = spawnImpl;
        this.name = config.provider;
        this.modelId = config.defaultModelId;
    }

    buildRequest(input) {
        return buildElevenLabsTtsRequest(input, this.config);
    }

    async speak({ body, onPlaybackStarted }) {
        const url = `${this.config.baseUrl}/${this.config.defaultVoiceId}/stream?output_format=${this.config.defaultOutputFormat}`;
        let response;
        try {
            response = await this.fetchImpl(url, {
                method: "POST",
                headers: {
                    "xi-api-key": this.apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });
        } catch {
            throw safeError("TTS provider request failed");
        }
        if (!response.ok || !response.body) {
            throw safeError(`TTS provider returned HTTP ${response.status}`);
        }
        await this.#play(response.body, onPlaybackStarted);
    }

    #play(body, onPlaybackStarted) {
        return new Promise((resolve, reject) => {
            let player;
            try {
                player = this.spawnImpl(this.config.playerCommand, this.config.playerArgs);
            } catch {
                reject(safeError("TTS player could not be started"));
                return;
            }

            let settled = false;
            let receivedAudio = false;
            let started = false;
            let inputEnded = false;
            let playerClosed = false;
            const fail = (message) => {
                if (settled) return;
                settled = true;
                reject(safeError(message));
            };
            const playerInputFailure = (error) => error?.code === "EPIPE"
                ? "TTS player input closed during audio streaming"
                : "TTS player input failed";

            const waitForDrainOrTermination = () => new Promise((drainResolve, drainReject) => {
                if (playerClosed || player.stdin.destroyed) {
                    drainReject(safeError("TTS player closed while waiting for audio drain"));
                    return;
                }
                let finished = false;
                const cleanup = () => {
                    player.stdin.removeListener("drain", onDrain);
                    player.stdin.removeListener("error", onStdinError);
                    player.removeListener("close", onPlayerClose);
                };
                const finish = (callback, value) => {
                    if (finished) return;
                    finished = true;
                    cleanup();
                    callback(value);
                };
                const onDrain = () => finish(drainResolve);
                const onStdinError = (error) => finish(drainReject, safeError(playerInputFailure(error)));
                const onPlayerClose = () => finish(
                    drainReject,
                    safeError("TTS player closed while waiting for audio drain"),
                );
                player.stdin.once("drain", onDrain);
                player.stdin.once("error", onStdinError);
                player.once("close", onPlayerClose);
            });

            player.once("error", () => fail("TTS player could not be started"));
            player.stdin.on("error", (error) => fail(playerInputFailure(error)));
            player.once("close", (code) => {
                playerClosed = true;
                if (settled) return;
                if (!receivedAudio) return fail("TTS provider returned an empty audio stream");
                if (code !== 0) return fail(`TTS player exited with code ${code}`);
                if (!inputEnded) return fail("TTS player closed before the audio stream completed");
                settled = true;
                resolve();
            });

            (async () => {
                try {
                    for await (const chunk of streamChunks(body)) {
                        if (playerClosed || settled) {
                            throw safeError("TTS player closed during audio streaming");
                        }
                        receivedAudio = true;
                        const canContinue = player.stdin.write(chunk);
                        if (!started) {
                            started = true;
                            await onPlaybackStarted();
                        }
                        if (!canContinue) await waitForDrainOrTermination();
                    }
                    inputEnded = true;
                    if (!playerClosed && !player.stdin.destroyed) player.stdin.end();
                } catch (error) {
                    if (!player.stdin.destroyed) player.stdin.destroy();
                    fail(error?.safeMessage ?? (error?.code === "EPIPE"
                        ? playerInputFailure(error)
                        : "TTS audio stream failed"));
                }
            })();
        });
    }
}
