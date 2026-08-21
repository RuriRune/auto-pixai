const fs = require("fs");
const path = require("path");

const { connectAndroidChrome, disconnectAndroidChrome, forceSleepScreen, swipeUp, tapByText } = require("./lib/androidBrowser");
const cookiesLib = require("./lib/cookies");
const { claim } = require("./lib/claim");
const { sendPushover } = require("./lib/notify");
const { recordRun } = require("./lib/status");
const { loadSettings } = require("./lib/settings");
const runState = require("./lib/runState");

const HOME_URL = "https://pixai.art/";
const DATA_PATH = cookiesLib.DATA_PATH;

// Individual steps (adb calls, DevTools fetch, Turnstile waits) are already
// bounded, but nothing previously caught a genuine end-to-end hang (e.g. a
// stuck CDP call). Without this, a hung run would leave isRunning stuck
// true forever and silently block every future scheduled/manual run.
// Worst-case realistic budget: Chrome cold-launch + page load + reload
// (~30-50s) + the Daily Claim modal appearing (up to 90s on this device)
// + Turnstile resolving (up to ~35s with retries) + the tap/click retry
// loop (~10s) can approach 200s on a slow run — 300s gives real margin
// above that rather than just above the "everything goes smoothly" case.
const RUN_TIMEOUT_MS = 300000;

class CancelledError extends Error {
	constructor() {
		super("Run cancelled by user");
		this.name = "CancelledError";
	}
}

// Every log() call doubles as a live progress update — every module that
// already receives `log` (androidBrowser.js, claim.js) calls it at each
// meaningful checkpoint, so the dashboard's "current step" comes along for
// free with no extra threading needed.
function log(tag, msg) {
	console.log(`[${tag}] ${msg}`);
	runState.setStep(`[${tag}] ${msg}`);
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeShot(page, debugShots) {
	return async (name) => {
		if (!debugShots) return;
		try {
			fs.mkdirSync(DATA_PATH, { recursive: true });
			await page.screenshot({ path: path.join(DATA_PATH, `${name}.png`) });
		} catch (_) {}
	};
}

function throwIfCancelled(signal) {
	if (signal && signal.aborted) throw new CancelledError();
}

async function attemptRun(settings, signal) {
	log("INFO", "Starting attempt (real Android Chrome via ADB)");

	if (!cookiesLib.cookieFileExists()) {
		return {
			status: "COOKIES_MISSING",
			message: `No cookie file at ${cookiesLib.COOKIE_FILE}. Export a logged-in session and place it there.`,
		};
	}

	const cookies = cookiesLib.loadCookies();
	if (!cookies.length || !cookiesLib.hasAuthCookieInList(cookies)) {
		return {
			status: "COOKIES_INVALID",
			message: "cookies.json has no user_token auth cookie — it's analytics-only or malformed. Re-export a fresh session.",
		};
	}
	if (!cookiesLib.isAuthCookieFresh(cookies)) {
		return {
			status: "COOKIES_EXPIRED",
			message: `The user_token cookie expired ${cookiesLib.authCookieExpiry(cookies)}. Re-export a fresh session and replace cookies.json.`,
		};
	}

	throwIfCancelled(signal);
	const { browser, page } = await connectAndroidChrome(log, signal);
	const shot = makeShot(page, settings.debugScreenshots);
	try {
		throwIfCancelled(signal);
		await page.goto(HOME_URL, { waitUntil: "networkidle2" });
		await cookiesLib.applyCookies(page, cookies);
		await page.reload({ waitUntil: "networkidle2" });

		if (!(await cookiesLib.hasAuthCookie(page))) {
			await shot("cookies_rejected");
			return {
				status: "COOKIES_INVALID",
				message: "Site rejected the saved cookies (expired or invalidated). Re-export a fresh session.",
			};
		}

		throwIfCancelled(signal);
		const result = await claim(page, log, shot, swipeUp, tapByText, signal);

		// Keep the session fresh regardless of outcome.
		cookiesLib.saveCookies(await page.cookies());

		return result;
	} finally {
		// Runs on cancellation too (the throw propagates through this try
		// block), so a cancelled run puts the phone back to sleep exactly
		// like a completed one — no separate cleanup path needed.
		await disconnectAndroidChrome(browser, log);
	}
}

async function runClaim(trigger = "manual") {
	const settings = loadSettings();
	log("INFO", `Run triggered (${trigger})`);
	let result;

	const controller = runState.startRun();
	const signal = controller.signal;

	try {
		result = await withTimeout(attemptRun(settings, signal), RUN_TIMEOUT_MS, "Run");
	} catch (e) {
		if (e instanceof CancelledError || e.name === "AbortError") {
			log("INFO", "Run was cancelled.");
			result = { status: "CANCELLED", message: "Cancelled by user." };
			// If cancellation happened before a browser connection was ever
			// established, disconnectAndroidChrome's finally block never ran —
			// make sure the screen doesn't stay stuck awake regardless.
			await forceSleepScreen(log);
		} else {
			log("ERROR", `Attempt failed: ${e.message}`);
			const isTimeout = e.message.includes("timed out after");
			result = {
				status: isTimeout ? "TIMEOUT" : "ERROR",
				message: isTimeout
					? e.message
					: `${e.message} (check the Android device is powered on, connected to WiFi, and reachable at ANDROID_ADB_HOST:ANDROID_ADB_PORT)`,
			};
			if (isTimeout) {
				// The stuck attempt's own cleanup (disconnectAndroidChrome) may
				// never run — it's still out there hung, not cancelled. Don't
				// leave the screen lit indefinitely waiting for it.
				log("INFO", "Run timed out — attempting to put the screen back to sleep independently.");
				await forceSleepScreen(log);
			}
		}
	} finally {
		runState.endRun();
	}

	const entry = {
		timestamp: new Date().toISOString(),
		trigger,
		status: result.status,
		message: result.message || "",
	};
	recordRun(entry);
	log("RESULT", JSON.stringify(entry));

	const isGood = result.status === "SUCCESS" || result.status === "ALREADY_CLAIMED";
	if (!isGood && result.status !== "CANCELLED") {
		const isCookieProblem = result.status === "COOKIES_MISSING" || result.status === "COOKIES_INVALID" || result.status === "COOKIES_EXPIRED";
		await sendPushover({
			title: `PixAI claim failed: ${result.status}`,
			message: result.message || "Check the dashboard for screenshots and logs.",
			priority: isCookieProblem ? 1 : 0,
			userKey: settings.pushoverUserKey,
			appToken: settings.pushoverAppToken,
		});
	} else if (isGood && settings.notifyOnSuccess) {
		await sendPushover({
			title: `PixAI claim: ${result.status}`,
			message: result.message || "",
			userKey: settings.pushoverUserKey,
			appToken: settings.pushoverAppToken,
		});
	}

	return entry;
}

module.exports = { runClaim };
