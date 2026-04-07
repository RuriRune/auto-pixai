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
        } catch (e) { /* Skip */ }
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
    console.log(`[INFO] Starting PixAI Auto-Claimer (Position-Injection Mode)`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", `--lang=${LANG}`] : []
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);

        console.log("[NAV] Navigating to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(12000); 

        await page.screenshot({ path: `${shotPath}1_before_claim.png`, fullPage: true });

        // --- NEW STRATEGY: Use JS to find the Iframe position ---
        console.log("[PROCESS] Locating Turnstile position via JS injection...");
        const rect = await page.evaluate(() => {
            const iframe = Array.from(document.querySelectorAll('iframe')).find(f => 
                f.src.includes('cloudflare.com') || f.src.includes('turnstile')
            );
            if (!iframe) return null;
            const box = iframe.getBoundingClientRect();
            return { x: box.left, y: box.top, width: box.width, height: box.height };
        });

        if (rect && rect.width > 0) {
            console.log(`[AUTH] Target found at (${rect.x}, ${rect.y}). Clicking...`);
            
            // The checkbox is about 30px from the left of the iframe
            const clickX = rect.x + 30;
            const clickY = rect.y + (rect.height / 2);
            
            await page.mouse.click(clickX, clickY, { delay: 200 });
            console.log("[AUTH] Click dispatched. Waiting 8s...");
            await delay(8000); 
        } else {
            console.log("[WARN] Could not find iframe via JS or it has 0 size.");
        }

        // 4. Click the "Claim" Button
        console.log("[PROCESS] Finalizing Claim...");
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.includes('12,000'));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "CLICKED";
            }
            return claimBtn ? "DISABLED" : "NOT_FOUND";
        });

        console.log(`[PROCESS] Button Status: ${claimResult}`);
        if (claimResult === "CLICKED") await delay(4000);

        await page.screenshot({ path: `${shotPath}2_after_claim.png`, fullPage: true });

    } catch (e) { 
        console.error("[FATAL ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();