const fs = require("fs");
const path = require("path");
const { DATA_PATH } = require("./cookies");

const SETTINGS_FILE = path.join(DATA_PATH, "settings.json");

const DEFAULTS = {
	pushoverUserKey: process.env.PUSHOVER_USER_KEY || "",
	pushoverAppToken: process.env.PUSHOVER_APP_TOKEN || "",
	notifyOnSuccess: process.env.NOTIFY_ON_SUCCESS === "true",
	debugScreenshots: process.env.DEBUG_SCREENSHOTS !== "false",
};

// Strips empty/undefined values so a blank field in settings.json doesn't
// clobber a value supplied via environment variable. Without this, saving
// settings while the Pushover inputs happened to be empty would silently
// wipe out env-provided credentials — notifications would then quietly stop
// while the "Send test notification" button (which reads the form fields
// directly) still appeared to work.
function stripEmpty(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (typeof v === "string" && v.trim() === "") continue;
		out[k] = v;
	}
	return out;
}

function loadSettings() {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
			return { ...DEFAULTS, ...stripEmpty(stored) };
		}
	} catch (_) {}
	return { ...DEFAULTS };
}

function saveSettings(partial) {
	const current = loadSettings();
	const next = { ...current, ...stripEmpty(partial) };
	fs.mkdirSync(DATA_PATH, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
	return next;
}

// True when Pushover is actually configured — used to log clearly rather
// than failing silently.
function pushoverConfigured(settings) {
	return !!(settings.pushoverUserKey && settings.pushoverAppToken);
}

module.exports = { loadSettings, saveSettings, pushoverConfigured, SETTINGS_FILE };
