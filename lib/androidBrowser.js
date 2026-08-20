const { execFile } = require("child_process");
const { promisify } = require("util");
const puppeteer = require("puppeteer-core");

const execFileP = promisify(execFile);

const ADB_HOST = process.env.ANDROID_ADB_HOST || "android";
const ADB_PORT = process.env.ANDROID_ADB_PORT || "5555";
const ADB_SERIAL = `${ADB_HOST}:${ADB_PORT}`;
const DEVTOOLS_LOCAL_PORT = process.env.ANDROID_DEVTOOLS_PORT || "9222";
const CHROME_PACKAGE = "com.android.chrome";

const ADB_TIMEOUT_MS = 15000;

async function adb(args, log, timeout = ADB_TIMEOUT_MS) {
	try {
		const { stdout, stderr } = await execFileP("adb", args, { timeout });
		if (log && stderr && stderr.trim()) log("ADB", stderr.trim());
		return stdout.trim();
	} catch (e) {
		if (e.killed || e.signal === "SIGTERM") {
			throw new Error(`adb ${args.join(" ")} timed out after ${timeout}ms — is the android container up and reachable?`);
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
async function connectAndroidChrome(log) {
	log("ANDROID", `Connecting to device at ${ADB_SERIAL}...`);
	await adb(["connect", ADB_SERIAL], log);
	await adb(["-s", ADB_SERIAL, "wait-for-device"], log);

	// A single wake pulse isn't enough — a full run (cookie apply, Turnstile
	// wait, claim click, confirmation) easily takes 20-40+ seconds, and the
	// device's normal short screen timeout can kick back in mid-run. Once
	// the screen sleeps, Android typically pauses the foreground app,
	// which can throttle JS timers and flip document.visibilityState to
	// hidden — exactly the kind of signal Turnstile watches for, on top of
	// just making CDP interaction unreliable generally. Force stay-awake
	// for the duration of the run; disconnectAndroidChrome() releases it
	// afterward so the phone still sleeps normally the rest of the time.
	log("ANDROID", "Waking the screen and holding it awake for this run...");
	await adb(["-s", ADB_SERIAL, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], log);
	await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "true"], log);

	// Everything from here on can fail in ways that would otherwise leave
	// stay-awake stuck on indefinitely (disconnectAndroidChrome() never
	// gets called if this function throws before returning). Revert it
	// here on any failure, then rethrow.
	try {
		await new Promise((r) => setTimeout(r, 500));

		// Some devices (notably Samsung/Knox-managed ones) still show a
		// "swipe up to continue" prompt even with Screen lock set to None —
		// it's a system-level overlay outside the browser, so no CDP
		// command can dismiss it. Query the actual screen size rather than
		// hardcoding one device's resolution, then swipe bottom → top.
		// Harmless/no-op if there's nothing to dismiss.
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

		log("ANDROID", "Launching Chrome on the device...");
		try {
			await adb(
				["-s", ADB_SERIAL, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "https://pixai.art", "-p", CHROME_PACKAGE],
				log
			);
		} catch (e) {
			log("ANDROID", `am start failed, Chrome may already be running: ${e.message}`);
		}

		// Give Chrome a moment to actually start before forwarding the port.
		await new Promise((r) => setTimeout(r, 3000));

		log("ANDROID", "Forwarding Chrome DevTools port...");
		await adb(["-s", ADB_SERIAL, "forward", `tcp:${DEVTOOLS_LOCAL_PORT}`, "localabstract:chrome_devtools_remote"], log);

		const res = await fetch(`http://127.0.0.1:${DEVTOOLS_LOCAL_PORT}/json/version`, {
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) throw new Error(`Chrome DevTools endpoint returned ${res.status}`);
		const info = await res.json();
		if (!info.webSocketDebuggerUrl) throw new Error("No webSocketDebuggerUrl in Chrome DevTools response");

		const browser = await puppeteer.connect({
			browserWSEndpoint: info.webSocketDebuggerUrl,
			defaultViewport: null,
		});

		const pages = await browser.pages();
		const page = pages.find((p) => p.url().includes("pixai.art")) || pages[0] || (await browser.newPage());

		return { browser, page };
	} catch (e) {
		log("ANDROID", `Connect failed after stay-awake was set — reverting it: ${e.message}`);
		try {
			await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "false"]);
		} catch (_) {}
		throw e;
	}
}

// Detaches from the remote-debugging session WITHOUT closing Chrome on the
// device — browser.close() would kill the actual app, which we don't want
// since the same Chrome instance is reused across runs.
async function disconnectAndroidChrome(browser, log) {
	try {
		browser.disconnect();
	} catch (e) {
		if (log) log("ANDROID", `Disconnect warning: ${e.message}`);
	}
	try {
		await adb(["-s", ADB_SERIAL, "forward", "--remove", `tcp:${DEVTOOLS_LOCAL_PORT}`]);
	} catch (_) {}
	try {
		// Release the stay-awake override first...
		await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "false"], log);
		// ...then force the screen off immediately rather than leaving it lit
		// for however long the normal timeout is set to. KEYCODE_POWER
		// toggles, but that's safe here specifically because the screen is
		// known to be on at this point (it was just actively in use).
		await adb(["-s", ADB_SERIAL, "shell", "input", "keyevent", "KEYCODE_POWER"], log);
	} catch (_) {}
}

// Independent of any browser/puppeteer state — safe to call when a run has
// timed out and the normal cleanup path (disconnectAndroidChrome, reached
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

module.exports = { connectAndroidChrome, disconnectAndroidChrome, forceSleepScreen, swipeUp };
