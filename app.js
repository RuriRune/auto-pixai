require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// Configuration
const URL = "https://pixai.art/en/generator/image";
const LOGIN_URL = "https://pixai.art/login";
const isDocker = process.env.IS_DOCKER !== 'false';
const shotPath = "/data/"; // Where screenshots and cookies live
const cookiesPath = path.join(shotPath, 'cookies.json');

// Original authentication configuration
const username = process.env.LOGINNAME ? process.env.LOGINNAME : undefined;
const password = process.env.PASSWORD ? process.env.PASSWORD : undefined;

/**
 * Utility to wait for a specified time
 */
function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

/**
 * Checks if the Daily Claim modal is visible
 */
async function isDailyClaimModalThere(page) {
    return await page.evaluate(() => {
        return document.body && document.body.innerText.includes('Daily Claim');
    });
}

/**
 * Checks if credits have already been claimed based on UI text
 */
async function isAlreadyClaimedState(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return /Next reward available/i.test(text) || /Credits claimed!/i.test(text);
    });
}

/**
 * Clicks the claim button if it is found and enabled
 */
async function clickClaimButton(page) {
    return await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const claimBtn = buttons.find(b => /claim/i.test((b.innerText || '').trim()));

        if (claimBtn && !claimBtn.disabled) {
            claimBtn.click();
            return "SUCCESS";
        }
        return claimBtn ? "STILL_DISABLED" : "NOT_FOUND";
    });
}

/**
 * Handles Cloudflare Turnstile verification by finding the widget and clicking the checkbox
 */
async function solveTurnstile(page) {
    console.log("[PROCESS] Attempting to locate Turnstile host...");
    
    const host = await page.evaluateHandle(() => {
        const el = document.querySelector('#cf-turnstile') || 
                   document.querySelector('input[name="cf-turnstile-response"]')?.parentElement;
        if (el) return el;
        const all = Array.from(document.querySelectorAll('body *'));
        return all.find(el => /verify you are human/i.test(el.innerText || '')) || null;
    });

    const hostEl = host.asElement();
    if (!hostEl) {
        console.log("[AUTH] Turnstile host not found.");
        return false;
    }

    const box = await hostEl.boundingBox();
    if (!box) return false;

    // Click target: slightly offset into the checkbox area
    const targetX = box.x + 25;
    constY = box.y + (box.height / 2);

    await page.mouse.move(targetX, targetY, { steps: 10 });
    await page.mouse.click(targetX, targetY, { delay: 100 });
    console.log("[AUTH] Turnstile click sent.");
    
    // Wait a moment for the response token to appear
    await delay(5000); 
    return true;
}

/**
 * Handles login if cookies are invalid or missing, and saves new cookies
 */
async function loginAndSaveCookies(page, username, password) {
    console.log("[AUTH] Navigating to login page...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
    await delay(3000);

    // Click initial modal/popup
    try {
        await page.waitForSelector(
            'div[id="root"] > div > div > div > div > div form > div > div button:last-of-type'
        );
        await delay(30);
        await page.click(
            'div[id="root"] > div > div > div > div > div form > div > div button:last-of-type'
        );
        await delay(3000);
    } catch (e) {
        // Ignored if popup doesn't appear
    }

    console.log("[AUTH] Entering credentials...");
    await page.type("#email-input", username);
    await page.type("#password-input", password);
    await delay(300);
    
    await page.waitForSelector('button[type="submit"]');
    await page.click('button[type="submit"]');
    await delay(6000);

    try {
        await page.$eval('button[type="submit"]', (button) => button.click());
        await delay(3000);
    } catch (e) {
        // Ignored
    }

    // Save newly generated session cookies to /data/cookies.json
    const newCookies = await page.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(newCookies, null, 2));
    console.log(`[AUTH] Successfully logged in and saved ${newCookies.length} new cookies to /data/cookies.json`);
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (JSON Mode)`);

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? [
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1280,1024"
        ] : []
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        let loggedInViaCookie = false;

        // 1. Load and Apply Cookies
        if (fs.existsSync(cookiesPath)) {
            const cookiesData = fs.readFileSync(cookiesPath, 'utf8');
            const cookies = JSON.parse(cookiesData);
            await page.setCookie(...cookies);
            console.log(`[INFO] Injected ${cookies.length} cookies from /data/cookies.json`);
            
            // Navigate to generator to check if session is valid
            console.log("[NAV] Moving to Generator...");
            await page.goto(URL, { waitUntil: "networkidle2" });
            
            const isLoggedIn = await page.evaluate(() => document.cookie.includes('user_token'));
            if (isLoggedIn) {
                loggedInViaCookie = true;
                console.log("[INFO] Session is valid with cookies.");
            } else {
                console.log("[WARN] user_token not detected, cookie session might be expired.");
            }
        } else {
            console.log(`[WARN] cookies.json not found at ${cookiesPath}`);
        }

        // 2. Fallback to username/password login if cookies didn't work
        if (!loggedInViaCookie) {
            if (!username || !password) {
                throw new Error("Critical: Cookies were invalid/missing, and no LOGINNAME/PASSWORD set in environment variables.");
            }
            await loginAndSaveCookies(page, username, password);
            // Go back to the main generator page after logging in
            await page.goto(URL, { waitUntil: "networkidle2" });
        }

        // 3. Handle Modal logic
        await delay(5000); // Wait for modal to pop up naturally
        let isModalThere = await isDailyClaimModalThere(page);

        if (!isModalThere) {
            if (await isAlreadyClaimedState(page)) {
                console.log("[INFO] Already claimed today.");
            } else {
                console.log("[INFO] Daily Claim popup not detected.");
            }
            await page.screenshot({ path: `${shotPath}debug_no_modal.png` });
            return;
        }

        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        // 4. Check if we need to solve Turnstile
        console.log("[PROCESS] Modal detected. Checking button status...");
        const alreadyClaimed = await isAlreadyClaimedState(page);
        if (alreadyClaimed) {
            console.log("[INFO] UI indicates already claimed.");
            return;
        }

        // Attempt Turnstile solve
        await solveTurnstile(page);

        // 5. Execute Claim
        console.log("[WAIT] Attempting to click Claim...");
        const result = await clickClaimButton(page);
        console.log(`[RESULT] Claim Status: ${result}`);

        await delay(3000);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

    } catch (e) {
        console.error("[FATAL ERROR]", e.message);
    } finally {
        await browser.close();
        console.log("[EXIT] Done.");
    }
}

run();