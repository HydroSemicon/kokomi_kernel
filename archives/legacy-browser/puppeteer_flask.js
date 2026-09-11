// puppeteer_tearsync.js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import fetch from "node-fetch";

puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  await page.goto("https://chat.openai.com/", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("textarea", { timeout: 60000 });
  console.log("テキストエリア検出成功");

  // ChatGPTにメッセージ送信
  await page.type("textarea", "Write a test message with @tear@ inside.", { delay: 50 });
  await page.keyboard.press("Enter");

  // --- 出力監視＋制御処理 ---
  await page.exposeFunction("onPartialOutput", async (text) => {
    process.stdout.write(`🧠 ${text}\n`);

    // @～@ で囲まれた制御コードを抽出
    const regex = /@([^@]+)@/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const command = match[1].trim();
      console.log(`制御コード検出: ${command}`);

      // ローカルログに保存
      fs.appendFileSync("commands.log", `${new Date().toISOString()} ${command}\n`);

      // ラズパイ（Flaskサーバ）にHTTPで送信
      try {
        const res = await fetch("http://kokomi.local:5000/command", {
          method: "POST",
          body: command,
          headers: { "Content-Type": "text/plain" },
        });

        console.log(`コマンド送信: ${command} → ${res.status}`);
      } catch (err) {
        console.error(`Flask送信失敗 (${command}):`, err.message);
      }
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
            newPart.split("\n").forEach((line) => {
              if (line.trim()) window.onPartialOutput(`[ChatGPT #${idx}] ${line.trim()}`);
            });
          }
        }
      });
    }
    console.log("ChatGPT 出力監視スタート（Puppeteer版）");
    setInterval(pollTexts, 300);
  });

})();
