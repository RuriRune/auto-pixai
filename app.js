require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const FS_URL = process.env.FLARESOLVERR_URL || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

// Mapped to /mnt/user/appdata/auto-pixai in Unraid
const shotPath = "/data/"; 

function delay(time) { return new Promise((resolve) => setTimeout(resolve, time)); }

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
        } catch (e) { /* Skip malformed */ }
    }
}

async function parseLocalCookies(cookieStr) {
    if (!cookieStr) return [];
    let decoded = cookieStr;
    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
    }
    const lines = decoded.split('\n');
    const parsed = [];
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const tabs = line.split('\t');
        if (tabs.length >= 7) {
            parsed.push({ name: tabs[5], value: tabs[6], domain: tabs[0], path: tabs[2] });
        }
    }
    return parsed;
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Frame-Detection Mode)`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--lang=${LANG}`] : []
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    await page.setUserAgent(UA);

    try {
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);
        console.log(`[AUTH] Injected ${localCookies.length} user cookies.`);

        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        // Wait for the popup and Turnstile to be fully ready
        await delay(12000); 

        // BEFORE SCREENSHOT
        await page.screenshot({ path: `${shotPath}1_before_claim.png`, fullPage: true });

        // --- NEW STRATEGY: Find frame by URL (Invisible to normal selectors) ---
        console.log("[PROCESS] Scanning all active frames for Cloudflare...");
        const allFrames = page.frames();
        const cfFrame = allFrames.find(f => f.url().includes('cloudflare.com') || f.url().includes('turnstile'));

        if (cfFrame) {
            console.log("[AUTH] Cloudflare frame found via frame list. Targeting coordinates...");
            
            // Get the physical position of the frame on the screen
            const frameElement = await cfFrame.frameElement();
            const rect = await frameElement.boundingBox();

            if (rect) {
                // Click the left side where the box sits
                const clickX = rect.x + 40; 
                const clickY = rect.y + (rect.height / 2);
                
                console.log(`[AUTH] Dispatching physical click to: ${clickX}, ${clickY}`);
                await page.mouse.click(clickX, clickY, { delay: 200 });
                
                console.log("[AUTH] Clicked. Waiting 8s for verification to clear...");
                await delay(8000); 
            }
        } else {
            console.log("[WARN] Still cannot detect frame. Cloudflare might be using a randomized URL.");
        }

        // 4. Click the "Claim" Button
        console.log("[PROCESS] Attempting to click the Claim button...");
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.includes('12,000'));
            
            if (claimBtn) {
                if (!claimBtn.disabled) {
                    claimBtn.click();
                    return "CLICKED";
                }
                return "FOUND_BUT_DISABLED";
            }
            return "NOT_FOUND";
        });

        console.log(`[PROCESS] Button Status: ${claimResult}`);
        if (claimResult === "CLICKED") {
            await delay(4000);
            console.log("[SUCCESS] Daily Claim process completed.");
        }

        // AFTER SCREENSHOT
        await page.screenshot({ path: `${shotPath}2_after_claim.png`, fullPage: true });

    } catch (e) { 
        console.error("[FATAL ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();