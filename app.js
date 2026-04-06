require('dotenv').config(); // MUST BE LINE 1
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

    let config = { 
        headless: "new", // "new" is better for modern Puppeteer
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? [
            "--disable-gpu", 
            "--disable-setuid-sandbox", 
            "--no-sandbox", 
            "--no-zygote", 
            "--disable-dev-shm-usage", // CRITICAL for Unraid
            `--lang=${LANG}`
        ] : []
    };

    const browser = await puppeteer.launch(config);
    const page = await browser.newPage();

    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    try {
        console.log("[NAV] Navigating to PixAI...");
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        await applyCookies(page);
        await page.reload({ waitUntil: "networkidle2" });
        await page.goto(url, { waitUntil: "networkidle2" });
    } catch (error) {
        console.error("[ERROR] Navigation failed:", error.message);
        await browser.close();
        if (++tryCount <= tryCountMax) return loginAndScrape();
        process.exit(1);
    }

    try {
        if (!COOKIE_STRING) {
            console.log("[AUTH] Logging in with credentials...");
            await page.waitForSelector("#email-input", { timeout: 10000 });
            await page.type("#email-input", username);
            await page.type("#password-input", password);
            await page.click('button[type="submit"]');
            await delay(6000);
        } else {
            console.log("[AUTH] Using cookies, skipping login screen.");
        }

        console.log("[PROCESS] Attempting to claim reward...");
        // Added some delay to let popups appear
        await delay(3000);
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

// ... (Rest of your helper functions remain the same)

loginAndScrape().catch(err => {
    console.error("[FATAL ERROR]", err);
    process.exit(1);
});