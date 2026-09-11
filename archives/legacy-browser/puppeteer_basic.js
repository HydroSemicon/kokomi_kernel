import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = await browser.newPage();
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("textarea", { timeout: 60000 });
  console.log("✅ テキストエリアが見つかりました！");

  // メッセージ送信
  await page.type("textarea", "Hello from Puppeteer 👋", { delay: 50 });
  await page.keyboard.press("Enter");
  console.log("💬 メッセージ送信しました。");

  // --- Tampermonkeyの仕組みをそのまま移植 ---
  await page.exposeFunction("onPartialOutput", (text) => {
    process.stdout.write(`🧠 ${text}\n`);
  });

  await page.evaluate(() => {
    let lastContents = new Map();

    function pollTexts() {
      const containers = document.querySelectorAll(".markdown.prose");
      containers.forEach((container, idx) => {
        const currentText = container.innerText.trim();
        const lastText = lastContents.get(container) || "";

        if (currentText && currentText !== lastText) {
          const newPart = currentText.slice(lastText.length);
          lastContents.set(container, currentText);

          if (newPart) {
            newPart.split("\n").forEach(line => {
              if (line.trim()) window.onPartialOutput(`[ChatGPT #${idx}] ${line.trim()}`);
            });
          }
        }
      });
    }

    console.log("✅ ChatGPT 出力監視スタート（Puppeteer版）");
    setInterval(pollTexts, 300);
  });

  // --- 完了まで放置（Ctrl+Cで手動停止） ---
})();
