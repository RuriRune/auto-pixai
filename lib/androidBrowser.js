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
		await new Promise((r) => setTimeout(r, 1000));

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
		// Let the screen return to its normal short timeout now that the run is over.
		await adb(["-s", ADB_SERIAL, "shell", "svc", "power", "stayon", "false"], log);
	} catch (_) {}
}

module.exports = { connectAndroidChrome, disconnectAndroidChrome };
