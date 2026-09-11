export class AsrTokenError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

export function isLoopbackAddress(address) {
    if (typeof address !== "string") return false;
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
    const octets = ipv4.split(".");
    return octets.length === 4
        && octets[0] === "127"
        && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

export class AsrTokenService {
    constructor({ enabled, provider, modelId, loopbackOnly, apiKey, client }) {
        this.enabled = enabled;
        this.provider = provider;
        this.modelId = modelId;
        this.loopbackOnly = loopbackOnly;
        this.apiKey = apiKey;
        this.client = client;
    }

    async issue(remoteAddress) {
        if (!this.enabled || !this.apiKey || !this.client) {
            throw new AsrTokenError(503, "ASR is unavailable");
        }
        if (this.loopbackOnly && !isLoopbackAddress(remoteAddress)) {
            throw new AsrTokenError(403, "ASR token access is restricted to loopback clients");
        }
        try {
            const result = await this.client.tokens.singleUse.create("realtime_scribe");
            if (typeof result?.token !== "string" || !result.token) throw new Error("missing token");
            return {
                token: result.token,
                provider: this.provider,
                model_id: this.modelId,
            };
        } catch (error) {
            if (error instanceof AsrTokenError) throw error;
            throw new AsrTokenError(502, "ASR provider token request failed");
        }
    }
}
