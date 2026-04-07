require('dotenv').config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require('fs');
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/en/generator/image";
const COOKIE_STRING = process.env.PIXAI_COOKIE || "";
const isDocker = process.env.IS_DOCKER !== 'false';
const LANG = process.env.APP_LANG || "en-GB";

const shotDir = '/screenshots';
if (isDocker && !fs.existsSync(shotDir)) {
    fs.mkdirSync(shotDir, { recursive: true });
}

function delay(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

/**
 * Advanced Cookie Parser: Handles Netscape format, JSON, or standard strings
 */
async function applyCookies(page) {
    if (!COOKIE_STRING) {
        console.error("[ERROR] No PIXAI_COOKIE found.");
        return;
    }

    const lines = COOKIE_STRING.split('\n');
    let count = 0;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        // Handle Netscape/Tab format (7 columns)
        const tabs = line.split('\t');
        if (tabs.length >= 7) {
            const [domain, flag, path, secure, expires, name, value] = tabs;
            await page.setCookie({
                name: name.trim(),
                value: value.trim(),
                domain: domain.startsWith('.') ? domain : `.${domain}`,
                path: path,
                secure: secure.toUpperCase() === 'TRUE',
                httpOnly: false, // Netscape doesn't track this, but usually safe as false
                sameSite: 'Lax'
            });
            count++;
        } 
        // Handle standard semicolon format (name=value; name2=value2)
        else if (line.includes('=')) {
            const pairs = line.split(';');
            for (const pair of pairs) {
                const [name, ...valParts] = pair.trim().split('=');
                if (!name || valParts.length === 0) continue;
                const value = valParts.join('=');
                
                const cookieParams = {
                    name: name.trim(),
                    value: value.trim(),
                    path: '/',
                    secure: true,
                    sameSite: 'Lax'
                };
                await page.setCookie({ ...cookieParams, domain: '.pixai.art' });
                await page.setCookie({ ...cookieParams, domain: 'pixai.art' });
                count++;
            }
        }
    }
    console.log(`[AUTH] Parsed and applied ${count} cookie parameters.`);
}

async function run() {
    console.log("[INFO] Starting PixAI Auto-Claimer (Cookie-Engine V3)...");

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
    await page.setViewport({ width: 1280, height: 1024 }); // Slightly taller for popups
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    try {
        // 1. Visit domain once to initialize
        console.log("[NAV] Initializing...");
        await page.goto("https://pixai.art", { waitUntil: "networkidle2" });
        
        // 2. Apply complex cookies
        await applyCookies(page);
        
        // 3. Navigate to the specific generator page
        console.log("[NAV] Navigating to Generator with Session...");
        await page.goto(url, { waitUntil: "networkidle2" });
        
        // 4. Wait for session check
        await delay(6000);

        let claimed = false;
        const maxAttempts = 15; 

        for (let i = 0; i < maxAttempts; i++) {
            console.log(`[PROCESS] Scan attempt ${i + 1}/${maxAttempts}...`);
            
            const result = await page.evaluate(() => {
                const keywords = ['claim', 'get', 'collect', 'check-in', 'receive'];
                const elements = Array.from(document.querySelectorAll('button, div[role="button"], span, a'));
                
                const btn = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
                    
                    const hasKeyword = keywords.some(k => text.includes(k));
                    const isNotInvite = !text.includes('invite') && !text.includes('rebate');
                    const hasNumbers = /\d/.test(text);

                    return hasKeyword && isVisible && isNotInvite && hasNumbers;
                });

                if (btn) {
                    btn.click();
                    return { success: true, text: btn.innerText.trim() };
                }
                return false;
            });

            if (result && result.success) {
                console.log(`[SUCCESS] Found and clicked: "${result.text}"`);
                claimed = true;
                await delay(5000); 
                break;
            }

            await delay(2000); 
        }

        if (!claimed) {
            console.log("[CRITICAL] Claim button not found. Verify login state in screenshot.");
        }

    } catch (error) {
        console.error("[FATAL ERROR]", error.message);
    } finally {
        if (isDocker) {
            await page.screenshot({ path: `${shotDir}/last_run_state.png`, fullPage: true });
            console.log("[DEBUG] State saved to /screenshots/last_run_state.png");
        }
        await browser.close();
        console.log("[EXIT] Process completed.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});