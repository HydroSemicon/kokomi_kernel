import { randomUUID } from "crypto";

const TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertTimestamp(value, field) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new TypeError(`${field} must be an ISO-8601 timestamp`);
    }
}

/**
 * Create the immutable envelope used at the raw-observation boundary.
 * Device-specific payloads stay inside `payload`; the rest of the Kernel can
 * therefore process every input through one ordered event stream.
 */
export function createObservation(input, { now = () => new Date().toISOString() } = {}) {
    if (!isPlainObject(input)) throw new TypeError("observation must be an object");
    if (typeof input.type !== "string" || !TYPE_PATTERN.test(input.type)) {
        throw new TypeError("observation type must be a dotted lowercase identifier");
    }
    if (typeof input.source !== "string" || input.source.trim() === "") {
        throw new TypeError("observation source must be a non-empty string");
    }
    if (!isPlainObject(input.payload)) {
        throw new TypeError("observation payload must be an object");
    }

    const receivedAt = input.received_at ?? now();
    const observedAt = input.observed_at ?? receivedAt;
    assertTimestamp(receivedAt, "received_at");
    assertTimestamp(observedAt, "observed_at");

    const confidence = input.confidence ?? 1;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new TypeError("observation confidence must be between 0 and 1");
    }

    return Object.freeze({
        schema_version: "1.0",
        id: input.id ?? `obs_${randomUUID()}`,
        type: input.type,
        source: input.source.trim(),
        observed_at: observedAt,
        received_at: receivedAt,
        confidence,
        payload: Object.freeze({ ...input.payload }),
    });
}

export function observationSearchText(observation) {
    const strings = [];
    const visit = (value) => {
        if (typeof value === "string") strings.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (isPlainObject(value)) Object.values(value).forEach(visit);
    };
    visit(observation.payload);
    return strings.join(" ");
}
