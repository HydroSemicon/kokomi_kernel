// Insert a complete JSON payload in one browser operation. Keyboard.type sends
// individual key events, which becomes very slow for prompts and quoted logs.
export async function sendBrowserJson(page, object, { config, isValid = () => true }) {
    if (!page) throw new Error("ChatGPT page is not ready");
    const json = JSON.stringify(object);
    const assertCurrent = () => {
        if (!isValid()) throw new Error("Browser request superseded before send");
    };
    let stage = "input lookup";
    try {
        await page.waitForSelector(config.chatInputSelector, { timeout: config.inputTimeoutMs });
        assertCurrent();
        stage = "input focus";
        await page.focus(config.chatInputSelector);
        const existing = await page.$eval(config.chatInputSelector,
            (element) => ("value" in element ? element.value : element.textContent) || "");
        if (existing) {
            stage = "draft cleanup";
            await page.keyboard.down("Control");
            await page.keyboard.press("A");
            await page.keyboard.up("Control");
            await page.keyboard.press("Backspace");
        }
        assertCurrent();
        stage = "JSON insertion";
        await page.keyboard.sendCharacter(json); // Puppeteer's CDP Input.insertText wrapper accepts the full string.
        stage = "JSON verification";
        const inserted = await page.$eval(config.chatInputSelector,
            (element) => ("value" in element ? element.value : element.textContent) || "");
        if (inserted !== json) throw new Error(`ChatGPT input did not preserve the complete JSON payload (${inserted.length}/${json.length} characters)`);
        stage = "send button lookup";
        const button = await page.waitForFunction((selector) => [...document.querySelectorAll(selector)]
            .find((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true"
                && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0),
        { polling: 100, timeout: config.inputTimeoutMs }, config.enabledSendButtonSelector);
        assertCurrent();
        stage = "send button click";
        // Avoid Puppeteer's scroll/animation-frame wait on background tabs. Do not steal focus.
        await button.evaluate((element) => element.click());
        stage = "send confirmation";
        await page.waitForFunction((selector) => {
            const element = document.querySelector(selector);
            return element && !("value" in element ? element.value : element.textContent)?.trim();
        }, { timeout: Math.min(config.inputTimeoutMs, 10000), polling: 100 }, config.chatInputSelector);
        return { bytes: Buffer.byteLength(json, "utf8"), confirmed: true };
    } catch (cause) {
        throw new Error(`ChatGPT ${stage} failed: ${cause.message}`, { cause });
    }
}
