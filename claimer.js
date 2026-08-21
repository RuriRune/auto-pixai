const fs = require("fs");
const path = require("path");

const {
	connectAndroidChrome,
	disconnectAndroidChrome,
	forceSleepScreen,
	swipeUp,
	tapByText,
	screenHasText,
	waitForTextOnScreen,
	screencap,
} = require("./lib/androidBrowser");
const cookiesLib = require("./lib/cookies");
const { claim, claimViaAdbOnly } = require("./lib/claim");
const { sendPushover } = require("./lib/notify");
const { recordRun } = require("./lib/status");
const { loadSettings } = require("./lib/settings");
const runState = require("./lib/runState");
const { formatDuration } = require("./lib/format");

const HOME_URL = "https://pixai.art/";
const DATA_PATH = cookiesLib.DATA_PATH;

// Individual steps are bounded, but this catches a genuine end-to-end hang
// (e.g. a stuck CDP call) that would otherwise leave isRunning stuck true
// forever and silently block every future scheduled/manual run.
//
// This device is slow, and the budget has to reflect that rather than an
// optimistic best case: Chrome cold-launch + page load + reload, the Daily
// Claim modal appearing (around a minute, allowed up to 3), Turnstile
// resolving (up to ~35s with retries), and the tap/click retry loop. 10
// minutes is deliberately generous — the point of this timeout is to
// recover from a true hang, not to cut short a slow-but-working run.
const RUN_TIMEOUT_MS = 600000;

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
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${formatDuration(ms)}`)), ms);
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

// Screenshots for the ADB-only path — pulls a real device screencap
// instead of going through CDP, so the dashboard gallery still works.
function makeAdbShot(debugShots) {
	return async (name) => {
		if (!debugShots) return;
		try {
			fs.mkdirSync(DATA_PATH, { recursive: true });
			await screencap(log, path.join(DATA_PATH, `${name}.png`));
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

	let browser;
	let page;
	try {
		({ browser, page } = await connectAndroidChrome(log, signal));
	} catch (e) {
		if (e.message === "cancelled") throw e;
		// The page is loaded and the button is on screen — a failed DevTools
		// handshake shouldn't mean giving up on the run. Fall back to
		// driving the device purely through ADB and the accessibility tree.
		log("INFO", `DevTools connection failed (${e.message}) — falling back to the ADB-only claim path.`);
		const adbShot = makeAdbShot(settings.debugScreenshots);
		const result = await claimViaAdbOnly(
			log,
			adbShot,
			{ waitForTextOnScreen, screenHasText, tapByText, swipeUp },
			signal
		);
		await forceSleepScreen(log);
		return result;
	}

	const shot = makeShot(page, settings.debugScreenshots);
	try {
		throwIfCancelled(signal);
		// networkidle2 can never settle on a page with long-lived
		// connections (analytics beacons, websockets), and Puppeteer's
		// default navigation timeout doesn't always apply cleanly over a
		// remote CDP link — bound both explicitly and use a condition that
		// actually resolves. The claim flow does its own waiting for the
		// modal afterward, so we don't need the network to be fully idle.
		log("INFO", "Loading pixai.art...");
		await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
		await cookiesLib.applyCookies(page, cookies);
		log("INFO", "Reloading with session cookies applied...");
		await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });

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
