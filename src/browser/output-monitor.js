// Self-contained: Puppeteer serializes this function into the page.
export function chatOutputMonitor({ assistantOutputSelector, outputPollIntervalMs, mode = "install" }) {
    function collect() {
        const messages = new Map();
        for (const element of document.querySelectorAll(assistantOutputSelector)) {
            const modern = element.closest('[data-chatgpt-search-unit-key$=":assistant"]');
            const legacy = element.closest('[data-message-author-role="assistant"]');
            if (!modern && !legacy) continue; // Never parse user-input JSON as model output.
            const key = modern?.getAttribute("data-chatgpt-search-unit-key");
            const turn = legacy?.closest('[data-testid^="conversation-turn-"]');
            const number = key?.match(/^fallback-turn-(\d+):/u)?.[1]
                ?? turn?.getAttribute("data-testid")?.match(/^conversation-turn-(\d+)$/u)?.[1];
            const ids = modern?.getAttribute("data-chatgpt-search-message-ids")?.trim().split(/\s+/u);
            const id = ids?.[0] || legacy?.getAttribute("data-message-id") || key;
            if (!id) continue;
            const root = modern ?? legacy;
            const text = (root.innerText ?? root.textContent ?? "").trim();
            messages.set(id, { id, turn: number === undefined ? null : Number(number), text });
        }
        return [...messages.values()];
    }
    if (mode === "snapshot") return collect();
    clearInterval(window.__kokomiOutputMonitor?.timer);
    const initial = collect();
    const contents = new Map(initial.map((message) => [message.id, message.text]));
    const boundary = Math.max(-1, ...initial.map((message) => message.turn ?? -1));
    const monitor = { matchedMessages: initial.length, boundary, lastPollAt: null, timer: null };
    function poll() {
        const current = collect();
        monitor.matchedMessages = current.length;
        monitor.lastPollAt = Date.now();
        for (const message of current) {
            if (!message.text || contents.get(message.id) === message.text) continue;
            contents.set(message.id, message.text);
            if (contents.size > 2000) contents.delete(contents.keys().next().value);
            if (message.turn !== null && message.turn <= boundary) continue;
            // The Kernel still requires a current pending turn_id and audits the result.
            Promise.resolve(window.onPartialOutput(message.id, message.text)).catch((error) => {
                console.error("Kokomi output delivery failed:", error.message);
            });
        }
    }
    monitor.timer = setInterval(poll, outputPollIntervalMs);
    window.__kokomiOutputMonitor = monitor;
    return { matchedMessages: initial.length, boundary };
}
