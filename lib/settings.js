const fs = require("fs");
const path = require("path");
const { DATA_PATH } = require("./cookies");

const SETTINGS_FILE = path.join(DATA_PATH, "settings.json");

const DEFAULTS = {
	pushoverUserKey: process.env.PUSHOVER_USER_KEY || "",
	pushoverAppToken: process.env.PUSHOVER_APP_TOKEN || "",
	notifyOnSuccess: process.env.NOTIFY_ON_SUCCESS === "true",
	debugScreenshots: process.env.DEBUG_SCREENSHOTS !== "false",
	// "auto" tries headless first, falls back to visible on error/Turnstile block.
	// "headless" / "visible" force one mode only.
	headlessMode:
		process.env.FORCE_HEADLESS === "true" ? "headless" : process.env.FORCE_HEADLESS === "false" ? "visible" : "auto",
};

function loadSettings() {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) };
		}
	} catch (_) {}
	return { ...DEFAULTS };
}

function saveSettings(partial) {
	const current = loadSettings();
	const next = { ...current, ...partial };
	fs.mkdirSync(DATA_PATH, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
	return next;
}

module.exports = { loadSettings, saveSettings, SETTINGS_FILE };
