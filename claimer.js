const fs = require("fs");
const path = require("path");

const {
	prepareDevice,
	connectCdpForCookies,
	detachCdp,
	forceSleepScreen,
	swipeUp,
	tapByText,
	screenHasText,
	waitForTextOnScreen,
	screencap,
} = require("./lib/androidBrowser");
const cookiesLib = require("./lib/cookies");
const { claimViaAdbOnly } = require("./lib/claim");
const { sendPushover } = require("./lib/notify");
const { recordRun } = require("./lib/status");
const { loadSettings, pushoverConfigured } = require("./lib/settings");
const runState = require("./lib/runState");
const { formatDuration } = require("./lib/format");

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
	log("INFO", "Starting attempt (ADB-driven on real Android Chrome)");

	// Cookie state is informational here rather than blocking: the phone's
	// Chrome holds its own logged-in session, so a stale/missing
	// cookies.json doesn't necessarily mean the device can't claim. Warn
	// loudly, but let the run proceed and find out on-screen.
	if (!cookiesLib.cookieFileExists()) {
		log("INFO", "No cookies.json present — relying on the device's own Chrome session.");
	} else {
		try {
			const cookies = cookiesLib.loadCookies();
			if (!cookiesLib.hasAuthCookieInList(cookies)) {
				log("INFO", "cookies.json has no auth cookie — relying on the device's own Chrome session.");
			} else if (!cookiesLib.isAuthCookieFresh(cookies)) {
				log("INFO", `Saved cookie expired ${cookiesLib.authCookieExpiry(cookies)} — relying on the device's own Chrome session.`);
			}
		} catch (_) {}
	}

	throwIfCancelled(signal);
	await prepareDevice(log, signal);

	const shot = makeAdbShot(settings.debugScreenshots);
	try {
		throwIfCancelled(signal);
		const result = await claimViaAdbOnly(
			log,
			shot,
			{ waitForTextOnScreen, screenHasText, tapByText, swipeUp },
			signal
		);

		// Best-effort only: a CDP connection purely to read back fresh
		// session cookies so the saved session keeps rolling forward.
		// Claiming already succeeded at this point — any failure here is
		// logged and ignored rather than affecting the run's outcome.
		if (result.status === "SUCCESS" || result.status === "ALREADY_CLAIMED") {
			let browser;
			try {
				log("INFO", "Refreshing saved cookies from the device (optional)...");
				const conn = await connectCdpForCookies(log);
				browser = conn.browser;
				const fresh = await conn.page.cookies();
				if (cookiesLib.hasAuthCookieInList(fresh)) {
					cookiesLib.saveCookies(fresh);
					log("INFO", "Saved cookies refreshed from the device session.");
				} else {
					log("INFO", "Device session had no auth cookie to save — leaving cookies.json as-is.");
				}
			} catch (e) {
				log("INFO", `Cookie refresh skipped (${e.message}) — claim itself was unaffected.`);
			} finally {
				await detachCdp(browser, log);
			}
		}

		return result;
	} finally {
		// Runs on success, failure, and cancellation alike.
		await forceSleepScreen(log);
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
			// established, attemptRun's own cleanup never ran —
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
				// The stuck attempt's own cleanup may
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
	const shouldNotify = (!isGood && result.status !== "CANCELLED") || (isGood && settings.notifyOnSuccess);

	if (shouldNotify) {
		if (!pushoverConfigured(settings)) {
			log("PUSHOVER", "Notification skipped — no Pushover user key / app token configured.");
		} else {
			const isCookieProblem =
				result.status === "COOKIES_MISSING" || result.status === "COOKIES_INVALID" || result.status === "COOKIES_EXPIRED";
			const res = await sendPushover({
				title: isGood ? `PixAI claim: ${result.status}` : `PixAI claim failed: ${result.status}`,
				message: result.message || (isGood ? "" : "Check the dashboard for screenshots and logs."),
				priority: !isGood && isCookieProblem ? 1 : 0,
				userKey: settings.pushoverUserKey,
				appToken: settings.pushoverAppToken,
			});
			if (res && res.status === 1) {
				log("PUSHOVER", "Notification sent.");
			} else {
				const reason = res && (res.reason || res.error || (res.errors && res.errors.join(", ")));
				log("PUSHOVER", `Notification FAILED: ${reason || "unknown error"}`);
			}
		}
	} else if (isGood) {
		log("PUSHOVER", 'Notification skipped — run succeeded and "notify on success" is off.');
	}

	return entry;
}

module.exports = { runClaim };
