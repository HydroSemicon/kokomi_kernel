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
ChatGPT JSON -> audit -> action dispatcher -> outcome ---+
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

Protocol 1.1 sends a different representation to ChatGPT:

- current numeric readings are rounded to a conversationally useful precision
- units move into stable field names such as `temperature_c`
- `unknown` and `stale` remain explicit values rather than becoming `false`
- repeated timestamps, source names, confidence 1.0, and derivation paths stay internal
- empty memory and behavior arrays are omitted
- memories retain their IDs, confidence, relevance, and evidence references
- behavior proposals retain priority, reason, expiry, and supporting context

The projection intentionally sends a small current snapshot on every turn
instead of relying on deltas alone. ChatGPT can therefore recover after context
compaction or a missed message without receiving the full audit record.

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

## Operations

- `GET /api/behavior/state`: inspect current state, world model, and pending proposals
- `POST /api/behavior/tick`: send eligible pending proposals for cognitive review
- `GET /api/memory/proposals?status=pending`: inspect memory candidates
- `POST /api/memory/proposals/:id/decision` with `{"decision":"accepted"}` or
  `{"decision":"rejected"}`: review a candidate

To enable periodic spontaneous ticks after bench testing, set
`behavior.spontaneous.enabled` to `true` in `config.json`. The minimum priority,
interval, cooldowns, freshness windows, and world-model thresholds are all
configurable in the same section.

## Current limits

- The memory retriever is a deterministic local lexical retriever, not an
  embedding service. Its interface can later be backed by a vector index.
- Persona content is still bootstrapped manually; only identity/version
  metadata travels in each context.
- Proposals do not bypass the LLM or the existing action safety audit.
- State is rebuilt from live observations after a restart. Durable state-event
  logging is a later migration and is separate from long-term social memory.
