Modify alice.js to fix the JSON streaming/parsing instability.

Current problem:
ChatGPT output is streamed and the current page monitor sends small text diffs to onPartialOutput().
This causes JSON objects to be split into fragments and sometimes parsed before the full object is complete.
Also, the initial user_input message contains an embedded JSON example, which can be mistakenly extracted as executable JSON.

Goals:
1. Stop sending tiny diffs from the browser monitor.
2. Send the full current assistant message text to onPartialOutput().
3. Prevent the same completed JSON object from being processed multiple times.
4. Remove the embedded JSON example from the initial user_input message.
5. Keep the existing JSON audit layer and execution behavior.

Required changes:

A. Find the initial sendJsonToChatGPT call near startup.

Current behavior roughly:
sendJsonToChatGPT({
  user_input: "Ready. Use JSON only. You may request vision with { ... }."
});

Change it to:
sendJsonToChatGPT({
  user_input: "Ready. Use JSON only."
});

Do not include JSON examples inside user_input strings.

B. In the Puppeteer page.evaluate() monitor, change the output detection logic.

Current logic computes:
const newPart = currentText.slice(lastText.length);
window.onPartialOutput(`[ChatGPT #${idx}] ${newPart}`);

Replace it so that when the assistant message changes, it sends the full currentText:

if (currentText && currentText !== lastText) {
  lastContents.set(container, currentText);
  window.onPartialOutput(currentText);
}

Do not prefix with [ChatGPT #idx].
Do not split into lines.

C. Because full currentText will be sent repeatedly while streaming, add duplicate prevention in Node.

Near:
let streamBuffer = "";

add:
const processedJsonTexts = new Set();

Then in the loop:
for (const jsonText of extracted.objects) {
  ...
}

before JSON.parse, add:

if (processedJsonTexts.has(jsonText)) {
  continue;
}
processedJsonTexts.add(jsonText);

D. Make sure extractCompleteJsonObjects() still returns only complete JSON objects.
Do not execute incomplete JSON.
If no complete JSON object exists, keep buffering.

E. Preserve:
- auditLLMJson()
- executeAuditedPayload()
- sendJsonToChatGPT()
- YOLO event endpoint
- sensor polling
- runLLaVA()
- Raspberry Pi JSON POST behavior

F. Do not introduce new dependencies.
Do not convert to TypeScript.
Keep ES module syntax.

Output:
Return the complete updated alice.js.