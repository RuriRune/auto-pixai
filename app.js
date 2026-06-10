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
const DATA_PATH       = "/data/";
const COOKIE_FILE     = path.join(DATA_PATH, "cookies.json");


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

async function solveWithCapSolver() {
    const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || "";
    if (!CAPSOLVER_KEY) { log("CAPSOLVER", "No CAPSOLVER_KEY set."); return null; }
    log("CAPSOLVER", "Creating Turnstile task...");
    try {
        const createRes = await fetch("https://api.capsolver.com/createTask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientKey: CAPSOLVER_KEY,
                task: {
                    type: "AntiTurnstileTaskProxyLess",
                    websiteURL: "https://pixai.art/en/generator/image",
                    websiteKey: "0x4AAAAAABkbsz0wsSnkOIKt",
                },
            }),
        });
        const createData = await createRes.json();
        if (createData.errorId !== 0) { log("CAPSOLVER", `Failed: ${createData.errorDescription}`); return null; }
        const taskId = createData.taskId;
        log("CAPSOLVER", `Task: ${taskId} — polling...`);
        for (let i = 0; i < 30; i++) {
            await delay(2000);
            const pollRes  = await fetch("https://api.capsolver.com/getTaskResult", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId }),
            });
            const pollData = await pollRes.json();
            if (pollData.status === "ready") {
                const token = pollData.solution?.token;
                log("CAPSOLVER", `Token received (${token ? token.length : 0} chars).`);
                return token || null;
            }
            if (pollData.errorId !== 0) { log("CAPSOLVER", `Poll error: ${pollData.errorDescription}`); return null; }
        }
        log("CAPSOLVER", "Timed out."); return null;
    } catch (e) { log("CAPSOLVER", `Error: ${e.message}`); return null; }
}

async function solveTurnstile(page) {
    log("TURNSTILE", "Starting Turnstile solve...");

    // Get the widgetId — needed for the postMessage format
    // Confirmed format from browser: {source:"cloudflare-challenge", widgetId:"xxxxx", event:"complete", token:"..."}
    const widgetId = await page.evaluate(() => {
        const iframe = document.querySelector("iframe[id^='cf-chl-widget-']");
        return iframe ? iframe.id.replace("cf-chl-widget-", "") : null;
    });
    log("TURNSTILE", `Widget ID: ${widgetId || "not found — will use fallback"}`);

    // Get token from CapSolver
    const token = await solveWithCapSolver();
    if (!token) { log("TURNSTILE", "CapSolver returned no token."); return false; }

    // Set hidden input and send the exact postMessage Cloudflare sends on completion
    log("TURNSTILE", "Sending completion postMessage with token...");
    await page.evaluate((tok, wid) => {
        // Set the hidden response input
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
                .set.call(input, tok);
            input.dispatchEvent(new Event("input",  { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // Send the exact message format Cloudflare uses (confirmed from browser console)
        window.postMessage({
            source:   "cloudflare-challenge",
            widgetId: wid || "htncd",
            event:    "complete",
            token:    tok,
        }, "*");
    }, token, widgetId);

    // Wait up to 30s for claim button to enable
    log("TURNSTILE", "Waiting for claim button to enable (up to 30s)...");
    const startTime = Date.now();
    while (Date.now() - startTime < 30000) {
        const btnEnabled = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll("button"))
                .find(b => /claim/i.test((b.innerText || "").trim()));
            return !!(btn && !btn.disabled);
        });
        if (btnEnabled) {
            log("TURNSTILE", "Claim button enabled — token accepted!");
            return true;
        }
        await delay(500);
    }

    log("TURNSTILE", "Claim button did not enable after postMessage.");
    return false;
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
// Two possible UI paths:
//
// PATH A — Modal (triggered when visiting generator while logged out):
//   Top-right "Sign in" → modal opens on Sign Up tab
//   → click "Sign in" tab → tab switches, same modal
//   → click "Continue with Email" button
//   → email + password fields appear → fill → click "Log in"
//
// PATH B — Standalone page (redirect to /login or /en/login):
//   Already shows Sign in tab active
//   → click "Continue with Email"
//   → email + password fields → fill → click "Log in"
//
async function doLogin(page) {
    if (!LOGIN_NAME || !PASSWORD) {
        log("Critical", "LOGINNAME or PASSWORD env vars not set — cannot log in.");
        return false;
    }

    // Detect which path we're on
    const onStandalonePage = await page.evaluate(() =>
        /\/(en\/)?login/i.test(window.location.pathname) ||
        /Welcome back to PixAI/i.test(document.body ? document.body.innerText : "")
    );

    if (onStandalonePage) {
        log("LOGIN", "Standalone login page detected — skipping modal steps.");
    } else {
        // PATH A: open modal, then switch to Sign in tab
        log("LOGIN", "Step 1: Clicking top-right 'Sign in'...");
        if (!await clickButtonByText(page, /^sign\s*in$/, 8000, "login_fail_step1")) return false;
        await delay(1200);
        await page.screenshot({ path: `${DATA_PATH}login_step1.png` });

        // Step 2: click the "Sign in" tab (right tab of the Sign Up | Sign in pair)
        // Strategy: find the tab row container that holds both tabs, click the Sign in one specifically
        log("LOGIN", "Step 2: Switching modal to Sign in tab...");

        const tabSwitched = await page.evaluate(() => {
            // Find smallest container whose direct children include both "Sign Up" and "Sign in" text
            const candidates = Array.from(document.querySelectorAll("div, nav, ul, [role='tablist']"));
            const tabRow = candidates.find(el => {
                if (el.children.length < 2) return false;
                const childTexts = Array.from(el.children).map(c => (c.innerText || c.textContent || "").trim());
                return childTexts.some(t => /^sign\s*up$/i.test(t)) &&
                       childTexts.some(t => /^sign\s*in$/i.test(t));
            });
            if (!tabRow) return "NO_TAB_ROW";

            // Click whichever child matches "Sign in"
            const signInTab = Array.from(tabRow.children)
                .find(el => /^sign\s*in$/i.test((el.innerText || el.textContent || "").trim()));
            if (!signInTab) return "NO_SIGNIN_CHILD";

            signInTab.click();
            return "CLICKED";
        });

        log("LOGIN", `Tab DOM result: ${tabSwitched}`);

        if (tabSwitched !== "CLICKED") {
            // Coordinate fallback — modal is ~612px wide centered, tabs are ~155px from modal top
            // Sign in tab is the right half of the tab row
            log("LOGIN", "DOM tab click failed — using coordinate fallback...");
            try {
                const modalInfo = await page.evaluate(() => {
                    // Try common modal selectors
                    const sel = [
                        '[role="dialog"]', '[class*="modal"]', '[class*="Modal"]',
                        '[class*="dialog"]', '[class*="Dialog"]', '[class*="popup"]'
                    ].join(", ");
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { x: r.x, y: r.y, w: r.width, h: r.height };
                });

                if (modalInfo) {
                    // Sign in tab = right half of tab row, ~155px below modal top
                    const tx = modalInfo.x + modalInfo.w * 0.72;
                    const ty = modalInfo.y + 155;
                    log("LOGIN", `Coordinate click Sign in tab: ${Math.round(tx)}, ${Math.round(ty)}`);
                    await page.mouse.click(tx, ty);
                } else {
                    // Absolute fallback for 1280x1024 — modal centred, tab row at ~y=370
                    log("LOGIN", "No modal found — absolute coordinate fallback (694, 372)");
                    await page.mouse.click(694, 372);
                }
            } catch (e) {
                log("LOGIN", `Coordinate fallback error: ${e.message}`);
                await page.screenshot({ path: `${DATA_PATH}login_fail_step2.png` });
                return false;
            }
        }

        // Wait for modal content to confirm switch: "Sign up with Email" → "Continue with Email"
        try {
            await page.waitForFunction(() =>
                /continue with email/i.test(document.body ? document.body.innerText : ""),
                { timeout: 8000 }
            );
            log("LOGIN", "Modal confirmed switched to Sign in view.");
        } catch (_) {
            log("LOGIN", "Modal did not switch to Sign in view — check login_fail_step2.png");
            await page.screenshot({ path: `${DATA_PATH}login_fail_step2.png` });
            return false;
        }

        await delay(400);
        await page.screenshot({ path: `${DATA_PATH}login_step2.png` });
    }

    // Both paths converge here: click "Continue with Email"
    // Use a real mouse click via bounding box — .click() on a div wrapper doesn't trigger React handlers
    log("LOGIN", "Step 3: Clicking 'Continue with Email'...");
    try {
        await page.waitForFunction(() => {
            const els = Array.from(document.querySelectorAll("button, [role='button'], a, div"));
            return els.some(el => /continue with email/i.test((el.innerText || el.textContent || "").trim()));
        }, { timeout: 8000 });
    } catch (e) {
        log("LOGIN", `'Continue with Email' not found: ${e.message}`);
        await page.screenshot({ path: `${DATA_PATH}login_fail_step3.png` });
        return false;
    }

    // Get bounding box of the innermost matching element and do a real mouse click
    const emailBtnClicked = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        // Find the innermost element whose trimmed text is exactly (or contains only) "Continue with Email"
        const matches = all.filter(el =>
            /continue with email/i.test((el.innerText || el.textContent || "").trim()) &&
            el.children.length <= 2  // avoid large wrappers
        );
        if (!matches.length) return null;
        // Pick the smallest one (most specific)
        const target = matches.reduce((a, b) =>
            (a.offsetWidth * a.offsetHeight) < (b.offsetWidth * b.offsetHeight) ? a : b
        );
        const r = target.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    if (emailBtnClicked) {
        log("LOGIN", `Mouse clicking 'Continue with Email' at ${Math.round(emailBtnClicked.x)}, ${Math.round(emailBtnClicked.y)}`);
        await page.mouse.click(emailBtnClicked.x, emailBtnClicked.y);
    } else {
        // Absolute fallback — button is centred in modal at roughly y=604 on 1280x1024
        log("LOGIN", "Could not get bounding box — using coordinate fallback for Continue with Email");
        await page.mouse.click(612, 604);
    }

    await delay(1200);
    await page.screenshot({ path: `${DATA_PATH}login_step3.png` });

    // Step 4: Fill email
    // Wait for ANY text input to appear (the email form animates in after clicking Continue with Email)
    log("LOGIN", "Step 4: Waiting for email input to appear...");
    await page.screenshot({ path: `${DATA_PATH}login_step3b_before_email.png` });
    try {
        await page.waitForFunction(() => {
            const inputs = Array.from(document.querySelectorAll("input"));
            return inputs.some(i =>
                i.type === "email" ||
                i.type === "text" ||
                (i.placeholder && /email|mail/i.test(i.placeholder)) ||
                (i.name && /email|mail/i.test(i.name))
            );
        }, { timeout: 10000 });
    } catch (e) {
        log("Critical", `Email field not found: ${e.message}`);
        await page.screenshot({ path: `${DATA_PATH}login_fail_email.png` });
        return false;
    }

    log("LOGIN", "Step 4: Typing email...");
    try {
        // Click and type into the first matching input
        await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const field = inputs.find(i =>
                i.type === "email" ||
                (i.placeholder && /email|mail/i.test(i.placeholder)) ||
                (i.name && /email|mail/i.test(i.name)) ||
                i.type === "text"
            );
            if (field) field.focus();
        });
        await delay(150);
        await page.keyboard.type(LOGIN_NAME, { delay: 55 + Math.random() * 45 });
    } catch (e) {
        log("Critical", `Failed to type email: ${e.message}`);
        await page.screenshot({ path: `${DATA_PATH}login_fail_email.png` });
        return false;
    }

    // Step 5: Fill password
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
    await page.screenshot({ path: `${DATA_PATH}login_step4_filled.png` });

    // Step 6: Click Log in / Login submit button
    log("LOGIN", "Step 6: Clicking submit/login button...");
    const clicked = await clickButtonByText(page, /^log[\s\-]?in$/i, 5000);
    if (!clicked) {
        log("LOGIN", "Login button not found by text — pressing Enter as fallback...");
        await page.keyboard.press("Enter");
    }

    // Wait for session to confirm — Sign in button disappears from top right
    log("LOGIN", "Waiting for session to confirm...");
    try {
        await page.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
            return !buttons.some(el =>
                /^sign\s*in$/i.test((el.innerText || el.textContent || "").trim())
            );
        }, { timeout: 20000 });
    } catch (_) {
        log("Critical", "Session not confirmed after 20s — login likely failed.");
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

    const displayNum = process.env.DISPLAY || ":99";
    const PROFILE_DIR = "/data/chrome-profile";

    // Clean up Chrome lock files from previous runs — these cause frame detach crashes
    try {
        const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
        for (const lf of lockFiles) {
            const p = `${PROFILE_DIR}/${lf}`;
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                log("INFO", `Removed stale lock file: ${lf}`);
            }
        }
    } catch (e) {
        log("INFO", `Lock cleanup: ${e.message}`);
    }

    const chromeArgs = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,1024",
        "--disable-features=IsolateOrigins,site-per-process",
        // Better WebGL/Canvas support for Cloudflare fingerprinting
        "--enable-webgl",
        "--enable-webgl2",
        "--ignore-gpu-blocklist",
        "--use-gl=swiftshader",
        "--use-angle=swiftshader-webgl",
        "--enable-accelerated-2d-canvas",
        "--enable-canvas-2d-dynamic-rendering-mode-switching",
        "--font-render-hinting=medium",
        `--user-data-dir=${PROFILE_DIR}`,
        "--profile-directory=Default",
    ];

    if (IS_DOCKER) {
        chromeArgs.push(`--display=${displayNum}`);
    }

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: IS_DOCKER ? "/usr/bin/google-chrome" : undefined,
        args: chromeArgs,
        env: IS_DOCKER ? { ...process.env, DISPLAY: displayNum } : process.env,
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
        await solveTurnstile(page);
        await delay(800);

        // 5. Wait for Claim button to enable
        log("PROCESS", "Waiting for Claim button to enable...");
        try {
            await waitForClaimButtonEnabled(page, 35000);
        } catch (_) {
            log("WARN", "Claim button did not enable in 35s — attempting click anyway.");
        }

        // 6. Click claim
        const result = await clickClaimButton(page);
        await delay(2000);
        await page.screenshot({ path: `${DATA_PATH}2_after_claim.png` });

        if (result === "SUCCESS") {
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