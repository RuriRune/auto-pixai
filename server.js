require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const { runClaim } = require("./claimer");
const { readStatus } = require("./lib/status");
const { loadScheduleExpr, saveScheduleExpr } = require("./lib/schedule");
const {
	DATA_PATH,
	cookieFileExists,
	loadCookies,
	hasAuthCookieInList,
	authCookieExpiry,
} = require("./lib/cookies");

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());

let isRunning = false;
let currentTask = null;

function scheduleJob(expr) {
	if (currentTask) currentTask.stop();
	if (!cron.validate(expr)) throw new Error(`Invalid cron expression: ${expr}`);
	const opts = process.env.TZ ? { timezone: process.env.TZ } : undefined;
	currentTask = cron.schedule(expr, () => triggerRun("scheduled"), opts);
	console.log(`[SCHEDULE] Active: ${expr}${process.env.TZ ? ` (${process.env.TZ})` : ""}`);
}

async function triggerRun(trigger) {
	if (isRunning) {
		console.log("[SERVER] Run already in progress, skipping.");
		return { skipped: true };
	}
	isRunning = true;
	try {
		return await runClaim(trigger);
	} finally {
		isRunning = false;
	}
}

// ── API ──────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
	res.json({ ...readStatus(), isRunning });
});

app.get("/api/cookies", (req, res) => {
	const exists = cookieFileExists();
	let hasAuth = false;
	let expiry = null;
	if (exists) {
		try {
			const cookies = loadCookies();
			hasAuth = hasAuthCookieInList(cookies);
			expiry = authCookieExpiry(cookies);
		} catch (_) {}
	}
	res.json({ exists, hasAuth, expiry });
});

app.get("/api/schedule", (req, res) => {
	res.json({ cron: loadScheduleExpr() });
});

app.post("/api/schedule", (req, res) => {
	const expr = (req.body || {}).cron;
	if (!expr) return res.status(400).json({ error: "Missing cron expression" });
	try {
		scheduleJob(expr);
		saveScheduleExpr(expr);
		res.json({ ok: true, cron: expr });
	} catch (e) {
		res.status(400).json({ error: e.message });
	}
});

app.post("/api/run", async (req, res) => {
	if (isRunning) return res.status(409).json({ error: "A run is already in progress" });
	const result = await triggerRun("manual");
	res.json(result);
});

app.get("/api/screenshots", (req, res) => {
	try {
		fs.mkdirSync(DATA_PATH, { recursive: true });
		const files = fs
			.readdirSync(DATA_PATH)
			.filter((f) => f.toLowerCase().endsWith(".png"))
			.map((f) => {
				const stat = fs.statSync(path.join(DATA_PATH, f));
				return { name: f, mtime: stat.mtime };
			})
			.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
		res.json(files);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// Explicit route (not static-serving all of DATA_PATH — that folder also
// holds cookies.json, which must never be reachable over HTTP).
app.get("/screenshots/:name", (req, res) => {
	const name = path.basename(req.params.name);
	if (!/\.png$/i.test(name)) return res.status(400).end();
	const filePath = path.join(DATA_PATH, name);
	if (!fs.existsSync(filePath)) return res.status(404).end();
	res.sendFile(filePath);
});

app.use(express.static(path.join(__dirname, "public")));

scheduleJob(loadScheduleExpr());

app.listen(PORT, () => {
	console.log(`[SERVER] Listening on port ${PORT}`);
	console.log(`[SERVER] No built-in authentication — put this behind your own network/reverse proxy access control.`);
});
