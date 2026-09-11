import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

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
  await page.goto("https://chat.openai.com/", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("textarea", { timeout: 60000 });
  console.log("✅ テキストエリアが見つかりました！");

  await page.type("textarea", "Write a test message with @COMMAND:TEST@ inside.", { delay: 50 });
  await page.keyboard.press("Enter");

  // --- Puppeteer 内部でリアルタイム監視を開始 ---
  await page.exposeFunction("onPartialOutput", (text) => {
    process.stdout.write(`🧠 ${text}\n`);

    // @～@ で囲まれた制御コードを抽出
    const regex = /@([^@]+)@/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const command = match[1].trim();
      console.log(`⚙️ 制御コード検出: ${command}`);

      // ローカルファイルに追記
      fs.appendFileSync("commands.log", `${new Date().toISOString()} ${command}\n`);
    }
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

  // --- デバッグ中はブラウザを開いたまま ---
})();
