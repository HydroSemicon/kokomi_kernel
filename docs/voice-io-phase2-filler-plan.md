# Voice I/O Phase 2: Local Filler and Backchannel Plan

Status: Stage 2A implemented; Stage 2B implemented but independently unarmed
Depends on: `docs/voice-io-phase1-spec.md`  
Runtime generation: deterministic Kernel policy plus local audio clips  
Default state: thinking filler armed with validated local clips; listening backchannel unarmed

## 1. Goal

Reduce unnatural silence without allowing a small generative model to invent
content before the main LLM has understood the user.

Two behaviors are intentionally separated:

1. **Thinking filler**: a short floor-holding sound after committed ASR while
   the main LLM/TTS response is not ready, for example `んー…`.
2. **Listening backchannel**: a short listener response during an ongoing ASR
   segment, for example `うん`.

They differ in timing, conversational meaning, and acoustic risk. Thinking
fillers are implemented and tested first. Backchannels remain separately armed
until microphone echo behavior has been measured on the actual robot.

## 2. Why this is not a local LLM

A runtime language model is unnecessary for the initial research question and
adds latency, nondeterminism, semantic leakage, model maintenance, and another
failure mode. A bounded local controller can choose from clips whose meaning is
known in advance.

The first implementation therefore consists of:

```text
ASR/turn/TTS events
       |
       v
Filler policy state machine
       |
       v
Validated clip manifest
       |
       v
Single audio-output coordinator
       |
       v
Local file playback
```

A learned turn-taking model such as MaAI/VAP can later replace only the timing
policy. It must not be required to validate the basic HRI effect.

## 3. Research-facing hypotheses

The implementation should make these comparisons possible without rewriting
the voice stack:

- no filler versus thinking filler;
- fixed timing versus later learned timing;
- verbal filler versus a nonverbal bodily cue;
- one filler style versus another;
- filler latency and frequency versus perceived responsiveness;
- filler use versus interruptions, annoyance, and perceived understanding.

For reproducibility, every eligibility decision, selected clip, timing event,
and suppression reason must be observable. Random behavior must be seeded or
disabled during experiments.

## 4. Safety and semantic boundary

Before the main response is available, filler audio MUST NOT assert facts,
agreement, comprehension, consent, completion, or emotion inferred from the
user.

Allowed initial meanings:

| Kind | Safe examples | Meaning |
| --- | --- | --- |
| `thinking` | `んー…`, `ええと…` | processing/hesitation only |
| `listening` | `うん`, a short nonlexical hum | continued attention only |

Disallowed initial clips include:

- `わかった` and `理解した`;
- `そうだね` and `その通り`;
- `大丈夫` and other reassurance;
- `もちろん` and other commitments;
- answers, apologies, health judgments, or action-success claims.

Every manifest entry must declare `semantic_commitment: "none"` or
`"attention_only"`. Phase 2 rejects all other values.

## 5. Staged delivery

### Stage 2A: thinking filler

Implement first because the user turn has already been committed, so the filler
cannot contaminate that utterance.

Trigger sequence:

```text
ASR committed
   |
   +-- start a per-turn delay timer
   |
   +-- main response becomes ready before timer --> cancel silently
   |
   `-- timer expires and all gates pass ----------> play one local clip
                                                      |
                                   main TTS waits for/coordinates with clip
```

Implemented timing:

- schedule at 1000 ms after the committed transcript is accepted;
- play at most one thinking filler per turn;
- do not start if main LLM output has already been accepted;
- do not start if the user has begun another utterance;
- generated clips are bounded to 1800 ms (the current thinking set is 806-999 ms);
- apply a global 4-second cooldown;
- main semantic speech always has priority.

### Stage 2B: listening backchannel

Implement behind an independent arm flag only after Stage 2A and an acoustic
echo test pass.

Initial eligibility recommendation:

- the same ASR segment has remained active for at least 1.8 seconds;
- the current partial contains at least 8 Japanese characters after
  normalization;
- the partial has changed since the last decision;
- no TTS, filler, or other backchannel is playing;
- no backchannel has been used in the segment;
- at least 6 seconds have passed since the last backchannel;
- a speech boundary or operator mute does not deny output.

The first version should use deterministic eligibility. If variation is needed,
derive it from a configured experiment seed plus session and segment IDs; never
use unlogged `Math.random()`.

## 6. Clip manifest

Use uncompressed WAV files for predictable startup and duration. The manifest
is versioned separately from the audio files so experiments can identify the
exact stimulus set.

Suggested layout:

```text
data/runtime/fillers/manifest.json
data/runtime/fillers/thinking_01.wav
data/runtime/fillers/thinking_02.wav
data/runtime/fillers/listening_01.wav
```

Suggested manifest:

```json
{
  "schema_version": "1.0",
  "set_id": "kokomi-fillers-ja-v1",
  "voice_id": "configured-voice-id",
  "generator": "elevenlabs",
  "generator_model": "eleven_v3",
  "created_at": "2026-09-11T00:00:00.000Z",
  "clips": [
    {
      "id": "thinking_01",
      "kind": "thinking",
      "text": "んー…",
      "path": "thinking_01.wav",
      "duration_ms": 620,
      "emotion": "thinking",
      "intensity": 0.25,
      "semantic_commitment": "none"
    },
    {
      "id": "listening_01",
      "kind": "listening",
      "text": "うん",
      "path": "listening_01.wav",
      "duration_ms": 340,
      "emotion": "calm",
      "intensity": 0.2,
      "semantic_commitment": "attention_only"
    }
  ]
}
```

Manifest validation must reject:

- unknown fields or kinds;
- duplicate IDs;
- paths outside the configured asset directory;
- missing or non-WAV files;
- missing/invalid duration;
- clips longer than the configured maximum;
- unapproved semantic commitments;
- emotion/intensity outside the existing LLM/TTS protocol;
- an empty clip set when filler is armed.

Whether generated voice assets may be committed publicly must be decided from
their voice/license terms. If not, commit a manifest template and keep local
audio under an ignored runtime asset directory.

## 7. Configuration

Add a configuration section conceptually equivalent to:

```json
{
  "filler": {
    "enabled": true,
    "armed": true,
    "manifestPath": "data/runtime/fillers/manifest.json",
    "experimentSeed": "kokomi-fillers-v1",
    "maxClipDurationMs": 1800,
    "globalCooldownMs": 4000,
    "thinking": {
      "enabled": true,
      "delayMs": 1000,
      "maxPerTurn": 1
    },
    "listening": {
      "enabled": false,
      "armed": false,
      "minimumSpeechMs": 1800,
      "minimumPartialCharacters": 8,
      "cooldownMs": 6000,
      "maxPerSegment": 1
    }
  }
}
```

`enabled` allows the subsystem to initialize. `armed` authorizes automatic
sound output. Listening backchannels require both the global and listening arm
flags. Defaults must produce no automatic sound.

## 8. Components

Suggested responsibilities:

```text
src/speech/filler-manifest.js
  - load and validate manifest
  - resolve safe paths
  - expose immutable eligible clips

src/speech/filler-controller.js
  - maintain per-turn and per-segment state
  - schedule/cancel decisions
  - apply cooldown and semantic gates
  - select deterministically

src/speech/local-clip-player.js
  - play a validated WAV through ffplay
  - return started/completed/failed/cancelled outcomes
  - handle EPIPE, process exit, and shutdown

src/speech/playback-coordinator.js
  - enforce a single audible output lane
  - prevent filler/main-TTS overlap
  - give main semantic speech priority
  - expose current output kind and cancellation
```

Do not make `alice.js` itself the state machine. It should wire events into
these components and record their observations.

## 9. Event hooks

The controller should receive these existing lifecycle points:

- ASR partial accepted;
- ASR committed context accepted/dispatched;
- audited LLM output accepted for a `turn_id`;
- main TTS requested/started/completed/failed;
- Kernel shutdown/restart;
- accepted speech boundary or operator mute.

Required behavior:

- committed ASR schedules a thinking decision;
- valid LLM output cancels a not-yet-started thinking filler;
- an ASR partial from a new utterance cancels a thinking filler that has not
  started and SHOULD stop a playing filler;
- main TTS prevents new fillers and owns the output lane when ready;
- filler observations never call `sendObservationToChatGPT`;
- typed input does not trigger filler in the first version.

## 10. Playback coordination

Only one audible stream may own the speaker at a time.

Priority order:

```text
main semantic TTS > thinking filler > listening backchannel
```

When a main TTS request arrives:

1. Start the remote TTS request without waiting for a scheduled filler.
2. Prevent any new filler from starting.
3. If a short filler is already playing, allow it to finish only within the
   configured maximum; otherwise cancel it.
4. Acquire the output lane before piping the first main-audio chunk to ffplay.
5. Release the lane on completion, failure, cancellation, or player exit.

The remote stream may begin buffering while the local clip finishes. This masks
some TTS-generation latency without overlapping voices. No filler failure may
delay or cancel the main response.

The existing ffplay error/backpressure handling should be extracted or reused;
do not create a second less-safe process implementation.

## 11. Echo and ASR interaction

Every audible filler must be registered with the existing echo guard using a
unique output ID, its exact transcript, and actual playback interval.

Thinking filler occurs after commit, so a separate ASR segment containing only
the filler can be suppressed normally. Listening backchannels are harder: their
audio can become part of the user's still-open ASR segment. Text-similarity
suppression after commit cannot reliably remove one embedded `うん`.

Therefore listening backchannels remain unarmed until a manual test demonstrates
that the actual microphone/speaker/browser echo cancellation prevents transcript
contamination. If it does not, prefer one of these follow-ups:

1. play the backchannel through the browser audio context so WebRTC AEC has a
   better playback reference;
2. use a nonverbal LED/head/body cue instead of audio;
3. add a duplex audio frontend with an explicit playback reference.

Main TTS and post-commit thinking fillers use a deliberate half-duplex capture
gate: the browser closes Scribe before playback and reconnects after playback.
This prevents self-transcription but deliberately gives up barge-in during robot
speech. Listening backchannels do not use that gate because muting them would
discard the user's still-active speech; they therefore remain unarmed until the
actual-device echo experiment passes.

## 12. Filler observations and state

Emit internal, durable control observations:

```text
speech.filler_scheduled
speech.filler_started
speech.filler_completed
speech.filler_cancelled
speech.filler_failed
speech.filler_suppressed
```

Minimum payload:

```json
{
  "filler_id": "filler_...",
  "clip_id": "thinking_01",
  "kind": "thinking",
  "turn_id": "asr_...",
  "session_id": "session_...",
  "segment_id": "segment_...",
  "scheduled_at": "...",
  "started_at": "...",
  "completed_at": "...",
  "status": "completed",
  "reason": "response_not_ready_after_delay",
  "policy_version": "1.0",
  "manifest_set_id": "kokomi-fillers-ja-v1"
}
```

Suppression reasons should be stable enums, including:

```text
disabled
unarmed
main_response_ready
user_resumed_speaking
speech_boundary_denied
cooldown_active
already_used_for_turn
already_used_for_segment
output_lane_busy
clip_unavailable
listening_unarmed
```

Kernel state should expose the current filler status and latest outcome. It
must not describe a requested/performed filler as proof of user understanding.

## 13. Metrics

Record monotonic durations where possible:

- ASR committed to filler start;
- ASR committed to audited LLM response;
- ASR committed to main TTS start;
- filler end to main TTS start;
- total filler duration;
- scheduled, played, cancelled, failed, and suppressed counts by reason;
- fillers per conversation and per user-speaking minute;
- detected ASR echo events following filler playback;
- number of committed transcripts containing the filler text during Stage 2B
  acoustic validation.

These are operational measurements, not conclusions about user experience.

## 14. Failure and recovery

- Missing/invalid manifest disables filler and leaves ASR/TTS operational.
- Missing/corrupt clip records `speech.filler_failed`; main TTS continues.
- Player failure cannot poison the main TTS FIFO or output lane.
- Kernel shutdown cancels timers and terminates local filler playback.
- A replayed `speech.filler_started` without a terminal event becomes
  `speech.filler_interrupted` with reason `kernel_restart`.
- Scheduled timers are not restored after restart.
- A stale turn or segment can never start a filler after its TTL.

## 15. Tests

Automated tests must not require an audio device, ElevenLabs, or real time.

Required cases:

1. Manifest path traversal, duplicates, invalid kinds, long clips, and semantic
   commitments are rejected.
2. A committed ASR turn schedules exactly one thinking filler.
3. An audited response before 1000 ms cancels the scheduled filler.
4. A slow response starts one thinking clip after the configured delay.
5. New user speech cancels or stops the thinking filler.
6. Typed input does not trigger a filler.
7. Disabled/unarmed/boundary/cooldown states suppress with the correct reason.
8. Selection is deterministic for the same seed and IDs.
9. Main TTS and filler never own the output lane simultaneously.
10. Main TTS proceeds when filler playback fails.
11. Filler audio is registered in the echo guard.
12. Listening backchannel requires its separate arm flag and occurs at most once
    per ASR segment.
13. Filler observations never start LLM turns.
14. Restart reconciliation closes unfinished filler playback once.
15. Existing ASR, TTS, behavior, action, memory, and social tests remain valid.

## 16. Manual acceptance sequence

### Stage 2A

1. Use one short verified thinking WAV and enable/arm only thinking filler.
2. Speak a sentence using the observed real response latency (tests use a fake timer).
3. Confirm filler starts near the configured delay and main TTS follows without
   overlap.
4. Remove the delay and confirm fast responses do not emit unnecessary filler.
5. Begin another utterance while filler is playing and confirm it stops.
6. Disconnect the clip/player and confirm the main response still plays.
7. Confirm filler audio does not create a second user turn.

### Stage 2B

1. Keep listening output unarmed and first log eligibility decisions only.
2. Record user speech with simulated backchannel playback through the actual
   robot microphone/speaker arrangement.
3. Inspect committed transcripts for inserted `うん` or other contamination.
4. Arm audible listening backchannels only if contamination is acceptably low.
5. Confirm at most one backchannel per segment and no backchannel during main
   TTS.

## 17. Definition of done

Phase 2 is complete when:

- Stage 2A works with local, versioned, semantically bounded clips;
- fast responses cancel filler while slow responses receive at most one;
- main TTS never overlaps and is never blocked by filler failure;
- all decisions and timings are inspectable and reproducible;
- automatic audio remains disabled/unarmed by default;
- Stage 2B is independently gated and cannot be enabled accidentally;
- actual-device echo contamination has been measured before Stage 2B is armed;
- complete automated tests pass;
- README documents setup, asset provenance, safety gates, and experimental
  limitations.

## 18. Recommended implementation order

1. Manifest loader and fake local player.
2. Deterministic filler controller with fake clock/timers.
3. Thinking-filler lifecycle and Alice event hooks.
4. Single output-lane coordination with current TTS.
5. Real WAV playback and echo-guard registration.
6. Dashboard state/metrics and restart reconciliation.
7. Stage 2A manual test.
8. Listening eligibility in log-only mode.
9. Actual-device echo experiment.
10. Optional Stage 2B arming.

Do not add MaAI/VAP or a local generative model until Stage 2A measurements
show that fixed timing is insufficient for the research question.
