const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const array = (items) => ({ type: "array", items });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const oneOf = (...anyOf) => ({ anyOf });
const choices = (...values) => ({ type: "string", enum: values });
const optionalString = { type: ["string", "null"] };
const variant = (type, params) => object({ type: choices(type), params: object(params) });
const format = (name, fields) => ({ type: "json_schema", name, strict: true, schema: object({ turn_id: string, ...fields }) });

export function responseFormats(config) {
    const actions = oneOf(
        variant("tear", { speed: integer, duration: integer }),
        variant("led_change", { color: string }),
        variant("bluesky_post", { text: string }),
        variant("remember_person", { track_id: oneOf(string, integer), name: string }),
    );
    const requests = [choices(...Object.keys(config.sensors.units)),
        variant("vision", { task: choices(config.vision.task) }),
        variant("kernel_query", { resource: choices("state", "world", "drives", "social", "memory", "action"), query: optionalString })];
    if (config.responses.webSearchEnabled) requests.push(variant("web_search", { query: string }));
    const proposal = object({ kind: choices("episodic", "preference", "relationship", "semantic"), subject: string,
        content: string, confidence: { type: "number" }, evidence_event_ids: array(string), retention: choices("session", "long") });
    const evidence = object({ quote: string, evidence_event_ids: array(string) });
    return {
        live_control: format("kernel_control", { result: optionalString, actions: array(actions), requests: array(oneOf(...requests)) }),
        live_memory: format("kernel_memory", { memory_extraction: object({ summary: string,
            candidates: array(object({ proposal, evidence: array(evidence), explicit: boolean, conflict: boolean })) }) }),
        live_memory_review: format("kernel_memory_review", { memory_verification: object({ supported_indices: array(integer) }) }),
    };
}
