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
    console.log(`[INFO] Starting PixAI Auto-Claimer`);
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

        const isModalThere = await page.evaluate(() => document.body.innerText.includes('Daily Claim'));

        if (!isModalThere) {
            console.log("[INFO] Popup not detected. Likely already claimed.");
            return; 
        }

        console.log("[PROCESS] Executing Wide-Sweeper verification grid...");
        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        // RECALIBRATED GRID: Moving slightly left and further down
        // Area: X(370-410), Y(690-730)
        for (let x = 375; x <= 405; x += 15) {
            for (let y = 700; y <= 730; y += 15) {
                console.log(`[AUTH] Target: ${x}, ${y}`);
                await page.mouse.click(x, y);
                await delay(600); // Slower delay to help registration
            }
        }

        console.log("[WAIT] Processing (15s)...");
        await delay(15000); 

        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.includes('12,000') || b.innerText.includes('Claim'));
            if (claimBtn && !claimBtn.disabled) {
                claimBtn.click();
                return "SUCCESS";
            }
            return claimBtn ? "STILL_DISABLED" : "NOT_FOUND";
        });

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