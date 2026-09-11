# Voice I/O Phase 1 Specification

Status: Proposed for implementation  
Target: Alice Kernel on `codex/behavior-architecture`  
Scope: (1) ASR partial/committed integration, (2) emotion-aware TTS  
Out of scope: filler playback, sneeze classification, speaker identification

## 1. Objective

This phase connects the existing ElevenLabs Scribe prototype to the Kernel and
uses the `emotion` and `intensity` fields already produced by the LLM when
synthesizing speech.

The completed flow must be:

```text
Microphone
   |
   v
ElevenLabs Scribe Realtime
   |-- partial transcript ----> Kernel transient ASR state
   |                              (never starts an LLM turn)
   |
   `-- committed transcript --> interaction.user_input
                                  |
                                  v
                           cognitive_context
                                  |
                                  v
                         ChatGPT JSON response
                       speech + emotion + intensity
                                  |
                                  v
                         provider-neutral TTS adapter
                                  |
                                  v
                         ElevenLabs stream -> ffplay
```

The implementation must preserve the project's existing boundaries:

- All runtime communication uses JSON. No MCP dependency is introduced.
- The Kernel owns input validation, event identity, state, and dispatch.
- Partial ASR hypotheses are not treated as user statements.
- A requested TTS emotion is not represented as a measured emotional result.
- Failure to generate or play audio must not be represented as successful speech.

## 2. Existing implementation

The implementation should extend rather than replace these paths:

- `realtime_stt.js` creates an ElevenLabs Scribe single-use token.
- `realtime_stt.html` receives `PARTIAL_TRANSCRIPT` and
  `COMMITTED_TRANSCRIPT`, but only displays them.
- `POST /user_input` already turns text into an `interaction.user_input`
  observation and sends a cognitive context to ChatGPT.
- The LLM response protocol already requires `speech`, `emotion`, and
  `intensity` together.
- `alice.js` currently calls `speakTTS(payload.speech)`, so `emotion` and
  `intensity` are discarded before the TTS request.
- `realtime_stt.js` and Alice Kernel currently both default to port 3000. The
  standalone token server must not remain on that port after integration.

## 3. Normative terminology

The words MUST, MUST NOT, SHOULD, and MAY describe implementation requirements.

- **partial**: mutable ASR text that may be replaced by a later hypothesis.
- **committed**: stable text finalized by Scribe for one segment.
- **speech request**: the original `speech`, `emotion`, and `intensity` values
  accepted from an audited LLM response.
- **rendered TTS text**: the provider-specific text after a fixed emotional
  direction tag has been added.
- **playback outcome**: whether generated audio actually completed playback,
  failed, or was skipped because TTS was disabled.

## 4. Configuration

Add an `asr` section and extend the existing `tts` section. Defaults must keep
the current application runnable without credentials or a microphone.

```json
{
  "asr": {
    "enabled": false,
    "provider": "elevenlabs_scribe",
    "modelId": "scribe_v2_realtime",
    "languageCode": "ja",
    "commitStrategy": "vad",
    "vadSilenceThresholdSecs": 0.8,
    "minSpeechDurationMs": 250,
    "partialTtlMs": 2000,
    "maxTextLength": 2000,
    "tokenRouteLoopbackOnly": true
  },
  "tts": {
    "enabled": false,
    "provider": "elevenlabs",
    "baseUrl": "https://api.elevenlabs.io/v1/text-to-speech",
    "defaultVoiceId": "existing value",
    "defaultModelId": "eleven_v3",
    "defaultOutputFormat": "mp3_44100_128",
    "similarityBoost": 0.75,
    "speakerBoost": true,
    "stabilityAtIntensityZero": 0.65,
    "stabilityAtIntensityOne": 0.35,
    "styleAtIntensityZero": 0.0,
    "styleAtIntensityOne": 0.35,
    "echoGuardMs": 1000,
    "emotionTags": {
      "neutral": null,
      "happy": "[happily]",
      "calm": "[calmly]",
      "sad": "[sad]",
      "angry": "[angry]",
      "surprised": "[surprised]",
      "fear": "[worried]",
      "thinking": "[thoughtfully]"
    }
  }
}
```

Notes:

- `ELEVENLABS_API_KEY` remains the only API-key environment variable.
- Startup MUST require it only when either ASR or TTS is enabled.
- Emotion tags MUST come from configuration selected by the Kernel. Raw tags
  supplied inside user text or generated dynamically by an unaudited source
  MUST NOT be treated as control instructions.
- `stability` is linearly interpolated from 0.65 to 0.35 as intensity moves
  from 0 to 1. All outgoing numeric values MUST be clamped to the provider's
  0-to-1 range.
- For `eleven_v3`, send only `stability` in `voice_settings`; similarity,
  style, and speaker boost are unavailable or unsuitable for that model.
  The configured similarity/style/speaker-boost values apply only to compatible
  non-v3 models.
- The original `speech` string MUST remain unchanged in audit data. Only a
  separate rendered string may contain an emotion tag.
- Eleven v3 does not expose a reliable numeric emotion parameter. The adapter
  therefore translates Kernel semantics into a fixed tag plus bounded voice
  settings. This translation is a requested delivery profile, not proof of how
  listeners perceived the output.

Add routes to `config.routes`:

```json
{
  "asrToken": "/api/asr/token",
  "asrTranscript": "/asr/transcript"
}
```

## 5. ASR component design

### 5.1 Token issuance

Move Scribe single-use-token issuance into Alice Kernel:

```http
POST /api/asr/token
```

Successful response:

```json
{
  "token": "provider-single-use-token",
  "provider": "elevenlabs_scribe",
  "model_id": "scribe_v2_realtime"
}
```

Requirements:

- The API key MUST remain server-side and MUST NOT be returned.
- The endpoint MUST return `503` when ASR is disabled or its credentials are
  unavailable.
- When `tokenRouteLoopbackOnly` is true, non-loopback requests MUST receive
  `403`. Both IPv4 and IPv6 loopback forms must be handled.
- Provider errors MUST be reduced to a safe `502` response without returning
  credentials or the provider's raw response body.
- Token values MUST NOT be written to console, dashboard activity, or the event
  store. Remove the current `console.log("token:", token)` behavior.
- Integrating token issuance into the Kernel resolves the existing port-3000
  collision. `realtime_stt.js` should be retired or changed into a documented
  legacy/example file; it must not be required at runtime.

### 5.2 Transcript ingestion API

The ASR client sends both partial and committed events to:

```http
POST /asr/transcript
Content-Type: application/json
```

Request schema:

```json
{
  "event_id": "asr_session123_segment7_revision3",
  "session_id": "session123",
  "segment_id": "segment7",
  "kind": "partial",
  "revision": 3,
  "text": "今日はちょっ",
  "observed_at": "2026-09-11T12:00:00.000Z",
  "language_code": "ja"
}
```

Field rules:

- `event_id`, `session_id`, and `segment_id` MUST use the Kernel safe-ID
  character set and be at most 128 characters each.
- `kind` MUST be exactly `partial` or `committed`.
- `revision` MUST be a non-negative integer. It increases for partial updates
  belonging to the same segment.
- `text` MUST be a string no longer than `asr.maxTextLength`.
- Empty/whitespace-only partial text MAY be accepted as a no-content update and
  ignored. Empty/whitespace-only committed text MUST be rejected with `400`.
- `observed_at` MUST be an ISO-8601 timestamp when present. The Kernel receipt
  time is used when absent.
- `language_code` is optional. The Kernel MUST NOT invent a confidence score,
  speaker identity, or language when the provider did not supply it.
- Unknown fields MUST be rejected so protocol mistakes are visible.

Representative responses:

```json
{ "status": "accepted", "kind": "partial", "forwarded_to_llm": false }
```

```json
{ "status": "accepted", "kind": "committed", "forwarded_to_llm": true, "turn_id": "asr_..." }
```

```json
{ "status": "duplicate_ignored", "event_id": "asr_..." }
```

### 5.3 Partial transcript semantics

A valid partial request becomes this internal observation:

```json
{
  "type": "asr.partial_transcript",
  "source": "elevenlabs_scribe",
  "payload": {
    "session_id": "session123",
    "segment_id": "segment7",
    "revision": 3,
    "text": "今日はちょっ",
    "language_code": "ja"
  }
}
```

Requirements:

- A partial observation MUST update transient ASR state.
- A partial observation MUST NOT call `sendObservationToChatGPT`.
- A partial observation MUST NOT create a pending `turn_id`.
- A partial observation MUST NOT be added to long-term memory search text.
- Partial text MUST NOT be written to the append-only event log. Extend the
  ingestion API with an explicit `persist: false` option rather than bypassing
  state reduction.
- The complete Kernel state may expose partial text for local diagnostics, but
  `ContextComposer` MUST NOT project partial text to ChatGPT.
- Partial state becomes `stale` after `partialTtlMs` or is cleared immediately
  by a committed event for the same segment.

Recommended complete-state shape:

```json
{
  "interaction": {
    "user_speaking": {
      "value": true,
      "status": "known",
      "observed_at": "2026-09-11T12:00:00.000Z",
      "source": "elevenlabs_scribe"
    },
    "asr_partial": {
      "value": {
        "text": "今日はちょっ",
        "session_id": "session123",
        "segment_id": "segment7",
        "revision": 3
      },
      "status": "known"
    }
  }
}
```

`user_speaking` is infrastructure for the later filler phase. Phase 1 does not
produce a filler, backchannel, or spontaneous response from it.

### 5.4 Committed transcript semantics

A valid committed request MUST create exactly one cognitive turn using a normal
`interaction.user_input` observation:

```json
{
  "id": "asr_session123_segment7_committed",
  "type": "interaction.user_input",
  "source": "elevenlabs_scribe",
  "observed_at": "2026-09-11T12:00:01.000Z",
  "payload": {
    "text": "今日はちょっと寒いね",
    "modality": "speech",
    "asr": {
      "session_id": "session123",
      "segment_id": "segment7",
      "language_code": "ja"
    }
  }
}
```

Requirements:

- Committed text MUST use the same `sendObservationToChatGPT` path as typed
  `/user_input` text. It must not introduce a second LLM bridge.
- `turn_id` is the committed observation ID and follows the existing turn
  registry and exactly-once response rules.
- The observation MUST be persisted because it is the actual user turn.
- A repeated committed `event_id` MUST return success as
  `duplicate_ignored` without creating another context.
- The implementation MUST keep a bounded idempotency cache and SHOULD also use
  persisted observation IDs after restart when available.
- Committing a segment MUST clear its partial state and mark
  `user_speaking = false`.
- `modality: "speech"` distinguishes spoken input from typed input without
  changing the meaning of `interaction.user_input`.
- ChatGPT receives the committed text once. It MUST NOT receive every partial
  prefix that led to the text.

### 5.5 Scribe client changes

Update `realtime_stt.html` to:

1. Fetch its token from the Kernel's `POST /api/asr/token` route.
2. Configure Scribe with VAD-based commit and the configured Japanese language
   preference when the SDK supports it.
3. Generate a stable local `session_id` and one `segment_id` per utterance.
4. Increment `revision` for each partial update.
5. POST partial and committed events to `/asr/transcript`.
6. Keep the existing on-page transcript display for diagnostics.
7. Enable microphone echo cancellation, noise suppression, and automatic gain
   control.
8. Never log the single-use token.

The client SHOULD be served from Alice Kernel so token and transcript requests
are same-origin and no broad CORS policy is necessary. Any browser SDK loaded
from a CDN MUST use an explicit tested version; local bundling is preferable
when the voice client becomes a long-lived experimental dependency.

Network failure behavior:

- Partial POST failures MAY be dropped after being shown locally.
- A committed POST SHOULD be retried with the same `event_id`; Kernel
  idempotency makes the retry safe.
- Retries MUST be bounded and use backoff. They must not mint a new semantic
  user turn ID for the same committed segment.

## 6. TTS component design

### 6.1 Provider-neutral interface

Move provider-specific request construction out of the LLM response handler.
The Kernel-facing function MUST accept one object:

```js
speakTTS({
  turnId: payload.turn_id,
  text: payload.speech,
  emotion: payload.emotion,
  intensity: payload.intensity,
});
```

The TTS adapter MUST validate its input even though the LLM response has already
passed the protocol audit. The accepted emotions and numeric range must remain
the same as `LlmResponseProtocol`.

Suggested files:

```text
src/speech/tts-adapter.js        provider-neutral request and queue
src/speech/elevenlabs-tts.js     ElevenLabs translation and HTTP streaming
src/speech/echo-guard.js         self-transcription suppression
```

Equivalent separation is acceptable, but provider-specific emotional tags must
not spread through `alice.js`.

### 6.2 Deterministic delivery-profile translation

For input:

```json
{
  "text": "大丈夫？",
  "emotion": "fear",
  "intensity": 0.4
}
```

the adapter constructs a provider request conceptually equivalent to:

```json
{
  "text": "[worried] 大丈夫？",
  "model_id": "eleven_v3",
  "voice_settings": {
    "stability": 0.53
  }
}
```

The exact values above follow the configured linear interpolation and normal
rounding. Requirements:

- The fixed emotion map in `config.json` is authoritative.
- `neutral` adds no tag.
- The tag is added once at the beginning of the rendered text.
- For Eleven v3, intensity affects only bounded stability in Phase 1. Do not
  add repeated tags, uppercase user text, exclamation marks, or unbounded
  natural-language directions.
- Do not attempt to use `speed` with Eleven v3 in this phase.
- The original text and rendered text must be stored as distinct values in
  diagnostics.
- Provider request details MUST be testable without making a network request.
- The existing FIFO TTS queue must be preserved.

### 6.3 Playback state and outcomes

Speech output needs an inspectable result, but it MUST NOT recursively start a
new ChatGPT turn.

Emit internal observations for:

```text
speech.output_requested
speech.output_started
speech.output_completed
speech.output_failed
speech.output_skipped
```

Minimum payload:

```json
{
  "turn_id": "obs_123",
  "emotion": "fear",
  "intensity": 0.4,
  "provider": "elevenlabs",
  "model_id": "eleven_v3",
  "status": "completed",
  "requested_at": "...",
  "started_at": "...",
  "completed_at": "...",
  "error": null
}
```

Requirements:

- `output_started` means playback began, not merely that the HTTP request was
  accepted.
- `output_completed` means `ffplay` exited successfully after consuming the
  stream.
- HTTP, stream, spawn, and non-zero-player-exit errors become
  `output_failed`.
- Player stdin errors such as `EPIPE`, and player termination while waiting for
  stream backpressure, MUST be handled without crashing or hanging the Kernel.
- When TTS is disabled, the result is `output_skipped` with reason
  `tts_disabled`; it is not success.
- These observations update Kernel/dashboard state but MUST NOT call
  `sendObservationToChatGPT` in Phase 1.
- Diagnostics record the requested emotion and intensity. They must describe
  them as requested delivery, not confirmed perceived emotion.
- Error payloads must be sanitized and must not include API keys or raw provider
  bodies that may contain sensitive details.
- On startup, a replayed final `speech.output_started` without a terminal event
  MUST be reconciled and persisted as `speech.output_interrupted` with reason
  `kernel_restart`.

Recommended complete-state shape:

```json
{
  "output": {
    "tts": {
      "playing": false,
      "last_status": "completed",
      "last_turn_id": "obs_123",
      "requested_emotion": "fear",
      "requested_intensity": 0.4,
      "updated_at": "..."
    }
  }
}
```

This is operational/body-output state. It does not belong in the world model.

### 6.4 ASR/TTS echo guard

The system MUST prevent a quiet-room feedback loop in which Kokomi's own TTS is
committed by ASR as new user input.

Use layered protection:

1. Keep browser microphone echo cancellation enabled.
2. Track the original normalized speech text and actual playback interval in
   the Kernel.
3. For a committed ASR segment observed during playback or within
   `tts.echoGuardMs` after completion, compare it with the recent TTS text.
4. Suppress it only when either normalized text contains the other with a
   meaningful length, or normalized edit similarity is at least 0.72.
5. Return `{"status":"echo_suppressed"}` and record a sanitized diagnostic.

Normalization for the comparison SHOULD apply Unicode NFKC, lowercase Latin
letters, and remove whitespace and punctuation. It MUST NOT alter the actual
committed text that is sent when the input is accepted.

A dissimilar human utterance during TTS MUST still be accepted. Stopping current
playback when the user interrupts (barge-in) is deferred; Phase 1 only prevents
self-transcription and preserves the new human turn.

## 7. Protocol compatibility

- Keep cognitive-context protocol version `1.2`.
- Keep the existing LLM output schema unchanged.
- The ASR committed trigger may add `modality` and an `asr` metadata object to
  `trigger.payload`; this is an additive input change.
- `control_prompt.md` should state that `interaction.user_input` may originate
  from typed or committed ASR input and that only committed text is a user
  statement.
- No ASR provider response, token, partial transcript, or TTS provider tag is
  accepted as an LLM command.

## 8. Logging, privacy, and dashboard behavior

- Never log API keys or single-use Scribe tokens.
- Partial text is transient and is not written to `observations.jsonl`.
- Committed text is persisted under the existing user-input policy because it
  becomes conversation input.
- Dashboard activity should show ASR connection, partial activity without text
  by default, committed delivery status, and TTS requested/started/completed or
  failed state.
- A debug mode MAY display partial text locally, but it must default to off in
  durable logs.
- Public status APIs must not expose credentials, provider tokens, or raw error
  bodies.

## 9. Failure behavior

| Failure | Required behavior |
| --- | --- |
| ASR disabled | Token route returns 503; typed input continues working |
| Missing API key with ASR enabled | Clear startup/configuration error; no secret output |
| Partial POST lost | No LLM turn; later partial or committed event may continue |
| Committed POST retried | Same event ID is accepted exactly once |
| ChatGPT unavailable | Committed endpoint returns 503; retry with same ID is safe |
| TTS disabled | Audited text remains visible/logged; playback outcome is skipped |
| ElevenLabs TTS HTTP failure | Failed outcome; process and subsequent queue remain usable |
| `ffplay` missing or exits non-zero | Failed outcome; no successful-playback claim |
| Invalid emotion/intensity | Rejected before provider call |
| Suspected self-transcription | Suppressed only when time and text similarity both agree |

## 10. Tests

### 10.1 Unit tests

Add tests proving:

1. ASR request validation rejects unknown fields, invalid IDs, invalid kinds,
   invalid revisions, invalid timestamps, and oversized text.
2. Partial input updates transient state and never calls the LLM bridge.
3. Partial text is not persisted and becomes stale after the configured TTL.
4. A committed transcript produces one `interaction.user_input` with
   `source = elevenlabs_scribe` and `modality = speech`.
5. A repeated committed event ID does not produce another cognitive turn.
6. Committing clears partial state for that segment.
7. The token endpoint never serializes or logs the API key or returned token.
8. All eight allowed emotions map deterministically.
9. Intensities 0, 0.5, and 1 produce correctly bounded/interpolated stability;
   v3 omits unsupported settings and compatible non-v3 models retain their
   configured settings.
10. Neutral produces no tag, while other emotions add exactly one configured
    tag without modifying the original audited text.
11. TTS-disabled, HTTP-failed, playback-failed, and playback-completed paths
    produce distinct outcomes.
12. A failed queue item does not prevent the next TTS item from running.
13. Similar TTS loopback text in the echo window is suppressed; dissimilar
    human speech is accepted.
14. `EPIPE` and termination during backpressure do not crash or hang playback.
15. Replayed unfinished TTS is persisted as interrupted exactly once.
16. The browser SDK dependency is pinned to an explicit version.
17. Existing typed `/user_input` behavior and all current tests remain valid.

Network and process behavior must be dependency-injected or mocked. Automated
tests MUST NOT call ElevenLabs or require a real audio device.

### 10.2 Manual acceptance tests

With ASR and TTS explicitly enabled:

1. Open the Kernel-served ASR client and grant microphone permission.
2. Speak one Japanese sentence while watching partial text update.
3. Confirm that no ChatGPT prompt is sent before a committed event.
4. Confirm that exactly one cognitive context appears after commit and its
   trigger has `modality: speech`.
5. Repeat/retry the same committed event ID and confirm no duplicate response.
6. Produce responses using at least `neutral`, `happy`, `sad`, and `thinking`;
   inspect the outgoing provider request and listen to the output.
7. Confirm the requested emotion/intensity and playback result appear in local
   diagnostics as separate concepts.
8. Let the TTS play into the microphone in a quiet room and confirm it does not
   create a new user turn.
9. Speak a clearly different sentence during TTS and confirm it is preserved as
   a new user turn.
10. Stop ElevenLabs access or make `ffplay` unavailable and confirm failure is
    reported without stopping the Kernel.

Audible emotional difference is not, by itself, a deterministic software
acceptance criterion. The objective software criterion is that the correct
delivery profile reaches the provider. Perceived-emotion quality should later
be evaluated as an HRI/voice experiment.

## 11. Definition of done

Phase 1 is complete only when:

- partial and committed Scribe events reach the Kernel through validated JSON;
- partial events never start LLM turns or enter durable storage;
- each committed segment starts exactly one normal cognitive turn;
- the port conflict and token logging in the current prototype are removed;
- the existing `emotion` and `intensity` fields materially change the bounded
  ElevenLabs request through a provider-specific adapter;
- TTS playback has distinguishable requested, started, completed, failed, and
  skipped states;
- basic self-transcription feedback is prevented without discarding dissimilar
  human speech;
- automated tests pass without external services;
- README and `control_prompt.md` describe the new behavior and limitations;
- TTS and ASR remain disabled by default until explicitly configured and tested.

## 12. Explicit non-goals for this phase

Do not add the following while implementing this specification:

- filler or backchannel audio playback;
- VAP/MaAI timing prediction;
- YAMNet or sneeze classification;
- speaker diarization or identity inference;
- emotional inference from the user's voice;
- automatic long-term memory from partial ASR text;
- replacement of ChatGPT browser transport or the JSON protocol;
- full barge-in/cancellation of current TTS playback;
- claims that an emotion was perceived merely because a TTS tag was requested.

## 13. Primary references

- ElevenLabs Realtime STT event reference:  
  <https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference>
- ElevenLabs transcripts and VAD commit strategies:  
  <https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies>
- ElevenLabs streaming TTS API:  
  <https://elevenlabs.io/docs/api-reference/text-to-speech/stream>
- Eleven v3 audio tags:  
  <https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-alpha>

## 14. Suggested implementation handoff prompt

The following prompt can be given to another coding task:

> Implement `docs/voice-io-phase1-spec.md` completely on the current branch.
> Preserve the existing JSON cognitive protocol and unrelated user changes.
> First inspect the current ASR prototypes, TTS queue, observation/state path,
> turn registry, and tests. Implement only Phase 1; do not add fillers or audio
> classification. Use mocked external I/O in tests, run the complete test suite,
> update README/control prompt, and report any manual hardware/service checks
> that remain.
