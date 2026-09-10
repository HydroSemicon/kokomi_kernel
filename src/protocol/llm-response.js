import { validateMemoryProposals } from "../memory/memory-store.js";
import { validateSocialProposals } from "../social/social-state-store.js";

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(object, keys) {
    const actual = Object.keys(object);
    return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasOnlyKeys(object, keys) {
    return Object.keys(object).every((key) => keys.includes(key));
}

export class LlmResponseProtocol {
    constructor(config) {
        this.config = config;
        this.validTopLevelFields = new Set(config.audit.validTopLevelFields);
        this.validEmotions = new Set(config.audit.validEmotions);
    }

    validateActions(actions) {
        const config = this.config;
        if (!Array.isArray(actions)) return "actions must be an array";
        if (actions.length > config.actionGate.max_actions_per_turn) {
            return `actions may contain at most ${config.actionGate.max_actions_per_turn} item(s)`;
        }
        for (const action of actions) {
            if (!isPlainObject(action) || !hasExactlyKeys(action, ["type", "params"])) {
                return "each action must be an object with exactly type and params";
            }
            if (!isPlainObject(action.params)) return "action params must be an object";
            if (action.type === "tear") {
                if (!hasExactlyKeys(action.params, ["speed", "duration"])) return "tear params must contain exactly speed and duration";
                if (!Number.isInteger(action.params.speed) || action.params.speed < config.actions.tear.speedMin || action.params.speed > config.actions.tear.speedMax) {
                    return `tear speed must be an integer from ${config.actions.tear.speedMin} to ${config.actions.tear.speedMax}`;
                }
                if (!Number.isInteger(action.params.duration) || action.params.duration < config.actions.tear.durationMin || action.params.duration > config.actions.tear.durationMax) {
                    return `tear duration must be an integer from ${config.actions.tear.durationMin} to ${config.actions.tear.durationMax}`;
                }
                continue;
            }
            if (action.type === "led_change") {
                if (!hasExactlyKeys(action.params, ["color"])) return "led_change params must contain exactly color";
                if (typeof action.params.color !== "string" || !new RegExp(config.actions.ledChange.colorPattern).test(action.params.color)) {
                    return "led_change color must be #RRGGBB";
                }
                continue;
            }
            if (action.type === "bluesky_post") {
                if (!hasExactlyKeys(action.params, ["text"])) return "bluesky_post params must contain exactly text";
                if (typeof action.params.text !== "string" || !action.params.text.trim()) return "bluesky_post text must be a non-empty string";
                if (action.params.text.length > config.actions.blueskyPost.maxTextLength) {
                    return `bluesky_post text must be ${config.actions.blueskyPost.maxTextLength} characters or fewer`;
                }
                continue;
            }
            if (action.type === "remember_person") {
                if (!hasExactlyKeys(action.params, ["track_id", "name"])) return "remember_person params must contain exactly track_id and name";
                const trackId = action.params.track_id;
                if ((typeof trackId !== "string" && !Number.isInteger(trackId)) || !String(trackId).trim()) {
                    return "remember_person track_id must be a non-empty string or integer";
                }
                if (typeof action.params.name !== "string" || !action.params.name.trim()) return "remember_person name must be a non-empty string";
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

    validateRequests(requests) {
        if (!Array.isArray(requests)) return "requests must be an array";
        if (requests.length > 5) return "requests may contain at most 5 items";
        const validSensorRequests = new Set(Object.keys(this.config.sensors.units));
        for (const request of requests) {
            if (typeof request === "string") {
                if (!validSensorRequests.has(request)) return `unknown request: ${request}`;
                continue;
            }
            if (!isPlainObject(request) || !hasExactlyKeys(request, ["type", "params"])) {
                return "object request must contain exactly type and params";
            }
            if (request.type === "vision") {
                if (!isPlainObject(request.params) || !hasExactlyKeys(request.params, ["task"])) return "vision params must contain exactly task";
                if (request.params.task !== this.config.vision.task) return `vision task must be ${this.config.vision.task}`;
                continue;
            }
            if (request.type === "kernel_query") {
                if (!isPlainObject(request.params) || !hasOnlyKeys(request.params, ["resource", "query"])) {
                    return "kernel_query params may contain only resource and query";
                }
                const resources = ["state", "world", "drives", "social", "memory", "action"];
                if (!resources.includes(request.params.resource)) return "kernel_query resource is invalid";
                if (request.params.resource === "memory" && (typeof request.params.query !== "string" || !request.params.query.trim())) {
                    return "memory kernel_query requires a non-empty query";
                }
                if (request.params.query !== undefined && (typeof request.params.query !== "string" || request.params.query.length > 500)) {
                    return "kernel_query query must be at most 500 characters";
                }
                continue;
            }
            return `unknown request type: ${request.type}`;
        }
        return null;
    }

    audit(payload) {
        if (!isPlainObject(payload)) return { ok: false, reason: "payload must be a JSON object" };
        for (const field of Object.keys(payload)) {
            if (!this.validTopLevelFields.has(field)) return { ok: false, reason: `unknown top-level field: ${field}` };
        }
        if (typeof payload.turn_id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(payload.turn_id)) {
            return { ok: false, reason: "turn_id must match a pending cognitive context" };
        }
        const speechError = this.#validateSpeech(payload);
        if (speechError) return { ok: false, reason: speechError };
        if ("actions" in payload) {
            const error = this.validateActions(payload.actions);
            if (error) return { ok: false, reason: error };
        }
        if ("requests" in payload) {
            const error = this.validateRequests(payload.requests);
            if (error) return { ok: false, reason: error };
        }
        if ("memory_proposals" in payload) {
            const error = validateMemoryProposals(payload.memory_proposals);
            if (error) return { ok: false, reason: error };
        }
        if ("social_proposals" in payload) {
            const error = validateSocialProposals(payload.social_proposals);
            if (error) return { ok: false, reason: error };
        }
        const effective = Boolean(payload.speech?.trim())
            || (Array.isArray(payload.actions) && payload.actions.length > 0)
            || (Array.isArray(payload.requests) && payload.requests.length > 0);
        return effective
            ? { ok: true, payload }
            : { ok: false, reason: "payload must contain an effective speech, action, or request" };
    }

    #validateSpeech(payload) {
        const hasSpeech = Object.hasOwn(payload, "speech");
        const hasEmotion = Object.hasOwn(payload, "emotion");
        const hasIntensity = Object.hasOwn(payload, "intensity");
        if (!hasSpeech) return hasEmotion || hasIntensity ? "emotion and intensity must not exist without speech" : null;
        if (!hasEmotion || !hasIntensity) return "speech requires emotion and intensity";
        if (typeof payload.speech !== "string" || !payload.speech.trim() || payload.speech.length > 2000) {
            return "speech must be a non-empty string of at most 2000 characters";
        }
        if (!this.validEmotions.has(payload.emotion)) return "emotion is invalid";
        if (typeof payload.intensity !== "number" || !Number.isFinite(payload.intensity)) return "intensity must be a finite number";
        if (payload.intensity < this.config.audit.intensityMin || payload.intensity > this.config.audit.intensityMax) {
            return `intensity must be from ${this.config.audit.intensityMin.toFixed(1)} to ${this.config.audit.intensityMax.toFixed(1)}`;
        }
        return null;
    }
}
