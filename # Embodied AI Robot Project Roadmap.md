# Embodied AI Robot Project Roadmap

### Core Philosophy

This project is not just a chatbot or an autonomous coding agent.

The goal is to build a physical embodied AI system with:

* perception
* internal state
* reactive behavior
* long-term cognition
* physical actions
* social interaction
* autonomous behavior

The architecture is centered around a custom Kernel.

---

## System Architecture

### Current architecture

```text
Sensors / Events
->
alice.js (Kernel)
->
LLM (ChatGPT)
->
JSON output
->
Raspberry Pi hardware server
->
Physical world
```

---

## Role Definitions

### Kernel

The Kernel is the authority of the system.

Responsibilities:

* event routing
* state management
* world model integration
* safety auditing
* action dispatch
* request dispatch
* scheduling
* priority control
* agent orchestration
* resource management

The Kernel must always remain the final authority.

---

### LLM

The LLM is the cognitive layer.

Responsibilities:

* speech generation
* short-term reasoning
* emotional behavior
* interpretation
* high-level decisions

The LLM does NOT directly control hardware.
All outputs must pass through the Kernel audit layer.

---

### Codex / Agents

Codex agents are external workers.

Responsibilities:

* code generation
* debugging
* repository analysis
* long-running web tasks
* browser automation
* maintenance
* protocol migration

Codex is NOT the runtime authority.

Kernel > Agent hierarchy must be preserved.

---

## Layered Architecture

### 1. RT Layer (Real-Time Layer)

Fast low-level hardware control.

Examples:

* GPIO
* PWM
* sensor polling
* motor control
* LED control

Requirements:

* deterministic
* low latency
* fail-safe

---

### 2. Reactive Layer

Event-driven behavior system.

Examples:

* touch events
* person detection
* reflexive reactions
* immediate emotional responses

Responsibilities:

* event queue
* debounce
* priority control
* safety stop

alice.js currently mostly exists here.

---

### 3. Cognitive Layer

High-level reasoning.

Examples:

* conversation
* interpretation
* planning
* emotional context
* social behavior

Implemented primarily through ChatGPT.

---

### 4. Agent Layer (Future)

Long-running autonomous tasks.

Examples:

* browser automation
* EC site purchases
* information gathering
* software maintenance
* autonomous coding
* file organization

Implemented through Codex-like agents.

---

## Current Protocol Design

### LLM communication

JSON-only protocol.

Allowed top-level blocks:

* speech
* actions
* requests

Design principles:

* explicit semantics
* auditability
* extensibility
* separation of cognition and execution

---

### Action philosophy

Actions must represent semantic intent.

Good:

```json
{
  "type": "tear",
  "params": {
    "speed": 10,
    "duration": 5
  }
}
```

Bad:

```text
MTFF0A00;
```

The system should communicate meaning, not opaque bytes.

---

## Current Components

### alice.js

Current role:

* LLM control harness
* lightweight behavior kernel

Responsibilities:

* ChatGPT connection
* JSON extraction
* JSON audit
* sensor routing
* action dispatch
* VLM integration
* event integration
* TTS orchestration

---

### kokomi_raspi.py

Current role:

* hardware server

Responsibilities:

* GPIO
* PWM
* sensor acquisition
* actuator execution

---

## Current Working Features

### Completed

* JSON-only protocol
* speech/actions/requests separation
* Raspberry Pi JSON control
* LED control
* tear motor control
* BME280 integration
* VLM integration
* YOLO event integration
* touch event architecture
* remote-debugging Chrome integration
* user_input endpoint
* JSON audit layer

---

## Immediate Next Steps

### 1. Event System Expansion

Add:

* touch sensors
* multiple body regions
* event queue
* event priorities

---

### 2. State Management

Add:

* short-term state
* emotional persistence
* interaction context
* cooldown systems

Examples:

* recent touch history
* current mood
* active conversation state

---

### 3. World Model

Separate:

* raw sensor data
* interpreted world understanding

Examples:

* "person detected"
* "being petted"
* "room is dark"

instead of only raw values.

---

### 4. Safety System Expansion

Add:

* thermal limits
* battery protection
* motor cooldown
* current monitoring
* action rate limiting

All safety decisions must remain inside the Kernel.

---

### 5. Speech System

Integrate:

* ElevenLabs TTS
* emotion-aware speech
* interruptible playback
* speech queueing

---

### 6. Memory Architecture

Future categories:

* episodic memory
* persistent preferences
* social memory
* environmental memory

---

## Future Research Directions

### Autonomous Behavior

Goal:

* self-initiated interaction
* curiosity
* spontaneous speech
* environmental awareness

Possible implementation:

* periodic internal prompts
* world-state-driven impulses
* event-triggered cognition

---

### Embodied Emotion

Emotion should emerge from:

* state
* context
* memory
* physical interaction

NOT simple hardcoded mappings.

Example:

* sadness does not always imply tears

---

### Physical Body Development

Potential directions:

* humanoid skeleton
* soft robotics
* silicone skin
* tactile sensing
* thermal circulation
* expressive face

---

### Advanced Sensor Systems

Potential future systems:

* tactile arrays
* IMU/body orientation
* depth cameras
* near-IR spectroscopy
* pressure sensing
* distributed touch surfaces

---

## Codex Integration Philosophy

Codex should accelerate development, not replace the Kernel.

Correct architecture:

```text
Kernel
|-- Runtime control
|-- Safety
|-- State/world
`-- Agent orchestration
      |
   Codex agents
```

NOT:

```text
Codex controls hardware directly
```

---

## AGENTS.md Philosophy

AGENTS.md should become the persistent architectural memory for coding agents.

Responsibilities:

* preserve design principles
* preserve protocol consistency
* prevent architectural drift
* encode project philosophy

---

## Long-Term Vision

Ultimate goal:

A physically embodied AI system with:

* persistent identity
* emotional continuity
* autonomous behavior
* physical interaction
* self-maintenance
* long-term adaptation

The Kernel remains the central nervous
