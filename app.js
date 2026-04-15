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

// --- LOGIC TAKEN DIRECTLY FROM YOUR DOCKER CODE ---
async function performLogin(page) {
    console.log("[AUTH] Navigating to login page...");
    try {
        await page.goto("https://pixai.art/login", { waitUntil: "networkidle2" });
        await delay(1000);

        // Bypass initial screen popups (from your code)
        try {
            await page.waitForSelector('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type', { timeout: 5000 });
            await page.click('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type');
            console.log("[AUTH] Initial screen bypassed.");
            await delay(2000);
        } catch (e) {
            console.log("[AUTH] No initial screen popup found, proceeding.");
        }

        // Exact IDs from your code
        console.log(`[AUTH] Entering credentials for: ${LOGINNAME}`);
        await page.waitForSelector("#email-input", { timeout: 10000 });
        await page.type("#email-input", LOGINNAME, { delay: 50 });
        await page.type("#password-input", PASSWORD, { delay: 50 });
        
        await delay(300);
        await page.waitForSelector('button[type="submit"]');
        await page.click('button[type="submit"]');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log("[AUTH] Login successful.");
        return true;
    } catch (e) {
        console.log("[ERROR] Login failed:", e.message);
        await page.screenshot({ path: `${shotPath}login_error.png` });
        return false;
    }
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Solving Cloudflare Turnstile...");
    const host = await page.evaluateHandle(() => {
        return document.querySelector('#cf-turnstile') || 
               Array.from(document.querySelectorAll('body *')).find(el => /verify you are human/i.test(el.innerText)) || 
               null;
    });

    const element = host.asElement();
    if (!element) return false;

    const box = await element.boundingBox();
    if (!box) return false;

    const targetX = box.x + (box.width * 0.15);
    const targetY = box.y + (box.height / 2);

    await page.mouse.click(targetX, targetY, { delay: 150 });
    
    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(el && el.value && el.value.trim().length > 0);
        }, { timeout: 15000 });
        return true;
    } catch (e) { return true; }
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Unified Logic)`);

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--window-size=1280,1024"] : []
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });

    try {
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        console.log(`[INFO] Parsed ${localCookies.length} cookies.`);

        if (localCookies.length > 0) {
            await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
            await applyCookies(page, localCookies);
        }

        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(8000);
        
        const needsLogin = await page.evaluate(() => {
            const text = document.body.innerText;
            return text.includes('Log In') || text.includes('Sign In') || !text.includes('Credits');
        });

        if (needsLogin && LOGINNAME && PASSWORD) {
            console.log("[INFO] Session invalid. Falling back to LOGINNAME/PASSWORD...");
            await performLogin(page);
            await page.goto(url, { waitUntil: "networkidle2" });
            await delay(8000);
        }

        await page.screenshot({ path: `${shotPath}debug_initial_load.png` });

        const pageContent = await page.evaluate(() => document.body.innerText);
        const modalPresent = pageContent.includes('Daily Claim') || pageContent.includes('Reward');
        const alreadyClaimed = /Next reward available/i.test(pageContent) || /Credits claimed!/i.test(pageContent);

        if (!modalPresent) {
            console.log(alreadyClaimed ? "[INFO] Already claimed today." : "[INFO] Popup not detected.");
            return;
        }

        await solveTurnstile(page);
        await delay(10000);

        const result = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => /claim/i.test(b.innerText) || /\d+,000/.test(b.innerText));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "SUCCESS";
            }
            return claimBtn ? "STILL_DISABLED" : "NOT_FOUND";
        });

        console.log(`[RESULT] Claim Status: ${result}`);
        await delay(5000);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

    } catch (e) {
        console.error("[FATAL ERROR]", e.message);
    } finally {
        await browser.close();
        console.log("[EXIT] Done.");
    }
}

run();