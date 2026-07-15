const fs = require("fs");
const path = require("path");
const { DATA_PATH } = require("./cookies");

const STATUS_FILE = path.join(DATA_PATH, "status.json");
const MAX_HISTORY = 30;

function readStatus() {
	try {
		if (fs.existsSync(STATUS_FILE)) {
			return JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
		}
	} catch (_) {}
	return { lastRun: null, history: [] };
}

function recordRun(entry) {
	const current = readStatus();
	const history = [entry, ...current.history].slice(0, MAX_HISTORY);
	const next = { lastRun: entry, history };
	fs.mkdirSync(DATA_PATH, { recursive: true });
	fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2));
	return next;
}

module.exports = { readStatus, recordRun, STATUS_FILE };
