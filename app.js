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
    console.log(`[INFO] Starting PixAI Auto-Claimer (Final Production Version)`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"] : []
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        // 1. Initial Login
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        const localCookies = await parseLocalCookies(COOKIE_STRING);
        await applyCookies(page, localCookies);

        // 2. Navigate to target
        console.log("[NAV] Moving to Generator...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        console.log("[WAIT] Waiting 15s for modal animation...");
        await delay(15000); 

        // 3. Smart-Check: Is the modal actually there?
        const isModalThere = await page.evaluate(() => {
            return document.body.innerText.includes('Daily Claim');
        });

        if (!isModalThere) {
            console.log("[INFO] 'Daily Claim' popup not detected. Likely already claimed for today.");
            await page.screenshot({ path: `${shotPath}already_claimed_check.png` });
            return; 
        }

        // 4. Verification: The Grid-Hit Strategy
        console.log("[PROCESS] Popup detected. Executing verification grid...");
        await page.screenshot({ path: `${shotPath}1_before_claim.png` });

        // This grid covers the checkbox area centered on ~480, 700
        for (let x = 475; x <= 495; x += 10) {
            for (let y = 695; y <= 705; y += 5) {
                console.log(`[AUTH] Clicking grid point: ${x}, ${y}`);
                await page.mouse.click(x, y);
                await delay(400); // Human-like pause between clicks
            }
        }

        console.log("[WAIT] Processing verification (12s)...");
        await delay(12000); 

        // 5. Final Claim Action
        const claimResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            // Look for the text '12,000' or 'Claim'
            const claimBtn = btns.find(b => b.innerText.includes('12,000') || b.innerText.includes('Claim'));
            
            if (claimBtn) {
                if (!claimBtn.disabled) {
                    claimBtn.click();
                    return "SUCCESS";
                }
                return "STILL_DISABLED";
            }
            return "NOT_FOUND";
        });

        console.log(`[RESULT] Claim Status: ${claimResult}`);
        
        // 6. Cleanup & Final Evidence
        await delay(4000);
        await page.screenshot({ path: `${shotPath}2_after_claim.png` });

        if (claimResult === "SUCCESS") {
            console.log("[FINISH] Credits claimed successfully!");
        } else if (claimResult === "STILL_DISABLED") {
            console.warn("[WARN] Checkbox was missed or Cloudflare blocked the click.");
        }

    } catch (e) { 
        console.error("[FATAL ERROR]", e.message); 
    } finally { 
        await browser.close(); 
        console.log("[EXIT] Done."); 
    }
}

run();