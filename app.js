require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

// ── Config ───────────────────────────────────────────────────────────────
const HOME_URL   = "https://pixai.art/";
const LOGIN_URL  = "https://pixai.art/login";
const LOGIN_NAME = process.env.LOGINNAME;
const PASSWORD   = process.env.PASSWORD;
const IS_DOCKER  = process.env.IS_DOCKER !== "false";
const DATA_PATH  = process.env.DATA_PATH || (IS_DOCKER ? "/data/" : "./data/");
const COOKIE_FILE   = path.join(DATA_PATH, "cookies.json");
const DEBUG_SHOTS   = process.env.DEBUG_SCREENSHOTS !== "false";
// unset = auto (try headless, fall back to visible); "true"/"false" forces one mode
const FORCE_HEADLESS = process.env.FORCE_HEADLESS;

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(tag, msg) {
	console.log(`[${tag}] ${msg}`);
}

async function shot(page, name) {
	if (!DEBUG_SHOTS) return;
	try {
		await page.screenshot({ path: path.join(DATA_PATH, `${name}.png`) });
	} catch (_) {}
}

// ── Cookie persistence ──────────────────────────────────────────────────
function loadCookies() {
	try {
		if (fs.existsSync(COOKIE_FILE)) {
			const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
			log("COOKIES", `Loaded ${cookies.length} cookies from ${COOKIE_FILE}`);
			return cookies;
		}
	} catch (e) {
		log("COOKIES", `Failed to load cookies, ignoring: ${e.message}`);
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
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`,
				path: cookie.path || "/",
				secure: cookie.secure ?? true,
				sameSite: cookie.sameSite || "Lax",
			});
		} catch (_) {}
	}
	log("COOKIES", `Applied ${cookies.length} cookies to page`);
}

// ── Browser ─────────────────────────────────────────────────────────────
async function launchBrowser(headless) {
	const config = { headless };

	if (IS_DOCKER) {
		config.executablePath = "/usr/bin/google-chrome";
		config.args = [
			"--disable-gpu",
			"--disable-setuid-sandbox",
			"--no-sandbox",
			"--no-zygote",
			"--disable-blink-features=AutomationControlled",
		];
		if (!headless) {
			config.args.push(`--display=${process.env.DISPLAY || ":99"}`);
		}
	}

	const browser = await puppeteer.launch(config);
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	await page.setUserAgent(
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
			"AppleWebKit/537.36 (KHTML, like Gecko) " +
			"Chrome/124.0.0.0 Safari/537.36"
	);
	return { browser, page };
}

// ── Generic text-based button helpers ──────────────────────────────────
// Site DOM/classnames drift over time; matching visible text is far more
// durable than nth-of-type CSS paths.
async function clickByText(page, pattern, { timeout = 8000, requireEnabled = false } = {}) {
	try {
		await page.waitForFunction(
			(pat, reqEnabled) => {
				const re = new RegExp(pat, "i");
				return Array.from(document.querySelectorAll("button, [role='button'], a")).some((el) => {
					if (!re.test((el.innerText || el.textContent || "").trim())) return false;
					if (reqEnabled && el.disabled) return false;
					return true;
				});
			},
			{ timeout },
			pattern.source,
			requireEnabled
		);
	} catch (_) {
		return false;
	}

	return await page.evaluate(
		(pat, reqEnabled) => {
			const re = new RegExp(pat, "i");
			const el = Array.from(document.querySelectorAll("button, [role='button'], a")).find((el) => {
				if (!re.test((el.innerText || el.textContent || "").trim())) return false;
				if (reqEnabled && el.disabled) return false;
				return true;
			});
			if (!el) return false;
			el.click();
			return true;
		},
		pattern.source,
		requireEnabled
	);
}

async function isLoggedIn(page) {
	return await page.evaluate(() => {
		const els = Array.from(document.querySelectorAll("button, [role='button'], a"));
		return !els.some((el) => /^sign\s*in$/i.test((el.innerText || el.textContent || "").trim()));
	});
}

// ── Login ────────────────────────────────────────────────────────────────
async function login(page) {
	if (!LOGIN_NAME || !PASSWORD) {
		throw new Error("LOGINNAME / PASSWORD env vars are not set");
	}

	await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
	await delay(500);

	const hasDirectFields = (await page.$("#email-input")) && (await page.$("#password-input"));

	if (hasDirectFields) {
		log("LOGIN", "Classic email/password fields found — filling directly.");
		await page.type("#email-input", LOGIN_NAME, { delay: 30 });
		await page.type("#password-input", PASSWORD, { delay: 30 });
		await delay(300);
		await page.click('button[type="submit"]');
	} else {
		log("LOGIN", "Classic fields not present — trying 'Continue with Email' flow.");
		await shot(page, "login_no_direct_fields");

		const openedEmail = await clickByText(page, /continue with email/i, { timeout: 8000 });
		if (!openedEmail) {
			await shot(page, "login_fail_continue_with_email");
			throw new Error("'Continue with Email' button not found");
		}
		await delay(600);

		try {
			await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 8000 });
		} catch (_) {
			await shot(page, "login_fail_email_field");
			throw new Error("Email input not found");
		}
		await page.type('input[type="email"], input[name="email"]', LOGIN_NAME, { delay: 30 });

		try {
			await page.waitForSelector('input[type="password"]', { timeout: 5000 });
		} catch (_) {
			await shot(page, "login_fail_password_field");
			throw new Error("Password input not found");
		}
		await page.type('input[type="password"]', PASSWORD, { delay: 30 });
		await delay(300);

		const clicked = await clickByText(page, /^log[\s-]?in$/i, { timeout: 5000 });
		if (!clicked) {
			log("LOGIN", "Submit button not matched by text — pressing Enter as fallback.");
			await page.keyboard.press("Enter");
		}
	}

	try {
		await page.waitForFunction(
			() =>
				!Array.from(document.querySelectorAll("button, [role='button'], a")).some((el) =>
					/^sign\s*in$/i.test((el.innerText || el.textContent || "").trim())
				),
			{ timeout: 20000 }
		);
	} catch (_) {
		await shot(page, "login_fail_confirm");
		throw new Error("Session not confirmed within 20s after login attempt");
	}

	saveCookies(await page.cookies());
	log("LOGIN", "Logged in and cookies saved.");
}

// ── Turnstile ────────────────────────────────────────────────────────────
// Turnstile here is the checkbox-style widget: it usually self-solves based
// on browser fingerprint, but occasionally needs the checkbox clicked once.
// No third-party solving service required.
async function isClaimButtonEnabled(page) {
	return await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(
			(b) => /claim/i.test((b.innerText || "").trim()) && !/claimed/i.test((b.innerText || "").trim())
		);
		return !!(btn && !btn.disabled);
	});
}

function findTurnstileFrame(page) {
	return page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));
}

async function resolveTurnstileIfPresent(page, timeoutMs = 15000) {
	if (!findTurnstileFrame(page)) return true; // nothing to solve

	log("TURNSTILE", "Challenge iframe detected — waiting to see if it self-solves...");
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isClaimButtonEnabled(page)) {
			log("TURNSTILE", "Claim button enabled — self-solved.");
			return true;
		}
		await delay(500);
	}

	const frame = findTurnstileFrame(page);
	if (frame) {
		log("TURNSTILE", "Did not self-solve in time — clicking the checkbox once.");
		try {
			const checkbox = await frame.waitForSelector('input[type="checkbox"], [role="checkbox"], .cb-c', {
				timeout: 4000,
			});
			await checkbox.click();
		} catch (e) {
			log("TURNSTILE", `Could not locate/click checkbox: ${e.message}`);
		}
	}

	const secondStart = Date.now();
	while (Date.now() - secondStart < 15000) {
		if (await isClaimButtonEnabled(page)) {
			log("TURNSTILE", "Claim button enabled after checkbox click.");
			return true;
		}
		await delay(500);
	}

	log("TURNSTILE", "Claim button never enabled — giving up on this attempt.");
	return false;
}

// ── Claim ────────────────────────────────────────────────────────────────
async function isAlreadyClaimed(page) {
	return await page.evaluate(() => {
		const text = document.body ? document.body.innerText : "";
		return (
			/already claimed|next reward available|credits claimed/i.test(text) ||
			/已認領|已认领|申請済み/.test(text)
		);
	});
}

async function claim(page) {
	// Dismiss any startup/onboarding dialog, same idea as the original's
	// "cancel initial screen" step, but matched by text instead of a fixed path.
	try {
		const dismissed = await clickByText(page, /^(close|cancel|later|no thanks|skip|maybe later)$/i, {
			timeout: 3000,
		});
		if (dismissed) await delay(500);
	} catch (_) {}

	await shot(page, "1_before_claim");

	if (await isAlreadyClaimed(page)) {
		log("CLAIM", "Already claimed today — nothing to do.");
		return "ALREADY_CLAIMED";
	}

	const solved = await resolveTurnstileIfPresent(page);
	if (!solved) {
		await shot(page, "2_turnstile_unresolved");
		return "TURNSTILE_BLOCKED";
	}

	try {
		await page.waitForFunction(
			() => {
				const btn = Array.from(document.querySelectorAll("button")).find(
					(b) => /claim/i.test((b.innerText || "").trim()) && !/claimed/i.test((b.innerText || "").trim())
				);
				return !!(btn && !btn.disabled);
			},
			{ timeout: 10000 }
		);
	} catch (_) {
		// fall through — we'll still attempt the click below and report what happened
	}

	const clicked = await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(
			(b) => /claim/i.test((b.innerText || "").trim()) && !/claimed/i.test((b.innerText || "").trim())
		);
		if (btn && !btn.disabled) {
			btn.click();
			return true;
		}
		return false;
	});

	await delay(1500);
	await shot(page, "2_after_claim");

	if (!clicked) return "CLAIM_BUTTON_NOT_FOUND";

	if (await isAlreadyClaimed(page)) return "SUCCESS";
	await delay(1500);
	if (await isAlreadyClaimed(page)) return "SUCCESS";

	return "CLICKED_UNCONFIRMED";
}

// ── One full attempt at a given headless setting ─────────────────────────
async function attemptRun(headless) {
	log("INFO", `Starting attempt (headless=${headless})`);
	const { browser, page } = await launchBrowser(headless);
	try {
		await page.goto(HOME_URL, { waitUntil: "networkidle2" });

		const cookies = loadCookies();
		if (cookies.length) {
			await applyCookies(page, cookies);
			await page.reload({ waitUntil: "networkidle2" });
		}

		if (!(await isLoggedIn(page))) {
			log("AUTH", "Not logged in — running login flow.");
			await login(page);
			await page.goto(HOME_URL, { waitUntil: "networkidle2" });
		} else {
			log("AUTH", "Session restored from cookies — skipping login.");
		}

		const result = await claim(page);

		// Resave cookies after every run so the session stays fresh, win or lose.
		saveCookies(await page.cookies());

		return result;
	} finally {
		await browser.close();
	}
}

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
	log("INFO", "Starting PixAI Auto-Claimer");
	let result;

	const tryHeadless = FORCE_HEADLESS !== "false";
	const tryVisible = FORCE_HEADLESS !== "true";

	if (tryHeadless) {
		try {
			result = await attemptRun(true);
		} catch (e) {
			log("ERROR", `Headless attempt failed: ${e.message}`);
			result = "ERROR";
		}
	}

	const needsFallback = tryVisible && (result === "TURNSTILE_BLOCKED" || result === "ERROR" || result === undefined);

	if (needsFallback) {
		log("INFO", "Retrying with a visible (Xvfb) browser...");
		try {
			result = await attemptRun(false);
		} catch (e) {
			log("ERROR", `Visible attempt failed: ${e.message}`);
			result = "ERROR";
		}
	}

	log("RESULT", result);
	process.exit(result === "SUCCESS" || result === "ALREADY_CLAIMED" ? 0 : 1);
}

run();
