const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/login";
const username = process.env.LOGINNAME || undefined;
const password = process.env.PASSWORD || undefined;
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const headless = true;
const tryCountMax = 3;
let tryCount = 0;
const LANG = process.env.APP_LANG || "en-GB";

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function applyCookies(page) {
    if (!COOKIE_STRING) return;
    const cookies = COOKIE_STRING.split(";").map(c => {
        const [name, ...rest] = c.trim().split("=");
        return {
            name,
            value: rest.join("="),
            domain: ".pixai.art",
            path: "/"
        };
    });
    await page.setCookie(...cookies);
    console.log("[AUTH] Cookies applied to session.");
}

async function loginAndScrape() {
    console.log("[INFO] Starting PixAI Auto-Claimer...");

    if (!COOKIE_STRING && (!username || !password)) {
        throw new Error("Missing Credentials: Set LOGINNAME/PASSWORD or PIXAI_COOKIE");
    }

    let config = { headless: headless };
    if (isDocker) {
        config = {
            ...config,
            executablePath: "/usr/bin/google-chrome",
            args: ["--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", "--no-zygote", `--lang=${LANG}`],
        };
    }

    const browser = await puppeteer.launch(config);
    const page = await browser.newPage();

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    try {
        await page.goto("https://pixai.art", { waitUntil: "domcontentloaded" });
        await applyCookies(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (error) {
        console.error("[ERROR] Navigation failed:", error.message);
        await browser.close();
        if (++tryCount <= tryCountMax) return loginAndScrape();
        process.exit(1);
    }

    try {
        if (!COOKIE_STRING) {
            console.log("[AUTH] Logging in with credentials...");
            await page.type("#email-input", username);
            await page.type("#password-input", password);
            await page.click('button[type="submit"]');
            await delay(6000);
        } else {
            console.log("[AUTH] Using cookies, skipping login screen.");
        }

        console.log("[PROCESS] Attempting to claim reward...");
        await claimCreditFromPop(page);
    } catch (error) {
        console.error("[NOTICE] Popup claim failed, trying fallback menu method...");
        try {
            await selectProfileButton(page);
            await clickProfile(page);
            await claimCredit(page);
        } catch (fError) {
            console.error("[CRITICAL] All claim methods failed.");
        }
    }

    await browser.close();
    console.log("[EXIT] Process completed.");
}

async function checkPopup(page) {
    try {
        await page.click('button[aria-label="Close"]');
        return true;
    } catch { return false; }
}

async function selectProfileButton(page) {
    await checkPopup(page);
    await page.waitForSelector("header button:nth-of-type(2)", { timeout: 5000 });
    await page.click("header button:nth-of-type(2)");
    await delay(500);
}

async function clickProfile(page) {
    await page.waitForSelector("div[role='menu'] a[role='menuitem']", { timeout: 5000 });
    const items = await page.$$("div[role='menu'] a[role='menuitem']");
    await items[0].click();
    await delay(1000);
}

async function claimCredit(page) {
    await page.waitForSelector("button", { timeout: 5000 });
    const success = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(b => b.innerText.toLowerCase().includes('claim'));
        if (target) { target.click(); return true; }
        return false;
    });
    console.log(success ? "[SUCCESS] Claimed via menu." : "[INFO] Already claimed.");
}

async function claimCreditFromPop(page) {
    await page.waitForSelector("section button", { timeout: 10000 });
    await page.click("section button");
    await delay(2000);
    console.log("[SUCCESS] Claimed via popup.");
}

loginAndScrape().catch(err => {
    console.error(err);
    process.exit(1);
});