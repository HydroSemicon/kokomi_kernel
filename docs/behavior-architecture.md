# Alice Behavior Architecture

This document defines the original behavior architecture used by Alice. The
implementation is derived from this project's requirements and JSON protocol.

## Ownership boundaries

```text
Persona repository ───────────────┐
Approved long-term memory ────────┤
Raw observations -> State -> World├-> Cognitive context -> ChatGPT
                         \        │                       |
                          -> Behavior proposals ----------+
                                                         |
ChatGPT JSON -> turn correlation -> action gate -> dispatcher
      ^                                      |              |
      +---------- outcome observation <-----+--------------+
```

The Kernel is authoritative for observations, persistent state, the world
model, long-term memory, proposal cooldowns, and action execution. ChatGPT owns
natural-language reasoning and the immediate conversation context. Persona is
versioned outside the runtime and loaded when the ChatGPT session is bootstrapped.

## Processing model

All sources are converted to a common immutable observation envelope:

```json
{
  "schema_version": "1.0",
  "id": "obs_...",
  "type": "sensor.environment_sample",
  "source": "bme280",
  "observed_at": "2026-09-10T12:00:00.000Z",
  "received_at": "2026-09-10T12:00:00.010Z",
  "confidence": 1,
  "payload": {
    "temperature": 28,
    "humidity": 56
  }
}
```

`StateStore` reduces observations into facts that retain provenance,
confidence, timestamps, units, and freshness. A missing fact is `unknown`; an
expired fact is `stale`. Neither is silently converted to `false`.

`WorldModel` is deterministic. It currently derives occupancy, recognized
people, thermal condition, lighting condition, quietness, speech activity, and
petting state. Thresholds live in `config.json`, so an experiment can reproduce
the same interpretation without depending on an LLM response.

`SpontaneousBehaviorEngine` emits time-bounded proposals with a priority,
reason, cooldown key, and supporting context. A proposal is never a hardware
command. ChatGPT reviews it, then any returned action still passes through the
existing Kernel audit. Automatic proposal dispatch is disabled by default.

`ContextComposer` creates the JSON-only `cognitive_context` passed to ChatGPT.
It first projects the complete internal state into a compact LLM view. Trigger,
persona metadata, state, world model, approved memories, and behavior proposals
remain separate, but audit-only metadata is not repeated in the conversation.

## Internal state and cognitive projection

The complete state returned by `GET /api/behavior/state` retains schema and
revision numbers, timestamps, source names, confidence, observation IDs,
freshness, provenance, and derivation evidence. This is the inspectable Kernel
record and is never reduced.

Protocol 1.2 sends a different representation to ChatGPT:

- current numeric readings are rounded to a conversationally useful precision
- units move into stable field names such as `temperature_c`
- `unknown` and `stale` remain explicit values rather than becoming `false`
- repeated timestamps, source names, confidence 1.0, and derivation paths stay internal
- empty memory and behavior arrays are omitted
- memories retain their IDs, confidence, relevance, and evidence references
- behavior proposals retain priority, reason, expiry, and supporting context
- every context and response shares a required `turn_id`
- functional drives, approved social state, and the last action outcome are compact projections

The projection intentionally sends a small current snapshot on every turn
instead of relying on deltas alone. ChatGPT can therefore recover after context
compaction or a missed message without receiving the full audit record.
When audit detail is genuinely required, the LLM can issue a typed
`kernel_query` JSON request for state, world, drives, social state, memory, or
action diagnostics. The result returns as another Observation; no MCP transport
is required.

## Persona and conversation context

`kokomi-persona` remains the canonical character source. The persona is loaded
when a ChatGPT session is prepared; each cognitive context includes its ID and
version for reproducibility. The current ChatGPT thread remains the working
memory for conversational continuity.

The Kernel does not duplicate the entire current conversation. It stores only
durable information that must survive a thread or model change.

## Long-term memory

ChatGPT may return `memory_proposals`, but these enter the store with
`status: pending`. Only accepted records can be retrieved into later cognitive
contexts. This keeps the categories apart:

- `episodic`: something that happened
- `preference`: a relatively durable preference
- `relationship`: a social fact or commitment
- `semantic`: another durable learned fact

Records include confidence and evidence observation IDs. Runtime data is stored
under `data/runtime/` and is intentionally excluded from Git.

Retrieval combines Japanese-friendly lexical features with a deterministic
hashed feature vector. Accepting a near-duplicate supersedes the older record
without deleting its history. Evidence IDs returned by the LLM must exist in
the event store.

## Social state and drives

Relationships, boundaries, and commitments are separate from autobiographical
memory. LLM proposals remain pending until accepted. An accepted `deny`
boundary is enforced by the action gate rather than left as prompt advice.

The drive system exposes bounded functional needs for thermal comfort, social
contact, and sensory rest. Real body controllers can submit additional normalized
signals through `POST /internal_state`; these measured signals remain labeled
separately from inferred needs.

## Intention, action, and outcome

Every LLM response must echo the `turn_id` of a pending context. The Kernel
rejects uncorrelated or replayed responses. Before an external action, the
Kernel records an intention containing the exact normalized action hash and an
expected effect. It then applies the per-turn bottleneck, authorization,
boundary, duplicate, cooldown, and spontaneous-action policies.

Success, failure, and denial become `action.outcome` observations. The outcome
contains a prediction-match value and is persisted before being projected into
the next cognitive context. The LLM therefore cannot declare physical success
from its own action proposal.

## Persistence and recovery

Normalized observations are appended to `data/runtime/observations.jsonl` and
replayed at startup. High-rate environment, brightness, and unchanged audio
samples are checkpointed rather than written on every poll. State snapshots
are rebuilt from the event stream, while approved memory and social records use
their own atomic stores.

## Operations

- `GET /api/behavior/state`: inspect current state, world model, and pending proposals
- `POST /api/behavior/tick`: send eligible pending proposals for cognitive review
- `POST /audio_classification`: ingest YAMNet-compatible sound state
- `POST /internal_state`: ingest normalized body/homeostasis signals
- `GET /api/memory/proposals?status=pending`: inspect memory candidates
- `POST /api/memory/proposals/:id/decision` with `{"decision":"accepted"}` or
  `{"decision":"rejected"}`: review a candidate
- `GET /api/social/proposals` and its decision endpoint: review social-state candidates

To enable periodic spontaneous ticks after bench testing, set both
`behavior.spontaneous.enabled` and `behavior.spontaneous.armed` to `true` in `config.json`. The minimum priority,
interval, cooldowns, freshness windows, and world-model thresholds are all
configurable in the same section.

## Current limits

- The deterministic hashed feature vector is not a learned semantic embedding;
  its interface can later be backed by a local or hosted embedding model.
- Persona content is still bootstrapped manually; only identity/version
  metadata travels in each context.
- Proposals do not bypass the LLM or the existing action safety audit.
- Browser DOM automation still requires end-to-end testing against the active
  ChatGPT UI and selected physical devices.
