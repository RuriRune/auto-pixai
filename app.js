require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
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
    if (!cookieStr) return [];

    let decoded = cookieStr;

    // Keep your existing base64 support:
    // if it does not look like Netscape tabs and does not look like raw cookie pairs,
    // treat it as base64 and decode it.
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

async function waitForDailyClaimModal(page, timeout = 30000) {
    await page.waitForFunction(() => {
        return document.body && document.body.innerText.includes('Daily Claim');
    }, { timeout });
}

async function isDailyClaimModalThere(page) {
    return await page.evaluate(() => document.body.innerText.includes('Daily Claim'));
}

async function getClaimButtonInfo(page) {
    return await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));

        const candidates = buttons.map((b, idx) => ({
            index: idx,
            text: (b.innerText || '').trim(),
            disabled: !!b.disabled,
            visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length)
        }));

        const claim = candidates.find(b => /claim/i.test(b.text) && b.visible);
        return claim || null;
    });
}

async function clickClaimButton(page) {
    const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const claimBtn = buttons.find(b => /claim/i.test((b.innerText || '').trim()));
        if (claimBtn && !claimBtn.disabled) {
            claimBtn.click();
            return "SUCCESS";
        }
        return claimBtn ? "STILL_DISABLED" : "NOT_FOUND";
    });

    return clicked;
}

async function waitForClaimEnabled(page, timeout = 25000) {
    await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const claimBtn = buttons.find(b => /claim/i.test((b.innerText || '').trim()));
        return !!(claimBtn && !claimBtn.disabled);
    }, { timeout });
}

async function findTurnstileFrame(page, timeout = 20000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const iframes = await page.$$('iframe');

        for (const iframeHandle of iframes) {
            try {
                const src = await page.evaluate(el => el.src || '', iframeHandle);
                if (src.includes('challenges.cloudflare.com') || src.includes('turnstile')) {
                    const frame = await iframeHandle.contentFrame();
                    return { iframeHandle, frame, src };
                }
            } catch (e) {}
        }

        await delay(500);
    }

    return null;
}

async function tryClickTurnstileInsideFrame(frame) {
    if (!frame) return false;

    const selectors = [
        'input[type="checkbox"]',
        '[role="checkbox"]',
        'label',
        'div[role="button"]'
    ];

    for (const selector of selectors) {
        try {
            const el = await frame.$(selector);
            if (el) {
                await el.click({ delay: 80 });
                return true;
            }
        } catch (e) {}
    }

    return false;
}

async function tryClickTurnstileByIframeBox(page, iframeHandle) {
    if (!iframeHandle) return false;

    try {
        const box = await iframeHandle.boundingBox();
        if (!box) return false;

        // Click relative to the iframe, not the full page.
        // This is still a fallback, but much safer than fixed absolute coordinates.
        const targetX = box.x + Math.max(30, Math.min(box.width * 0.2, box.width - 10));
        const targetY = box.y + (box.height / 2);

        await page.mouse.move(targetX - 10, targetY - 6, { steps: 10 });
        await delay(120);
        await page.mouse.move(targetX, targetY, { steps: 8 });
        await delay(120);
        await page.mouse.click(targetX, targetY, { delay: 100 });

        return true;
    } catch (e) {
        return false;
    }
}

async function solveTurnstile(page) {
    console.log("[PROCESS] Locating Cloudflare verification iframe...");

    const result = await findTurnstileFrame(page, 25000);

    if (!result) {
        console.log("[AUTH] Turnstile iframe not found.");
        return false;
    }

    console.log("[AUTH] Turnstile iframe detected.");

    const clickedInsideFrame = await tryClickTurnstileInsideFrame(result.frame);
    if (clickedInsideFrame) {
        console.log("[AUTH] Verification click sent inside iframe.");
        return true;
    }

    console.log("[AUTH] Direct iframe selectors failed. Trying iframe-relative click...");
    const clickedByBox = await tryClickTurnstileByIframeBox(page, result.iframeHandle);

    if (clickedByBox) {
        console.log("[AUTH] Verification click sent via iframe-relative position.");
        return true;
    }

    console.log("[AUTH] Verification click failed.");
    return false;
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
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });

        const localCookies = await parseLocalCookies(COOKIE_STRING);
        console.log(`[INFO] Parsed ${localCookies.length} cookies from PIXAI_COOKIE.`);
        await applyCookies(page, localCookies);

        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });

        console.log("[WAIT] Waiting for Daily Claim modal...");
        await waitForDailyClaimModal(page, 30000);

        const isModalThere = await isDailyClaimModalThere(page);

        if (!isModalThere) {
            console.log("[INFO] Popup not detected. Likely already claimed.");
            return;
        }

        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        let claimInfo = await getClaimButtonInfo(page);
        if (claimInfo && !claimInfo.disabled) {
            console.log("[INFO] Claim button already enabled.");
            const claimResult = await clickClaimButton(page);
            console.log(`[RESULT] Claim Status: ${claimResult}`);
            await delay(5000);
            await page.screenshot({ path: `${shotPath}2_after_claim.png` });
            return;
        }

        const solved = await solveTurnstile(page);

        if (!solved) {
            console.log("[RESULT] Claim Status: VERIFY_FAILED");
            await delay(5000);
            await page.screenshot({ path: `${shotPath}2_after_claim.png` });
            return;
        }

        console.log("[WAIT] Processing verification and waiting for claim button...");
        try {
            await waitForClaimEnabled(page, 25000);
        } catch (e) {
            console.log("[WAIT] Claim button did not enable in time.");
        }

        claimInfo = await getClaimButtonInfo(page);
        if (claimInfo) {
            console.log(`[INFO] Claim button text: "${claimInfo.text}" | disabled=${claimInfo.disabled}`);
        } else {
            console.log("[INFO] Claim button not found after verification.");
        }

        const claimResult = await clickClaimButton(page);
        console.log(`[RESULT] Claim Status: ${claimResult}`);

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