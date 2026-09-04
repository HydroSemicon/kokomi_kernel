You are modifying an existing Node.js robot control kernel.

Files:
- alice.js: current implementation
- command_list.md: protocol requirements

Goal:
Refactor alice.js from the old @command@ string protocol to a fully JSON-based protocol.

The old protocol must be removed:
- @MTxxxxxx;@
- @LTxxxxxx;@
- @THP@
- @vision:...@
- @PERSON_EVENT@

The new protocol:
- All communication between LLM and Kernel must be JSON only.
- All communication from Kernel to Raspberry Pi must also be JSON.
- A single message must be one JSON object.
- The JSON object may contain any combination of supported blocks.
- Do not require speech, actions, and requests to all appear at the same time.

LLM → Kernel valid top-level fields:
- speech
- emotion
- intensity
- actions
- requests

At least one of these functional blocks must exist:
- speech
- actions
- requests

Speech block:
If "speech" exists:
- "emotion" must also exist.
- "intensity" must also exist.
- "speech" must be a string.
- "emotion" must be one of:
  neutral, happy, calm, sad, angry, surprised, fear, thinking
- "intensity" must be a number from 0.0 to 1.0.

If "speech" does not exist:
- "emotion" and "intensity" must not exist.

Example speech-only JSON:
{
  "speech": "今日は少し暑いですね",
  "emotion": "calm",
  "intensity": 0.4
}

Actions:
"actions" is optional.
If present, it must be an array.
Each action must be an object with exactly:
- type
- params

Allowed action types:
1. tear
{
  "type": "tear",
  "params": {
    "speed": 10,
    "duration": 5
  }
}
Rules:
- speed must be an integer from 0 to 255.
- duration must be an integer from 0 to 255.
- Missing params are invalid.
- Extra params are invalid.

2. led_change
{
  "type": "led_change",
  "params": {
    "color": "#00FF00"
  }
}
Rules:
- color must be a string in #RRGGBB format.
- Missing params are invalid.
- Extra params are invalid.

Multiple actions must be represented as separate items in the actions array.
Do not combine multiple action types into one "type" field.

Example:
{
  "actions": [
    {
      "type": "tear",
      "params": {
        "speed": 10,
        "duration": 5
      }
    },
    {
      "type": "led_change",
      "params": {
        "color": "#00FF00"
      }
    }
  ]
}

Requests:
"requests" is optional.
If present, it must be an array.

Allowed string requests:
- temperature
- humidity
- pressure

Allowed object request:
{
  "type": "vision",
  "params": {
    "task": "describe_scene"
  }
}

Rules:
- For vision, task must be exactly "describe_scene".
- Missing params are invalid.
- Extra params are invalid.
- Unknown request types are invalid.

Example request-only JSON:
{
  "requests": [
    "temperature",
    {
      "type": "vision",
      "params": {
        "task": "describe_scene"
      }
    }
  ]
}

Kernel → LLM JSON:
When sending user input:
{
  "user_input": "気分はどう？"
}

When sending sensor data:
- Include only the requested sensor fields.
- Do not require temperature, humidity, and pressure to appear together.
- The units object must include only the units corresponding to the included sensor fields.

Temperature only:
{
  "sensor": {
    "temperature": 24.31
  },
  "units": {
    "temperature": "celsius"
  }
}

Temperature + humidity:
{
  "sensor": {
    "temperature": 24.31,
    "humidity": 51.22
  },
  "units": {
    "temperature": "celsius",
    "humidity": "percent"
  }
}

All three:
{
  "sensor": {
    "temperature": 24.31,
    "humidity": 51.22,
    "pressure": 1008.14
  },
  "units": {
    "temperature": "celsius",
    "humidity": "percent",
    "pressure": "hpa"
  }
}

When sending vision input, attach the camera image to the same message:
{
  "vision": {
    "task": "describe_scene",
    "query": "describe the scene",
    "input": "attached_image"
  }
}

When sending person event:
{
  "event": {
    "source": "deepsort",
    "type": "person_appeared",
    "message": "A person has appeared."
  }
}

Implementation requirements:
1. Remove the old @...@ command parser completely.
2. Replace it with JSON extraction/parsing from ChatGPT assistant output.
3. ChatGPT output may stream partially, so buffer text until complete JSON objects can be parsed.
4. Parse only complete JSON objects.
5. Add an audit layer before executing anything.
6. If JSON parse fails because the object is incomplete, keep buffering.
7. If JSON parse fails because the content is invalid, log and discard safely.
8. If audit fails, log the reason and do not execute actions or requests.
9. Never send invalid data to Raspberry Pi.
10. Keep the existing Puppeteer browser setup.
11. Keep the existing YOLO Express endpoint.
12. Keep existing BME280 polling.
13. Keep the existing runLLaVA function as a clearly marked legacy fallback, but do not call it from the active vision path.

Raspberry Pi endpoints:
Use existing paths but send JSON.

For tear:
POST http://kokomi.local:5000/motor/command
Content-Type: application/json
Body:
{
  "type": "tear",
  "params": {
    "speed": 10,
    "duration": 5
  }
}

For LED:
POST http://kokomi.local:5000/led/command
Content-Type: application/json
Body:
{
  "type": "led_change",
  "params": {
    "color": "#00FF00"
  }
}

Sensor endpoint:
GET http://kokomi.local:5000/bme280/sensor_data

Vision snapshot endpoint:
GET http://localhost:5000/snapshot

Action execution:
- For each audited action:
  - tear → POST JSON to /motor/command.
  - led_change → POST JSON to /led/command.
- Use Content-Type: application/json.

Request execution:
- If requests include temperature, humidity, or pressure:
  - Use latestSensor.
  - Return only requested fields.
  - Include corresponding units only.
  - Send the result to ChatGPT as JSON.
- If requests include vision describe_scene:
  - fetch the image from the vision snapshot endpoint.
  - paste the image into ChatGPT and send it with the vision input JSON.
  - do not convert the image to a text description first.

Speech:
- If audited JSON contains speech:
  - log speech, emotion, and intensity.
  - Do not implement TTS yet.
  - Add a clear TODO comment where TTS will be called later.

YOLO event:
- Current /yolo_event must stop sending plain Japanese text.
- It must send this JSON to ChatGPT:
{
  "event": {
    "source": "deepsort",
    "type": "person_appeared",
    "message": "A person has appeared."
  }
}

Code organization:
Add or implement these functions:
- extractCompleteJsonObjects(buffer)
- auditLLMJson(payload)
- validateSpeech(payload)
- validateActions(actions)
- validateRequests(requests)
- executeAuditedPayload(payload)
- sendJsonToChatGPT(obj)
- sendActionToPi(action)
- buildSensorResponse(requests)

Audit rules:
- Unknown top-level fields are invalid.
- Missing required fields are invalid.
- Extra params inside actions/requests are invalid.
- Wrong types are invalid.
- Out-of-range numeric values are invalid.
- Invalid HEX colors are invalid.
- Invalid emotion values are invalid.
- Invalid intensity values are invalid.

Important:
- Do not introduce TypeScript.
- Keep ES module syntax.
- Keep dependencies minimal.
- Use clear console logs for:
  - parsed JSON
  - accepted JSON
  - rejected JSON
  - executed actions
  - executed requests
- Avoid large architectural rewrites beyond what is necessary.
- Preserve current functionality as much as possible, except for protocol migration.

Output:
Return the complete updated alice.js.
