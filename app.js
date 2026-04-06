require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function applyCookies(page) {
    if (!COOKIE_STRING) {
        console.error("[ERROR] No PIXAI_COOKIE found in environment variables.");
        return;
    }
    const cookies = COOKIE_STRING.split(";").map(c => {
        const [name, ...rest] = c.trim().split("=");
        return {
            name,
            value: rest.join("="),
            domain: ".pixai.art",
            path: "/"
        };
    });
    await page.setCookie(...cookies);
    console.log("[AUTH] Cookies applied to session.");
}

async function smartClaim(page) {
    console.log("[PROCESS] Starting Smart Search for claim buttons...");
    
    // Give the page 5 seconds to load any annoying popups
    await delay(5000);

    const result = await page.evaluate(() => {
        // List of keywords PixAI uses for daily rewards
        const keywords = ['claim', 'get', 'collect', 'check-in', 'receive', 'daily', 'credits'];
        
        // Find all clickable elements
        const elements = Array.from(document.querySelectorAll('button, a, div[role="button"], span'));
        
        // Filter for elements that contain our keywords and are actually visible
        const target = elements.find(el => {
            const text = el.innerText.toLowerCase();
            const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
            return keywords.some(k => text.includes(k)) && isVisible;
        });

        if (target) {
            target.click();
            return { success: true, text: target.innerText.trim() };
        }
        return { success: false };
    });

    if (result.success) {
        console.log(`[SUCCESS] Found and clicked: "${result.text}"`);
        await delay(2000); // Wait for click to register
    } else {
        console.log("[NOTICE] No claim button found in popup. Trying fallback navigation...");
        // Fallback: Go directly to the credit page if the popup didn't show
        await page.goto("https://pixai.art/generator/credit", { waitUntil: "networkidle2" });
        await delay(3000);
        
        // Try one more search on the credit page
        const fallbackResult = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const claimBtn = btns.find(b => b.innerText.toLowerCase().includes('claim'));
            if (claimBtn) { claimBtn.click(); return true; }
            return false;
        });
        
        if (fallbackResult) {
            console.log("[SUCCESS] Claimed via Credits page fallback.");
        } else {
            console.log("[CRITICAL] All claim methods failed. Button might not be available yet.");
        }
    }
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Plan B)...");

    const config = { 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? [
            "--disable-gpu", 
            "--disable-setuid-sandbox", 
            "--no-sandbox", 
            "--no-zygote", 
            "--disable-dev-shm-usage",
            `--lang=${LANG}`
        ] : []
    };

    const browser = await puppeteer.launch(config);
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    try {
        console.log("[NAV] Navigating to PixAI...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        await applyCookies(page);
        
        // Reload to ensure login state is active
        await page.reload({ waitUntil: "networkidle2" });
        console.log("[AUTH] Session active.");

        await smartClaim(page);

    } catch (error) {
        console.error("[FATAL ERROR]", error.message);
    } finally {
        await browser.close();
        console.log("[EXIT] Process completed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});