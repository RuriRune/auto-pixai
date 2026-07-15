const fs = require("fs");
const path = require("path");

const { launchBrowser } = require("./lib/browser");
const cookiesLib = require("./lib/cookies");
const { claim } = require("./lib/claim");
const { sendPushover } = require("./lib/notify");
const { recordRun } = require("./lib/status");
const { loadSettings } = require("./lib/settings");

const HOME_URL = "https://pixai.art/";
const DATA_PATH = cookiesLib.DATA_PATH;

function log(tag, msg) {
	console.log(`[${tag}] ${msg}`);
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

async function attemptRun(headless, settings) {
	log("INFO", `Starting attempt (headless=${headless})`);

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

	const { browser, page } = await launchBrowser(headless);
	const shot = makeShot(page, settings.debugScreenshots);
	try {
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

		const result = await claim(page, log, shot);

		// Keep the session fresh regardless of outcome.
		cookiesLib.saveCookies(await page.cookies());

		return result;
	} finally {
		await browser.close();
	}
}

async function runClaim(trigger = "manual") {
	const settings = loadSettings();
	log("INFO", `Run triggered (${trigger})`);
	let result;

	const tryHeadless = settings.headlessMode !== "visible";
	const tryVisible = settings.headlessMode !== "headless";

	if (tryHeadless) {
		try {
			result = await attemptRun(true, settings);
		} catch (e) {
			log("ERROR", `Headless attempt failed: ${e.message}`);
			result = { status: "ERROR", message: e.message };
		}
	}

	const needsFallback =
		tryVisible && (result === undefined || result.status === "TURNSTILE_BLOCKED" || result.status === "ERROR");

	if (needsFallback) {
		log("INFO", "Retrying with a visible (Xvfb) browser...");
		try {
			result = await attemptRun(false, settings);
		} catch (e) {
			log("ERROR", `Visible attempt failed: ${e.message}`);
			result = { status: "ERROR", message: e.message };
		}
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
	if (!isGood) {
		const isCookieProblem = result.status === "COOKIES_MISSING" || result.status === "COOKIES_INVALID";
		await sendPushover({
			title: `PixAI claim failed: ${result.status}`,
			message: result.message || "Check the dashboard for screenshots and logs.",
			priority: isCookieProblem ? 1 : 0,
			userKey: settings.pushoverUserKey,
			appToken: settings.pushoverAppToken,
		});
	} else if (settings.notifyOnSuccess) {
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
