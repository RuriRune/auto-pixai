require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const LOGINNAME = process.env.LOGINNAME || "";
const PASSWORD = process.env.PASSWORD || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const shotPath = "/data/";

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

// ... (applyCookies and parseLocalCookies functions remain the same) ...

async function applyCookies(page, cookiesArray) {
    for (const cookie of cookiesArray) {
        try {
            await page.setCookie({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`,
                path: cookie.path || '/',
                secure: true,
                sameSite: 'Lax'
            });
        } catch (e) {}
    }
}

async function parseLocalCookies(cookieStr) {
    if (!cookieStr || cookieStr.length < 20) return [];
    let decoded = cookieStr;
    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        try {
            decoded = Buffer.from(cookieStr.trim(), 'base64').toString('utf-8');
        } catch (e) { return []; }
    }
    const lines = decoded.split(/\r?\n/);
    const cookies = [];
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const tabs = line.split(/\t/);
        if (tabs.length >= 7) {
            cookies.push({ domain: tabs[0], path: tabs[2], name: tabs[5], value: tabs[6] });
        }
    }
    return cookies;
}

async function performLogin(page) {
    console.log("[AUTH] Navigating to login page...");
    try {
        await page.goto("https://pixai.art/login", { waitUntil: "networkidle2" });
        await delay(2000);
        try {
            await page.waitForSelector('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type', { timeout: 5000 });
            await page.click('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type');
            await delay(2000);
        } catch (e) {}
        await page.waitForSelector("#email-input", { timeout: 10000 });
        await page.type("#email-input", LOGINNAME, { delay: 50 });
        await page.type("#password-input", PASSWORD, { delay: 50 });
        await delay(500);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        return true;
    } catch (e) {
        return false;
    }
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Attempting to solve Turnstile...");
    try {
        // Find the iframe specifically
        const iframeElement = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 15000 });
        const box = await iframeElement.boundingBox();
        
        if (!box) {
            console.log("[ERROR] Could not find Turnstile iframe box.");
            return false;
        }

        // The checkbox is typically centered vertically on the left side of the widget
        const clickX = box.x + 45; // Moved slightly more inward to ensure box hit
        const clickY = box.y + (box.height / 2);

        console.log(`[AUTH] Target Click: ${Math.round(clickX)}, ${Math.round(clickY)}`);
        
        // Move mouse first to simulate human behavior
        await page.mouse.move(clickX - 10, clickY - 5);
        await delay(200);
        await page.mouse.click(clickX, clickY);

        // Wait for token to appear in the hidden input
        await page.waitForFunction(() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            return input && input.value && input.value.length > 20;
        }, { timeout: 20000 });

        console.log("[AUTH] Turnstile Token Received.");
        return true;
    } catch (e) {
        console.log("[AUTH] Turnstile solver failed or timed out.");
        return false;
    }
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Explicit Solving)`);
    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"] : []
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });

    try {
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        if (localCookies.length > 0) {
            await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
            await applyCookies(page, localCookies);
        }

        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(8000);
        
        const needsLogin = await page.evaluate(() => {
            return document.body.innerText.includes('Log In') || !document.body.innerText.includes('Credits');
        });

        if (needsLogin) {
            await performLogin(page);
            await page.goto(url, { waitUntil: "networkidle2" });
            await delay(8000);
        }

        await page.screenshot({ path: `${shotPath}debug_initial_load.png` });

        const pageContent = await page.evaluate(() => document.body.innerText);
        if (pageContent.includes('Daily Claim') || pageContent.includes('Reward')) {
            await solveTurnstile(page);
            
            // Wait for UI to update button state
            await delay(6000); 

            const result = await page.evaluate(async () => {
                const btns = Array.from(document.querySelectorAll('button'));
                const claimBtn = btns.find(b => /claim/i.test(b.innerText) || /\d+,000/.test(b.innerText));
                
                if (claimBtn) {
                    if (claimBtn.disabled) return "STILL_DISABLED";
                    claimBtn.click();
                    return "SUCCESS";
                }
                return "NOT_FOUND";
            });

            console.log(`[RESULT] Claim Status: ${result}`);
            await delay(5000);
            await page.screenshot({ path: `${shotPath}2_after_claim.png` });
        } else {
            console.log("[INFO] Modal not detected.");
        }

    } catch (e) {
        console.error("[FATAL ERROR]", e.message);
    } finally {
        await browser.close();
        console.log("[EXIT] Done.");
    }
}

run();