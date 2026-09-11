// ==UserScript==
// @name         ChatGPT リアルタイムログ送信（最終版）
// @namespace    http://tampermonkey.net/
// @version      1.3-final
// @description  ChatGPTの出力をNode.jsサーバーに送信（連結用）
// @author       あなた
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    let lastContents = new Map(); // コンテンツごとの記録

    function sendToServer(id, text) {
        const message = text; // ← そのまま送る

        GM_xmlhttpRequest({
            method: "POST",
            url: "http://localhost:3000/log",
            data: message,
            headers: {
                "Content-Type": "text/plain"
            },
            onerror: function (err) {
                console.error("❌ ログ送信エラー:", err);
            }
        });
    }


    function pollTexts() {
        const containers = document.querySelectorAll(".markdown.prose");

        containers.forEach((container, idx) => {
            const currentText = container.innerText.trim();
            const lastText = lastContents.get(container) || "";

            if (currentText && currentText !== lastText) {
                const newPart = currentText.slice(lastText.length);
                lastContents.set(container, currentText);

                if (newPart) {
                    // 文の途中も、空行もすべて送る
                    newPart.split('\n').forEach(line => {
                        sendToServer(idx, line.trim());
                    });
                }
            }
        });
    }

    window.addEventListener("load", () => {
        console.log("✅ ChatGPT 出力監視スタート（Tampermonkey最終版）");
        setInterval(pollTexts, 300); // 過負荷防止のため300ms周期
    });
})();
