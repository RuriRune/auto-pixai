const fs = require("fs");
const path = require("path");
const { DATA_PATH } = require("./cookies");

const SCHEDULE_FILE = path.join(DATA_PATH, "schedule.json");
const DEFAULT_CRON = process.env.DEFAULT_CRON || "0 9 * * *";

function loadScheduleExpr() {
	try {
		if (fs.existsSync(SCHEDULE_FILE)) {
			return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8")).cron;
		}
	} catch (_) {}
	return DEFAULT_CRON;
}

function saveScheduleExpr(expr) {
	fs.mkdirSync(DATA_PATH, { recursive: true });
	fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ cron: expr }, null, 2));
}

module.exports = { loadScheduleExpr, saveScheduleExpr, DEFAULT_CRON };
