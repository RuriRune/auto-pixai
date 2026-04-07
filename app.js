require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
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
        } catch (e) { }
    }
}

async function parseLocalCookies(cookieStr) {
    if (!cookieStr) return [];
    let decoded = cookieStr;
    if (!cookieStr.includes('\t') && !cookieStr.includes('=')) {
        decoded = Buffer.from(cookieStr, 'base64').toString('utf-8');
    }
    const lines = decoded.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    return lines.map(line => {
        const tabs = line.split('\t');
        return { name: tabs[5], value: tabs[6], domain: tabs[0], path: tabs[2] };
    });
}

async function run() {
    console.log(`[INFO] Starting PixAI Auto-Claimer (Optimized Grid-Hit)`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] : []
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);

        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        await delay(15000); 

        // 1. Fire the Grid Clicks (The "Secret Sauce")
        console.log("[PROCESS] Executing verification grid...");
        for (let x = 470; x <= 490; x += 10) {
            for (let y = 695; y <= 705; y += 5) {
                await page.mouse.click(x, y);
                await delay(300);
            }
        }

        console.log("[WAIT] Processing verification (12s)...");
        await delay(12000); 

        // 2. Final Claim
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.includes('12,000'));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "SUCCESS";
            }
            return "FAILED_OR_NOT_FOUND";
        });

        console.log(`[RESULT] Claim Status: ${claimResult}`);
        
        if (claimResult === "SUCCESS") {
            await delay(3000);
            await page.screenshot({ path: `${shotPath}last_success.png` });
        }

    } catch (e) { 
        console.error("[ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Script complete."); 
    }
}

run();