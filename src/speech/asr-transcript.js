const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const ALLOWED_FIELDS = new Set([
    "event_id",
    "session_id",
    "segment_id",
    "kind",
    "revision",
    "text",
    "observed_at",
    "language_code",
]);

export class AsrValidationError extends TypeError {}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
    return typeof value === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
        && !Number.isNaN(Date.parse(value));
}

export function validateAsrTranscript(input, { maxTextLength = 2000 } = {}) {
    if (!isPlainObject(input)) throw new AsrValidationError("ASR transcript must be an object");
    for (const field of Object.keys(input)) {
        if (!ALLOWED_FIELDS.has(field)) throw new AsrValidationError(`unknown ASR transcript field: ${field}`);
    }
    for (const field of ["event_id", "session_id", "segment_id"]) {
        if (typeof input[field] !== "string" || !SAFE_ID_PATTERN.test(input[field])) {
            throw new AsrValidationError(`${field} must contain 1 to 128 safe identifier characters`);
        }
    }
    if (input.kind !== "partial" && input.kind !== "committed") {
        throw new AsrValidationError("kind must be partial or committed");
    }
    if (!Number.isInteger(input.revision) || input.revision < 0) {
        throw new AsrValidationError("revision must be a non-negative integer");
    }
    if (typeof input.text !== "string" || input.text.length > maxTextLength) {
        throw new AsrValidationError(`text must be a string of at most ${maxTextLength} characters`);
    }
    if (input.kind === "committed" && !input.text.trim()) {
        throw new AsrValidationError("committed text must not be empty");
    }
    if (input.observed_at !== undefined && !isIsoTimestamp(input.observed_at)) {
        throw new AsrValidationError("observed_at must be an ISO-8601 timestamp");
    }
    if (input.language_code !== undefined
        && (typeof input.language_code !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(input.language_code))) {
        throw new AsrValidationError("language_code must be a valid language identifier");
    }
    return { ...input };
}

export function createPartialObservation(event, receivedAt) {
    return {
        id: event.event_id,
        type: "asr.partial_transcript",
        source: "elevenlabs_scribe",
        observed_at: event.observed_at ?? receivedAt,
        received_at: receivedAt,
        payload: {
            session_id: event.session_id,
            segment_id: event.segment_id,
            revision: event.revision,
            text: event.text,
            ...(event.language_code ? { language_code: event.language_code } : {}),
        },
    };
}

export function createCommittedObservation(event, receivedAt) {
    return {
        id: event.event_id,
        type: "interaction.user_input",
        source: "elevenlabs_scribe",
        observed_at: event.observed_at ?? receivedAt,
        received_at: receivedAt,
        payload: {
            text: event.text,
            modality: "speech",
            asr: {
                session_id: event.session_id,
                segment_id: event.segment_id,
                ...(event.language_code ? { language_code: event.language_code } : {}),
            },
        },
    };
}

class BoundedIdCache {
    constructor(limit) {
        this.limit = limit;
        this.ids = new Set();
    }

    has(id) {
        return this.ids.has(id);
    }

    add(id) {
        if (this.ids.has(id)) return;
        this.ids.add(id);
        while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value);
    }
}

export class AsrTranscriptService {
    constructor({
        config,
        ingestPartial,
        prepareCommitted,
        dispatchCommitted,
        hasPersistedId = () => false,
        echoGuard = null,
        onEchoSuppressed = async () => {},
        clock = () => new Date().toISOString(),
        idempotencyLimit = 1000,
    }) {
        this.config = config;
        this.ingestPartial = ingestPartial;
        this.prepareCommitted = prepareCommitted;
        this.dispatchCommitted = dispatchCommitted;
        this.hasPersistedId = hasPersistedId;
        this.echoGuard = echoGuard;
        this.onEchoSuppressed = onEchoSuppressed;
        this.clock = clock;
        this.completed = new BoundedIdCache(idempotencyLimit);
        this.committedSegments = new BoundedIdCache(idempotencyLimit);
        this.pendingContexts = new Map();
        this.partialQueue = Promise.resolve();
        this.committedQueue = Promise.resolve();
    }

    handle(input) {
        const event = validateAsrTranscript(input, { maxTextLength: this.config.maxTextLength });
        const queueName = event.kind === "partial" ? "partialQueue" : "committedQueue";
        const operation = this[queueName].then(() => this.#handle(event));
        this[queueName] = operation.catch(() => {});
        return operation;
    }

    async #handle(event) {
        if (this.completed.has(event.event_id)) {
            return { status: "duplicate_ignored", event_id: event.event_id };
        }

        const receivedAt = this.clock();
        const segmentKey = `${event.session_id}:${event.segment_id}`;
        if (event.kind === "partial") {
            if (!this.committedSegments.has(segmentKey) && event.text.trim()) {
                await this.ingestPartial(createPartialObservation(event, receivedAt), { persist: false });
            }
            this.completed.add(event.event_id);
            return { status: "accepted", kind: "partial", forwarded_to_llm: false };
        }

        let context = this.pendingContexts.get(event.event_id);
        if (!context && this.hasPersistedId(event.event_id)) {
            this.completed.add(event.event_id);
            this.committedSegments.add(segmentKey);
            return { status: "duplicate_ignored", event_id: event.event_id };
        }

        if (!context) {
            this.committedSegments.add(segmentKey);
            const echo = this.echoGuard?.match(event.text, event.observed_at ?? receivedAt);
            if (echo) {
                await this.onEchoSuppressed({ event, echo, receivedAt });
                this.completed.add(event.event_id);
                this.committedSegments.add(segmentKey);
                return { status: "echo_suppressed" };
            }
            context = await this.prepareCommitted(createCommittedObservation(event, receivedAt));
            this.pendingContexts.set(event.event_id, context);
        }

        await this.dispatchCommitted(context);
        this.pendingContexts.delete(event.event_id);
        this.completed.add(event.event_id);
        this.committedSegments.add(segmentKey);
        return {
            status: "accepted",
            kind: "committed",
            forwarded_to_llm: true,
            turn_id: context.turn_id,
        };
    }
}
