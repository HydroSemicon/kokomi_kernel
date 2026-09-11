import { connect } from "puppeteer-real-browser";

(async () => {

    const { browser, page } = await connect({
        headless: false,
        args: [
            "--start-maximized"
        ],
        customConfig: {
            defaultViewport: null
        },
        userDataDir: "./chrome_profile"

    });

    console.log("Chrome起動");

    await page.goto("https://chatgpt.com/", {
        waitUntil: "domcontentloaded"
    });

})();