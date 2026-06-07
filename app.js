require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

// ─── Config ────────────────────────────────────────────────────────────────
const GENERATOR_URL = "https://pixai.art/en/generator/image";
const BASE_URL      = "https://pixai.art";
const LOGIN_NAME    = process.env.LOGINNAME || "";
const PASSWORD      = process.env.PASSWORD  || "";
const IS_DOCKER     = process.env.IS_DOCKER !== "false";
const DATA_PATH     = "/data/";
const COOKIE_FILE   = path.join(DATA_PATH, "cookies.json");

// ─── Helpers ───────────────────────────────────────────────────────────────
function delay(ms) {
    return new Promise(r => setTimeout(r, ms + Math.random() * 100));
}

function log(tag, msg) {
    console.log(`[${tag}] ${msg}`);
}

// ─── Cookie persistence ────────────────────────────────────────────────────
function loadCookies() {
    try {
        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
            log("COOKIES", `Loaded ${cookies.length} cookies from ${COOKIE_FILE}`);
            return cookies;
        }
    } catch (e) {
        log("COOKIES", `Failed to load cookies: ${e.message}`);
    }
    return [];
}

function saveCookies(cookies) {
    try {
        fs.mkdirSync(DATA_PATH, { recursive: true });
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
        log("COOKIES", `Saved ${cookies.length} cookies to ${COOKIE_FILE}`);
    } catch (e) {
        log("COOKIES", `Failed to save cookies: ${e.message}`);
    }
}

async function applyCookies(page, cookies) {
    for (const cookie of cookies) {
        try {
            await page.setCookie({
                name:     cookie.name,
                value:    cookie.value,
                domain:   cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`,
                path:     cookie.path     || "/",
                secure:   cookie.secure   ?? true,
                sameSite: cookie.sameSite || "Lax",
            });
        } catch (_) {}
    }
    log("COOKIES", `Applied ${cookies.length} cookies to page`);
}

// ─── Stealth patches ───────────────────────────────────────────────────────
async function applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
        Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "languages",  { get: () => ["en-GB", "en"] });
        const origGetParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return "Intel Inc.";
            if (param === 37446) return "Intel Iris OpenGL Engine";
            return origGetParam.call(this, param);
        };
        window.chrome = { runtime: {} };
    });
}

// ─── Human-like mouse warm-up ──────────────────────────────────────────────
async function humanWarm(page) {
    const points = [
        [180, 250], [420, 180], [650, 380], [300, 480],
        [512, 300], [200, 400], [700, 200], [400, 550],
    ];
    for (const [x, y] of points) {
        await page.mouse.move(
            x + Math.random() * 25,
            y + Math.random() * 25,
            { steps: 12 + Math.floor(Math.random() * 10) }
        );
        await delay(70 + Math.random() * 130);
    }
}

// ─── Turnstile ─────────────────────────────────────────────────────────────
async function getTurnstileHostHandle(page) {
    const direct = await page.$("#cf-turnstile");
    if (direct) return direct;

    const hidden = await page.$('input[name="cf-turnstile-response"]');
    if (hidden) {
        const parent = await hidden.evaluateHandle(el => el.parentElement);
        const el = parent.asElement();
        if (el) return el;
    }

    const verifyRow = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll("body *"))
            .find(el => /verify you are human/i.test(el.innerText || "")) || null
    );
    return verifyRow.asElement() || null;
}

async function solveTurnstile(page) {
    log("TURNSTILE", "Warming up mouse before verification...");
    await humanWarm(page);

    const host = await getTurnstileHostHandle(page);
    if (!host) {
        log("TURNSTILE", "Widget not found — skipping.");
        return false;
    }

    const box = await host.boundingBox();
    if (!box) {
        log("TURNSTILE", "Widget found but no bounding box.");
        return false;
    }

    log("TURNSTILE", `Widget at x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`);

    const targetX = box.x + Math.min(24, box.width * 0.1);
    const targetY = box.y + box.height / 2;

    await page.mouse.move(targetX - 40, targetY - 20, { steps: 18 });
    await delay(200);
    await page.mouse.move(targetX - 10, targetY - 5,  { steps: 12 });
    await delay(150);
    await page.mouse.move(targetX,       targetY,      { steps: 8  });
    await delay(120);
    await page.mouse.click(targetX, targetY, { delay: 80 + Math.random() * 60 });

    log("TURNSTILE", "Click sent — waiting for token...");

    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(el && el.value && el.value.trim().length > 0);
        }, { timeout: 15000 });

        const val = await page.evaluate(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"]');
            return el ? el.value : "";
        });
        log("TURNSTILE", `Token received (${val.length} chars).`);
        return true;
    } catch (_) {
        // Check if Cloudflare explicitly showed a failure state
        const failed = await page.evaluate(() =>
            /verification failed/i.test(document.body ? document.body.innerText : "")
        );
        if (failed) {
            log("VERIFY_FAILED", "Cloudflare Turnstile returned a failure state.");
            return false;
        }
        log("TURNSTILE", "No token after 15s — proceeding anyway.");
        return false;
    }
}

// ─── Auth helpers ──────────────────────────────────────────────────────────
async function isLoggedIn(page) {
    return await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
        const hasSignIn = buttons.some(el =>
            /^sign\s*in$/i.test((el.innerText || el.textContent || "").trim())
        );
        return !hasSignIn;
    });
}

async function clickButtonByText(page, pattern, timeout = 8000, screenshotName = null) {
    try {
        await page.waitForFunction((pat) => {
            return !!Array.from(document.querySelectorAll("button, [role='button'], a"))
                .find(el => new RegExp(pat, "i").test((el.innerText || el.textContent || "").trim()));
        }, { timeout }, pattern.source);

        return await page.evaluate((pat) => {
            const btn = Array.from(document.querySelectorAll("button, [role='button'], a"))
                .find(el => new RegExp(pat, "i").test((el.innerText || el.textContent || "").trim()));
            if (btn) { btn.click(); return true; }
            return false;
        }, pattern.source);
    } catch (e) {
        log("LOGIN", `Button /${pattern.source}/ not found within ${timeout}ms`);
        if (screenshotName) await page.screenshot({ path: `${DATA_PATH}${screenshotName}.png` });
        return false;
    }
}

// ─── Login flow ────────────────────────────────────────────────────────────
// Step 1: "Sign in" top-right  →  Step 2: "Sign in" inside modal
// Step 3: "Continue with email"  →  Step 4/5: email + password
// Step 6: "Login" button
async function doLogin(page) {
    if (!LOGIN_NAME || !PASSWORD) {
        log("Critical", "LOGINNAME or PASSWORD env vars not set — cannot log in.");
        return false;
    }

    log("LOGIN", "Step 1: Clicking top-right 'Sign in'...");
    if (!await clickButtonByText(page, /^sign\s*in$/, 8000, "login_fail_step1")) return false;
    await delay(900);
    await page.screenshot({ path: `${DATA_PATH}login_step1.png` });

    log("LOGIN", "Step 2: Clicking 'Sign in' inside modal...");
    if (!await clickButtonByText(page, /^sign\s*in$/, 8000, "login_fail_step2")) return false;
    await delay(900);
    await page.screenshot({ path: `${DATA_PATH}login_step2.png` });

    log("LOGIN", "Step 3: Clicking 'Continue with email'...");
    if (!await clickButtonByText(page, /continue with email/, 8000, "login_fail_step3")) return false;
    await delay(900);
    await page.screenshot({ path: `${DATA_PATH}login_step3.png` });

    log("LOGIN", "Step 4: Typing email...");
    try {
        await page.waitForSelector(
            'input[type="email"], input[name="email"], input[placeholder*="email" i]',
            { timeout: 8000 }
        );
        await page.click('input[type="email"], input[name="email"], input[placeholder*="email" i]');
        await delay(200);
        await page.keyboard.type(LOGIN_NAME, { delay: 55 + Math.random() * 45 });
    } catch (e) {
        log("Critical", `Email field not found: ${e.message}`);
        await page.screenshot({ path: `${DATA_PATH}login_fail_email.png` });
        return false;
    }

    log("LOGIN", "Step 5: Typing password...");
    try {
        await page.waitForSelector('input[type="password"]', { timeout: 5000 });
        await page.click('input[type="password"]');
        await delay(200);
        await page.keyboard.type(PASSWORD, { delay: 55 + Math.random() * 45 });
    } catch (e) {
        log("Critical", `Password field not found: ${e.message}`);
        await page.screenshot({ path: `${DATA_PATH}login_fail_password.png` });
        return false;
    }

    await delay(400);

    log("LOGIN", "Step 6: Clicking 'Login' button...");
    const clicked = await clickButtonByText(page, /^log\s*in$/, 5000);
    if (!clicked) {
        log("LOGIN", "Login button not found by text — pressing Enter as fallback...");
        await page.keyboard.press("Enter");
    }

    log("LOGIN", "Waiting for session to confirm...");
    try {
        await page.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
            const stillHasSignIn = buttons.some(el =>
                /^sign\s*in$/i.test((el.innerText || el.textContent || "").trim())
            );
            return !stillHasSignIn;
        }, { timeout: 15000 });
    } catch (_) {
        log("Critical", "Session not confirmed after 15s — login likely failed.");
        await page.screenshot({ path: `${DATA_PATH}login_fail_confirm.png` });
        return false;
    }

    const freshCookies = await page.cookies();
    saveCookies(freshCookies);
    log("INFO", "Successfully logged in and saved cookies.");
    return true;
}

// ─── Claim helpers ─────────────────────────────────────────────────────────
async function waitForDailyClaimModal(page, timeout = 12000) {
    await page.waitForFunction(
        () => document.body && document.body.innerText.includes("Daily Claim"),
        { timeout }
    );
}

async function isAlreadyClaimed(page) {
    return await page.evaluate(() => {
        const text = document.body ? document.body.innerText : "";
        return /Next reward available/i.test(text) || /Credits claimed!/i.test(text);
    });
}

async function waitForClaimButtonEnabled(page, timeout = 25000) {
    await page.waitForFunction(() => {
        const btn = Array.from(document.querySelectorAll("button"))
            .find(b => /claim/i.test((b.innerText || "").trim()));
        return !!(btn && !btn.disabled);
    }, { timeout });
}

async function clickClaimButton(page) {
    return await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button"))
            .find(b => /claim/i.test((b.innerText || "").trim()));
        if (btn && !btn.disabled) { btn.click(); return "SUCCESS"; }
        return btn ? "STILL_DISABLED" : "NOT_FOUND";
    });
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
    log("INFO", "Starting PixAI Auto-Claimer");

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: IS_DOCKER ? "/usr/bin/google-chrome" : undefined,
        args: [
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1280,1024",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
        ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await applyStealthPatches(page);

    try {
        // 1. Land on base domain, inject saved cookies, then navigate to generator
        await page.goto(BASE_URL, { waitUntil: "networkidle2" });

        const savedCookies = loadCookies();
        if (savedCookies.length > 0) {
            await applyCookies(page, savedCookies);
        } else {
            log("COOKIES", "No saved cookies — will attempt login.");
        }

        log("NAV", "Navigating to Generator...");
        await page.goto(GENERATOR_URL, { waitUntil: "networkidle2" });
        await delay(1500);

        // 2. Check login state — login if needed
        const loggedIn = await isLoggedIn(page);
        log("AUTH", loggedIn ? "Session valid." : "Not logged in — starting login flow.");

        if (!loggedIn) {
            await page.screenshot({ path: `${DATA_PATH}not_logged_in.png` });
            const loginOk = await doLogin(page);

            if (!loginOk) {
                log("Critical", "Login failed — check credentials and screenshots in /data/.");
                await browser.close();
                return;
            }

            log("NAV", "Re-navigating to Generator after login...");
            await page.goto(GENERATOR_URL, { waitUntil: "networkidle2" });
            await delay(1500);
        }

        // 3. Wait for Daily Claim modal
        log("WAIT", "Waiting for Daily Claim modal...");
        await page.screenshot({ path: `${DATA_PATH}1_before_claim.png` });

        let modalVisible = false;
        try {
            await waitForDailyClaimModal(page, 12000);
            modalVisible = await page.evaluate(() =>
                document.body.innerText.includes("Daily Claim")
            );
        } catch (_) {
            modalVisible = false;
        }

        if (!modalVisible) {
            if (await isAlreadyClaimed(page)) {
                log("INFO", "already claimed today — nothing to do.");
            } else {
                log("INFO", "Daily Claim modal not detected — already claimed or unexpected state.");
            }
            await page.screenshot({ path: `${DATA_PATH}2_after_claim.png` });
            log("EXIT", "Done");
            await browser.close();
            return;
        }

        if (await isAlreadyClaimed(page)) {
            log("INFO", "already claimed today.");
            await page.screenshot({ path: `${DATA_PATH}2_after_claim.png` });
            log("EXIT", "Done");
            await browser.close();
            return;
        }

        // 4. Solve Turnstile
        log("PROCESS", "Solving Cloudflare Turnstile...");
        const turnstileOk = await solveTurnstile(page);
        if (!turnstileOk) {
            // VERIFY_FAILED is already logged inside solveTurnstile if CF rejected it
            // Give it one more second then continue — button may still enable
        }
        await delay(800);

        // 5. Wait for Claim button to enable
        log("PROCESS", "Waiting for Claim button to enable...");
        try {
            await waitForClaimButtonEnabled(page, 25000);
        } catch (_) {
            log("WARN", "Claim button did not enable in 25s — attempting click anyway.");
        }

        // 6. Click claim
        const result = await clickClaimButton(page);
        await delay(2000);
        await page.screenshot({ path: `${DATA_PATH}2_after_claim.png` });

        if (result === "SUCCESS") {
            // Refresh cookies so next run skips login entirely
            const freshCookies = await page.cookies();
            saveCookies(freshCookies);
            log("CLAIM", "Claim Status: SUCCESS");
        } else {
            log("WARN", `Claim button result: ${result} — check 2_after_claim.png`);
        }

    } catch (e) {
        log("ERROR", e.stack || e.message);
        try { await page.screenshot({ path: `${DATA_PATH}error.png` }); } catch (_) {}
    } finally {
        await browser.close();
        log("EXIT", "Done");
    }
}

run();