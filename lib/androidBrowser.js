const { execFile } = require("child_process");
const { promisify } = require("util");
const puppeteer = require("puppeteer-core");
const { formatDuration } = require("./format");

const execFileP = promisify(execFile);

const ADB_HOST = process.env.ANDROID_ADB_HOST || "android";
const ADB_PORT = process.env.ANDROID_ADB_PORT || "5555";
const ADB_SERIAL = `${ADB_HOST}:${ADB_PORT}`;
const DEVTOOLS_LOCAL_PORT = process.env.ANDROID_DEVTOOLS_PORT || "9222";
const CHROME_PACKAGE = "com.android.chrome";

const ADB_TIMEOUT_MS = 15000;

async function adb(args, log, timeout = ADB_TIMEOUT_MS, signal) {
	try {
		const { stdout, stderr } = await execFileP("adb", args, { timeout, signal });
		if (log && stderr && stderr.trim()) log("ADB", stderr.trim());
		return stdout.trim();
	} catch (e) {
		if (e.name === "AbortError") throw e;
		if (e.killed || e.signal === "SIGTERM") {
			throw new Error(`adb ${args.join(" ")} timed out after ${formatDuration(timeout)} — is the Android device up and reachable?`);
		}
		throw e;
	}
}

async function getScreenSize(log) {
	const sizeOut = await adb(["-s", ADB_SERIAL, "shell", "wm", "size"], log);
	const match = sizeOut.match(/(\d+)x(\d+)/);
	if (!match) return null;
	return { w: parseInt(match[1], 10), h: parseInt(match[2], 10) };
}

// Finds an on-screen element by visible text using Android's own
// accessibility inspection (uiautomator), then taps its real physical
// screen coordinates via genuine OS-level touch injection — the same
// mechanism a real finger tap goes through, entirely bypassing Chrome's
// CDP/DevTools input pipeline. Used as a last-resort fallback when CDP-
// dispatched mouse clicks and touch events (page.touchscreen.tap) don't
// register, since those are synthesized inside Chrome's renderer rather
// than injected at the OS input-device level the way a real tap is.
const UI_DUMP_PATH = "/sdcard/auto_pixai_ui_dump.xml";
// Dumps the on-screen accessibility tree and returns its raw XML.
async function dumpUiXml(log) {
	await adb(["-s", ADB_SERIAL, "shell", "uiautomator", "dump", UI_DUMP_PATH], log);
	return await adb(["-s", ADB_SERIAL, "shell", "cat", UI_DUMP_PATH], log);
}

// Finds the first node whose visible text matches, returning its centre
// coordinates. Note uiautomator emits single-quoted attributes.
function findNodeByText(xml, pattern) {
	const nodes = xml.match(/<node[^>]*\/>/g) || [];
	for (const node of nodes) {
		const textMatch = node.match(/text=['"]([^'"]*)['"]/);
		if (!textMatch) continue;
		const text = textMatch[1];
		if (!pattern.test(text)) continue;

		const boundsMatch = node.match(/bounds=['"]\[(\d+),(\d+)\]\[(\d+),(\d+)\]['"]/);
		if (!boundsMatch) continue;

		const x1 = Number(boundsMatch[1]);
		const y1 = Number(boundsMatch[2]);
		const x2 = Number(boundsMatch[3]);
		const y2 = Number(boundsMatch[4]);
		return { text, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
	}
	return null;
}

// Returns true if any on-screen text matches — used to detect the modal,
// Cloudflare's "Success!", and post-claim confirmation without any CDP.
async function screenHasText(log, pattern) {
	try {
		const xml = await dumpUiXml(log);
		return !!findNodeByText(xml, pattern);
	} catch (_) {
		return false;
	}
}

// Polls the accessibility tree until matching text appears, or the timeout
// elapses. Cancellable via signal.
async function waitForTextOnScreen(log, pattern, timeoutMs, signal) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (signal && signal.aborted) throw new Error("cancelled");
		try {
			const xml = await dumpUiXml(log);
			const node = findNodeByText(xml, pattern);
			if (node) return node;
		} catch (_) {}
		await new Promise((r) => setTimeout(r, 2000));
	}
	return null;
}

// Grabs a real device screenshot without needing CDP, so debug shots still
// work when running the ADB-only fallback path.
const SCREENCAP_PATH = "/sdcard/auto_pixai_screen.png";
async function screencap(log, localPath) {
	try {
		await adb(["-s", ADB_SERIAL, "shell", "screencap", "-p", SCREENCAP_PATH], log, 30000);
		await adb(["-s", ADB_SERIAL, "pull", SCREENCAP_PATH, localPath], log, 30000);
		return true;
	} catch (e) {
		if (log) log("ANDROID", `screencap failed: ${e.message}`);
		return false;
	}
}

async function tapByText(log, pattern) {
	try {
		const xml = await dumpUiXml(log);
		const node = findNodeByText(xml, pattern);
		if (!node) {
			log("ANDROID", "No accessibility node matched the target text.");
			return false;
		}
		log("ANDROID", `Accessibility tree match "${node.text}" at (${node.cx}, ${node.cy}) — tapping via input tap.`);
		await adb(["-s", ADB_SERIAL, "shell", "input", "tap", String(node.cx), String(node.cy)], log);
		return true;
	} catch (e) {
		log("ANDROID", `tapByText failed: ${e.message}`);
		return false;
	}
}

async function swipe(log, x, y1, y2, durationMs = 300) {
	await adb(["-s", ADB_SERIAL, "shell", "input", "swipe", String(x), String(y1), String(x), String(y2), String(durationMs)], log);
}

// Scrolls page content upward with a real touch swipe gesture, exactly as a
// user's finger would — used when CDP-level scrollIntoView() doesn't
// reliably reach a site's actual scroll behavior (e.g. custom/virtualized
// scroll containers, or modals that don't scroll the way scrollIntoView
// expects). Moderate swipe distance (40% of screen height) starting/ending
// well clear of the top browser chrome and any bottom nav bar.
async function swipeUp(log) {
	try {
		const size = await getScreenSize(log);
		if (!size) return false;
		const x = Math.round(size.w / 2);
		const y1 = Math.round(size.h * 0.75);
		const y2 = Math.round(size.h * 0.35);
		await swipe(log, x, y1, y2, 350);
		return true;
	} catch (e) {
		if (log) log("ANDROID", `swipeUp failed: ${e.message}`);
		return false;
	}
}

// Connects to real, unmodified Chrome running on an Android emulator/device
// over ADB port-forwarding + the Chrome DevTools Protocol — the same
// mechanism chrome://inspect uses for USB debugging. Because it's a genuine
// Chrome instance (no CDP-launch artifacts, no puppeteer-extra stealth
// patching needed), it doesn't carry the automation fingerprints that
// Cloudflare Turnstile specifically looks for in a desktop headless/Xvfb
// Puppeteer-launched browser.
// Prepares the device for a run: connects ADB, wakes and holds the screen
// awake, dismisses any lock-screen swipe prompt, and launches Chrome at
// pixai.art. Deliberately does NOT touch CDP/DevTools — claiming is driven
// entirely through ADB and the accessibility tree, which proved far more
// reliable on real hardware than Chrome's remote-debugging pipeline.
async function prepareDevice(log, signal) {
	const checkCancelled = () => {
		if (signal && signal.aborted) throw new Error("cancelled");
	};

	// Wireless ADB commonly fails the first connect after the device has
	// been idle (the daemon has to re-establish), then succeeds
	// immediately on a second attempt. Retry a few times before treating
	// it as a genuine failure. Safe to retry unlike a mid-handshake CDP
	// reconnect: this fails fast and cleanly rather than interrupting
	// something that was progressing.
	const CONNECT_ATTEMPTS = 3;
	let connectErr;
	for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
		checkCancelled();
		try {
			log("ANDROID", `Connecting to device at ${ADB_SERIAL} (attempt ${attempt} of ${CONNECT_ATTEMPTS})...`);
			await adb(["connect", ADB_SERIAL], log, ADB_TIMEOUT_MS, signal);
			await adb(["-s", ADB_SERIAL, "wait-for-device"], log, ADB_TIMEOUT_MS, signal);

			// "connect" can report success while the device still shows as
			// offline/unauthorized, so verify it's actually usable rather
			// than trusting the exit code.
			const state = await adb(["-s", ADB_SERIAL, "get-state"], log, ADB_TIMEOUT_MS, signal);
			if (state.trim() !== "device") throw new Error(`device state is "${state.trim()}", expected "device"`);

			log("ANDROID", "Device connected.");
			connectErr = null;
			break;
		} catch (e) {
			if (e.message === "cancelled" || e.name === "AbortError") throw e;
			connectErr = e;
			log("ANDROID", `Connect attempt ${attempt} failed: ${e.message}`);
			if (attempt < CONNECT_ATTEMPTS) {
				// Drop the stale connection so the next attempt starts clean.
				try {
					await adb(["disconnect", ADB_SERIAL], log, 8000);
				} catch (_) {}
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}
	if (connectErr) {
		throw new Error(`Could not connect to the device after ${CONNECT_ATTEMPTS} attempts: ${connectErr.message}`);
	}
	checkCancelled();

	// Hold the screen awake for the whole run — once it sleeps, Android
	// pauses the foreground app, which stalls page loading and makes the
	// accessibility tree go stale. Released again when the run finishes.
	log("ANDROID", "Waking the screen and holding it awake for this run...");
	await adb(["-s", ADB_SERIAL, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], log, ADB_TIMEOUT_MS, signal);
	await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "true"], log, ADB_TIMEOUT_MS, signal);

	try {
		await new Promise((r) => setTimeout(r, 500));
		checkCancelled();

		// Some devices (notably Samsung/Knox-managed ones) still show a
		// "swipe up to continue" prompt even with Screen lock set to None.
		try {
			const size = await getScreenSize(log);
			if (size) {
				const x = Math.round(size.w / 2);
				await swipe(log, x, Math.round(size.h * 0.8), Math.round(size.h * 0.2), 300);
				await new Promise((r) => setTimeout(r, 500));
			}
		} catch (e) {
			log("ANDROID", `Swipe-dismiss failed (may not have been needed): ${e.message}`);
		}

		checkCancelled();
		log("ANDROID", "Launching Chrome at pixai.art...");
		try {
			await adb(
				["-s", ADB_SERIAL, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "https://pixai.art", "-p", CHROME_PACKAGE],
				log
			);
		} catch (e) {
			log("ANDROID", `am start failed, Chrome may already be running: ${e.message}`);
		}

		await new Promise((r) => setTimeout(r, 3000));
		checkCancelled();
	} catch (e) {
		// Don't leave stay-awake stuck on if prep failed partway.
		try {
			await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "false"]);
		} catch (_) {}
		throw e;
	}
}

// Best-effort CDP connection used ONLY to read back fresh session cookies
// after a claim — never on the critical path. Everything here is allowed to
// fail without affecting the run's outcome.
async function connectCdpForCookies(log) {
	const withLimit = (promise, ms, label) => {
		let timer;
		return Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${formatDuration(ms)}`)), ms);
			}),
		]).finally(() => clearTimeout(timer));
	};

	log("ANDROID", "Forwarding Chrome DevTools port for cookie refresh...");
	await adb(["-s", ADB_SERIAL, "forward", `tcp:${DEVTOOLS_LOCAL_PORT}`, "localabstract:chrome_devtools_remote"], log);

	const res = await fetch(`http://127.0.0.1:${DEVTOOLS_LOCAL_PORT}/json/version`, {
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`Chrome DevTools endpoint returned ${res.status}`);
	const info = await res.json();
	if (!info.webSocketDebuggerUrl) throw new Error("No webSocketDebuggerUrl in Chrome DevTools response");

	const browser = await withLimit(
		puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl, defaultViewport: null }),
		60000,
		"puppeteer.connect"
	);
	const pages = await withLimit(browser.pages(), 30000, "browser.pages");
	const page = pages.find((p) => p.url().includes("pixai.art")) || pages[0];
	if (!page) throw new Error("No pixai.art page found for cookie refresh");

	return { browser, page };
}

// Detaches from the remote-debugging session WITHOUT closing Chrome on the
// device — browser.close() would kill the actual app, which we don't want
// since the same Chrome instance is reused across runs.
async function detachCdp(browser, log) {
	try {
		if (browser) browser.disconnect();
	} catch (e) {
		if (log) log("ANDROID", `Disconnect warning: ${e.message}`);
	}
	try {
		await adb(["-s", ADB_SERIAL, "forward", "--remove", `tcp:${DEVTOOLS_LOCAL_PORT}`]);
	} catch (_) {}
}

// Independent of any browser/puppeteer state — safe to call when a run has
// timed out and the normal cleanup path (attemptRun's finally block, reached
// via the stuck attempt's own control flow) can't be trusted to ever run.
// Short per-call timeouts since adb itself may be part of what's hung; this
// is a best-effort safety net, not something worth waiting a long time for.
async function forceSleepScreen(log) {
	try {
		await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "false"], log, 8000);
	} catch (_) {}
	try {
		// KEYCODE_POWER toggles, and unlike the normal disconnect path we
		// can't assume the screen is currently on here — check first so we
		// don't accidentally wake it instead of sleeping it.
		const state = await adb(["-s", ADB_SERIAL, "shell", "dumpsys", "power"], log, 8000);
		const isOn = /mScreenOn=true|mWakefulness=Awake/.test(state);
		if (isOn) {
			await adb(["-s", ADB_SERIAL, "shell", "input", "keyevent", "KEYCODE_POWER"], log, 8000);
		}
	} catch (_) {}
}

module.exports = {
	prepareDevice,
	connectCdpForCookies,
	detachCdp,
	forceSleepScreen,
	swipeUp,
	tapByText,
	dumpUiXml,
	findNodeByText,
	screenHasText,
	waitForTextOnScreen,
	screencap,
};
