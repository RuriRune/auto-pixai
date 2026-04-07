require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

// Ensure screenshot directory exists
const shotDir = '/screenshots';
if (isDocker && !fs.existsSync(shotDir)) {
    fs.mkdirSync(shotDir, { recursive: true });
}

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

async function applyCookies(page) {
    if (!COOKIE_STRING) {
        console.error("[ERROR] No PIXAI_COOKIE found.");
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

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Precision Mode)...");

    const config = { 
        headless: "new",
        executablePath: isDocker ? "/usr/bin/google-chrome" : undefined,
        args: isDocker ? [
            "--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", 
            "--no-zygote", "--disable-dev-shm-usage", `--lang=${LANG}`
        ] : []
    };

    const browser = await puppeteer.launch(config);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

    try {
        console.log("[NAV] Navigating to PixAI...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        await applyCookies(page);
        await page.reload({ waitUntil: "networkidle2" });
        console.log("[AUTH] Session active. Waiting for Cloudflare/Popup...");

        let claimed = false;
        const maxAttempts = 15; 

        for (let i = 0; i < maxAttempts; i++) {
            console.log(`[PROCESS] Scan attempt ${i + 1}/${maxAttempts}...`);
            
            // Check for the "Claim" button
            const targetFound = await page.evaluate(() => {
                const keywords = ['claim', 'get', 'collect', 'check-in', 'receive'];
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span, a'));
                
                const btn = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
                    
                    const hasKeyword = keywords.some(k => text.includes(k));
                    const isNotInvite = !text.includes('invite') && !text.includes('rebate');
                    const hasNumbers = /\d/.test(text); // Looks for "10,000" or similar

                    return hasKeyword && isVisible && isNotInvite && hasNumbers;
                });

                if (btn) {
                    btn.scrollIntoView();
                    btn.click();
                    return { success: true, text: btn.innerText.trim() };
                }
                return { success: false };
            });

            if (targetFound.success) {
                console.log(`[SUCCESS] Found and clicked: "${targetFound.text}"`);
                claimed = true;
                await delay(3000); // Wait for click to register
                break;
            }

            await delay(2000); 
        }

        if (!claimed) {
            console.log("[CRITICAL] Claim button not found after 30s.");
        }

    } catch (error) {
        console.error("[FATAL ERROR]", error.message);
    } finally {
        // ALWAYS save the final state so you can see if the button changed to "Claimed"
        if (isDocker) {
            await page.screenshot({ path: `${shotDir}/last_run_state.png`, fullPage: true });
            console.log("[DEBUG] Final screenshot saved (overwriting last run).");
        }
        await browser.close();
        console.log("[EXIT] Process completed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});