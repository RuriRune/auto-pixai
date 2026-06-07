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

// RESTORED: Your exact original cookie parsing logic
async function parseLocalCookies(cookieStr) {
    if (!cookieStr) return [];

    let decoded = cookieStr;

    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
    }

    const lines = decoded.split('\n').filter(l => l.trim() && !l.startsWith('#'));

    return lines.map(line => {
        const tabs = line.split('\t');
        return {
            name: tabs[5],
            value: tabs[6],
            domain: tabs[0],
            path: tabs[2] || '/'
        };
    }).filter(c => c.name && c.value !== undefined && c.domain);
}

// BACKUP LOGIN SEQUENCE: Runs only if cookies fail to authenticate
async function performLoginFallback(page) {
    console.log("[AUTH] Fallback initiated: Filling credential inputs on page...");
    try {
        // Clear initial splash screens or extra buttons inside the modal if they appear
        try {
            await page.waitForSelector('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type', { timeout: 3000 });
            await page.click('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type');
            await delay(1500);
        } catch (e) {}

        await page.waitForSelector("#email-input", { timeout: 5000 });
        await page.type("#email-input", LOGINNAME, { delay: 50 });
        await page.type("#password-input", PASSWORD, { delay: 50 });
        await delay(500);
        await page.click('button[type="submit"]');
        
        console.log("[AUTH] Credentials submitted. Waiting for session refresh...");
        await delay(6000); 
        return true;
    } catch (e) {
        console.log("[AUTH] Credentials inputs not found or already bypassed:", e.message);
        return false;
    }
}

async function waitForDailyClaimModal(page, timeout = 12000) {
    await page.waitForFunction(() => {
        return document.body && document.body.innerText.includes('Daily Claim');
    }, { timeout });
}

async function isDailyClaimModalThere(page) {
    return await page.evaluate(() => document.body.innerText.includes('Daily Claim'));
}

async function isAlreadyClaimedState(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return /Next reward available/i.test(text) || /Credits claimed!/i.test(text);
    });
}

async function getClaimButtonInfo(page) {
    return await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const claimBtn = buttons.find(b => /claim/i.test((b.innerText || '').trim()));
        if (!claimBtn) return null;

        return {
            text: (claimBtn.innerText || '').trim(),
            disabled: !!claimBtn.disabled
        };
    });
}

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

async function waitForClaimEnabled(page, timeout = 25000) {
    await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const claimBtn = buttons.find(b => /claim/i.test((b.innerText || '').trim()));
        return !!(claimBtn && !claimBtn.disabled);
    }, { timeout });
}

async function getTurnstileHostHandle(page) {
    let host = await page.$('#cf-turnstile');
    if (host) return host;

    const hiddenInput = await page.$('input[name="cf-turnstile-response"]');
    if (hiddenInput) {
        const parent = await hiddenInput.evaluateHandle(el => el.parentElement);
        const asElement = parent.asElement();
        if (asElement) return asElement;
    }

    const verifyRow = await page.evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll('body *'));
        return all.find(el => /verify you are human/i.test(el.innerText || '')) || null;
    });
    const verifyRowEl = verifyRow.asElement();
    if (verifyRowEl) return verifyRowEl;

    return null;
}

// UPGRADED MOUSE TRAJECTORY: Bypasses the "Verification Failed" error
async function clickTurnstileHost(page) {
    const host = await getTurnstileHostHandle(page);

    if (!host) {
        console.log("[AUTH] Turnstile host not found.");
        return false;
    }

    const box = await host.boundingBox();

    if (!box) {
        console.log("[AUTH] Turnstile host found but bounding box unavailable.");
        return false;
    }

    console.log(`[AUTH] Turnstile host box: x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}`);

    const randomXOffset = Math.floor(Math.random() * 5) - 2; 
    const randomYOffset = Math.floor(Math.random() * 5) - 2;

    const targetX = box.x + Math.min(26, Math.max(18, box.width * 0.08)) + randomXOffset;
    const targetY = box.y + (box.height / 2) + randomYOffset;

    console.log(`[AUTH] Humanized Turnstile click target: ${Math.round(targetX)}, ${Math.round(targetY)}`);

    await page.mouse.move(targetX - 25, targetY - 14, { steps: 8 });
    await delay(70 + Math.floor(Math.random() * 50));
    await page.mouse.move(targetX - 7, targetY + 3, { steps: 6 });
    await delay(40 + Math.floor(Math.random() * 40));
    await page.mouse.move(targetX, targetY, { steps: 5 });
    await delay(150 + Math.floor(Math.random() * 100));
    
    await page.mouse.down();
    await delay(80 + Math.floor(Math.random() * 50));
    await page.mouse.up();

    return true;
}

async function getTurnstileResponseValue(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return el ? (el.value || '') : '';
    });
}

async function waitForTurnstileResponse(page, timeout = 12000) {
    await page.waitForFunction(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return !!(el && el.value && el.value.trim().length > 0);
    }, { timeout });
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Locating Cloudflare verification host...");

    const host = await getTurnstileHostHandle(page);
    if (!host) {
        console.log("[AUTH] Turnstile host not found.");
        return false;
    }

    console.log("[AUTH] Turnstile host detected.");

    const clicked = await clickTurnstileHost(page);
    if (!clicked) {
        console.log("[AUTH] Verification click failed.");
        return false;
    }

    console.log("[AUTH] Verification click sent.");

    try {
        await waitForTurnstileResponse(page, 12000);
        const response = await getTurnstileResponseValue(page);
        console.log(`[AUTH] Turnstile response detected (${response.length} chars).`);
        return true;
    } catch (e) {
        console.log("[AUTH] No Turnstile response token detected after click.");
        return true;
    }
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Turnstile-Aware Mode)`);

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
        // 1. Load the base domain
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });

        // 2. Parse and inject cookies using your original verified logic
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        console.log(`[INFO] Parsed ${localCookies.length} cookies from PIXAI_COOKIE.`);
        if (localCookies.length > 0) {
            await applyCookies(page, localCookies);
        }

        // 3. Move to the generator
        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });

        // 4. Check if the page is forcing a login form instead of the claim screen
        const needsBackupLogin = await page.evaluate(() => {
            return document.body && (document.body.innerText.includes('Log In') || document.body.innerText.includes('Sign In')) && document.querySelector('#email-input');
        });

        if (needsBackupLogin) {
            await performLoginFallback(page);
        }

        console.log("[WAIT] Waiting for Daily Claim modal...");
        let isModalThere = false;
        try {
            await waitForDailyClaimModal(page, 12000);
            isModalThere = await isDailyClaimModalThere(page);
        } catch (e) {
            isModalThere = false;
        }

        if (!isModalThere) {
            const alreadyClaimed = await isAlreadyClaimedState(page);
            if (alreadyClaimed) {
                console.log("[INFO] Already claimed today.");
            } else {
                console.log("[INFO] Popup not detected. Likely already claimed.");
            }
            return;
        }

        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        if (await isAlreadyClaimedState(page)) {
            console.log("[INFO] Already claimed today.");
            await page.screenshot({ path: `${shotPath}2_after_claim.png` });
            return;
        }

        // 5. Run the humanized Turnstile solve method
        await solveTurnstile(page);
        
        console.log("[WAIT] Resting UI...");
        await delay(5000);

        console.log("[PROCESS] Requesting claim click...");
        const result = await clickClaimButton(page);
        console.log(`[RESULT] Claim Status: ${result}`);

        await delay(3000);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

    } catch (e) {
        console.error("[ERROR]", e);
    } finally {
        await browser.close();
    }
}

run();