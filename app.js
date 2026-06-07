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

    const lines = decoded.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));

    return lines.map(line => {
        const tabs = line.split('\t');
        if (tabs.length < 7) return null;
        return {
            domain: tabs[0],
            path: tabs[2] || '/',
            name: tabs[5],
            value: tabs[6]
        };
    }).filter(c => c && c.name && c.value !== undefined && c.domain);
}

// --- LOGIN FALLBACK FROM YOUR ORIGINAL DOCKER LOGIC ---
async function performLogin(page) {
    console.log("[AUTH] Session invalid. Executing Login fallback sequence...");
    if (!LOGINNAME || !PASSWORD) {
        console.log("[AUTH] Fallback failed: LOGINNAME or PASSWORD missing from environment variables.");
        return false;
    }
    try {
        console.log("[AUTH] Navigating to login page...");
        await page.goto("https://pixai.art/login", { waitUntil: "networkidle2" });
        await delay(1500);

        // Bypass initial screen (taken directly from your original code)
        try {
            await page.waitForSelector('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type', { timeout: 4000 });
            await page.click('div[id="root"] > div > div > div > div > div form > div > div button:last-of-type');
            console.log("[AUTH] Initial splash screen bypassed.");
            await delay(1500);
        } catch (e) {
            console.log("[AUTH] No initial splash screen detected, continuing.");
        }

        // Exact IDs from your working Docker code
        console.log(`[AUTH] Inputting credentials for: ${LOGINNAME}`);
        await page.waitForSelector("#email-input", { timeout: 10000 });
        await page.type("#email-input", LOGINNAME, { delay: 40 });
        await page.type("#password-input", PASSWORD, { delay: 40 });
        
        await delay(400);
        await page.waitForSelector('button[type="submit"]');
        await page.click('button[type="submit"]');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log("[AUTH] Login sequence finished.");
        return true;
    } catch (e) {
        console.log("[ERROR] Login fallback process failed:", e.message);
        return false;
    }
}

async function waitForDailyClaimModal(page, timeout = 12000) {
    await page.waitForFunction(() => {
        return document.body && (document.body.innerText.includes('Daily Claim') || document.body.innerText.includes('Claim 12,000'));
    }, { timeout });
}

async function isDailyClaimModalThere(page) {
    return await page.evaluate(() => document.body.innerText.includes('Daily Claim') || document.body.innerText.includes('Claim 12,000'));
}

async function isAlreadyClaimedState(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return /Next reward available/i.test(text) || /Credits claimed!/i.test(text);
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

async function clickTurnstileHost(page) {
    const host = await getTurnstileHostHandle(page);
    if (!host) {
        console.log("[AUTH] Turnstile host frame area not located.");
        return false;
    }

    const box = await host.boundingBox();
    if (!box) {
        console.log("[AUTH] Turnstile host found but frame boundaries could not be verified.");
        return false;
    }

    console.log(`[AUTH] Turnstile box dimensions: x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}`);

    // Humanized mouse tracking click updates to fix "Verification failed" errors
    const randomXOffset = Math.floor(Math.random() * 6) - 3; // Random variance -3px to +3px
    const randomYOffset = Math.floor(Math.random() * 4) - 2; 
    
    const targetX = box.x + Math.min(26, Math.max(18, box.width * 0.08)) + randomXOffset;
    const targetY = box.y + (box.height / 2) + randomYOffset;

    console.log(`[AUTH] Simulating human click pattern at coordinates: ${Math.round(targetX)}, ${Math.round(targetY)}`);

    // Fluid mouse arcs to fool Cloudflare verification metrics
    await page.mouse.move(targetX - 30, targetY - 18, { steps: 10 });
    await delay(60 + Math.floor(Math.random() * 40));
    await page.mouse.move(targetX - 8, targetY + 2, { steps: 8 });
    await delay(50 + Math.floor(Math.random() * 30));
    await page.mouse.move(targetX, targetY, { steps: 6 });
    await delay(200 + Math.floor(Math.random() * 150));
    
    // Human touch press intervals
    await page.mouse.down();
    await delay(90 + Math.floor(Math.random() * 60));
    await page.mouse.up();

    return true;
}

async function waitForTurnstileResponse(page, timeout = 15000) {
    await page.waitForFunction(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return !!(el && el.value && el.value.trim().length > 10);
    }, { timeout });
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Locating Cloudflare verification host...");
    const host = await getTurnstileHostHandle(page);
    if (!host) {
        console.log("[AUTH] Turnstile checkbox skipped or not requested.");
        return false;
    }

    console.log("[AUTH] Turnstile frame detected.");
    const clicked = await clickTurnstileHost(page);
    if (!clicked) return false;

    console.log("[AUTH] Verification action completed. Waiting for server response token...");

    try {
        await waitForTurnstileResponse(page, 15000);
        console.log(`[AUTH] Turnstile authentication cleared successfully.`);
        return true;
    } catch (e) {
        console.log("[AUTH] Cloudflare did not pass a token after interaction.");
        return false;
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
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");

    try {
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        console.log(`[INFO] Parsed ${localCookies.length} cookies from PIXAI_COOKIE.`);
        
        if (localCookies.length > 0) {
            await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
            await applyCookies(page, localCookies);
        }

        console.log("[NAV] Moving to Generator page...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(5000);

        // Check if cookies successfully signed us in. If not, trigger the original Docker login flow
        const needsLogin = await page.evaluate(() => {
            const text = document.body ? document.body.innerText : '';
            return text.includes('Log In') || text.includes('Sign In') || (!text.includes('Credits') && !text.includes('Claim'));
        });

        if (needsLogin) {
            const loginSuccess = await performLogin(page);
            if (loginSuccess) {
                console.log("[NAV] Re-navigating to Generator page post-login...");
                await page.goto(url, { waitUntil: "networkidle2" });
                await delay(5000);
            }
        }

        console.log("[WAIT] Checking for Daily Claim interface...");
        let isModalThere = false;
        try {
            await waitForDailyClaimModal(page, 10000);
            isModalThere = await isDailyClaimModalThere(page);
        } catch (e) {
            isModalThere = false;
        }

        if (!isModalThere) {
            const alreadyClaimed = await isAlreadyClaimedState(page);
            if (alreadyClaimed) {
                console.log("[INFO] Already claimed today.");
            } else {
                console.log("[INFO] Interface modal not detected. Capture created.");
                await page.screenshot({ path: `${shotPath}error_no_modal.png` });
            }
            return;
        }

        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        if (await isAlreadyClaimedState(page)) {
            console.log("[INFO] Target state indicates rewards have already been claimed.");
            return;
        }

        console.log("[PROCESS] Interface located. Activating anti-fingerprinting Turnstile solver...");
        await solveTurnstile(page);
        
        // Let the interface register the checkmark change safely
        console.log("[WAIT] Resting interface UI...");
        await delay(4000);
        
        console.log("[PROCESS] Attempting to select Claim execution button...");
        const status = await clickClaimButton(page);
        console.log(`[RESULT] Claim Status: ${status}`);

        await delay(3000);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

    } catch (e) {
        console.error("[FATAL ERROR]", e);
    } finally {
        await browser.close();
        console.log("[EXIT] Done.");
    }
}

run();