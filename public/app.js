const statusBadge = document.getElementById("statusBadge");
const statusTime = document.getElementById("statusTime");
const statusMessage = document.getElementById("statusMessage");
const cookieBadge = document.getElementById("cookieBadge");
const cookieDetail = document.getElementById("cookieDetail");
const cronInput = document.getElementById("cronInput");
const scheduleSaved = document.getElementById("scheduleSaved");
const runBtn = document.getElementById("runBtn");
const cancelBtn = document.getElementById("cancelBtn");
const liveProgressCard = document.getElementById("liveProgressCard");
const liveTimer = document.getElementById("liveTimer");
const liveStep = document.getElementById("liveStep");
const retryNotice = document.getElementById("retryNotice");
const historyBody = document.querySelector("#historyTable tbody");
const gallery = document.getElementById("gallery");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightboxImg");

let runStartedAt = null;

function formatElapsed(ms) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(totalSeconds / 60);
	const s = totalSeconds % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

// Ticks every second independent of the API poll interval, so the timer
// feels smooth rather than jumping in 2s increments.
setInterval(() => {
	if (runStartedAt) liveTimer.textContent = formatElapsed(Date.now() - runStartedAt);
}, 1000);

function badgeClass(status) {
	if (status === "SUCCESS" || status === "ALREADY_CLAIMED") return "ok";
	if (status === "COOKIES_MISSING" || status === "COOKIES_INVALID" || status === "COOKIES_EXPIRED") return "bad";
	if (status === "DEVICE_UNREACHABLE") return "bad";
	if (status === "CANCELLED") return "neutral";
	if (!status) return "neutral";
	return "warn";
}

async function refreshStatus() {
	const res = await fetch("/api/status");
	const data = await res.json();
	const last = data.lastRun;

	if (last) {
		statusBadge.textContent = last.status;
		statusBadge.className = "status-badge " + badgeClass(last.status);
		statusTime.textContent = new Date(last.timestamp).toLocaleString();
		statusMessage.textContent = last.message || "";
	} else {
		statusBadge.textContent = "No runs yet";
		statusBadge.className = "status-badge neutral";
		statusTime.textContent = "—";
		statusMessage.textContent = "";
	}

	if (data.retryAt && !data.isRunning) {
		const mins = Math.max(1, Math.round((data.retryAt - Date.now()) / 60000));
		retryNotice.textContent = `Device unreachable — retrying automatically in ~${mins} min (attempt ${data.retryCount} of ${data.maxRetries}).`;
		retryNotice.style.display = "";
	} else {
		retryNotice.style.display = "none";
	}

	runBtn.disabled = data.isRunning;
	runBtn.textContent = data.isRunning ? "Running…" : "Run now";
	cancelBtn.style.display = data.isRunning || data.retryAt ? "" : "none";
	cancelBtn.textContent = data.isRunning ? "Cancel run" : "Cancel retry";

	if (data.isRunning) {
		liveProgressCard.style.display = "";
		runStartedAt = data.runStartedAt || runStartedAt;
		liveStep.textContent = data.currentStep || "Starting…";
		if (runStartedAt) liveTimer.textContent = formatElapsed(Date.now() - runStartedAt);
	} else {
		liveProgressCard.style.display = "none";
		runStartedAt = null;
	}

	historyBody.innerHTML = "";
	(data.history || []).forEach((h) => {
		const tr = document.createElement("tr");
		const time = document.createElement("td");
		time.textContent = new Date(h.timestamp).toLocaleString();
		const trigger = document.createElement("td");
		trigger.textContent = h.trigger;
		const status = document.createElement("td");
		const badge = document.createElement("span");
		badge.className = "status-badge " + badgeClass(h.status);
		badge.textContent = h.status;
		status.appendChild(badge);
		const message = document.createElement("td");
		message.textContent = h.message || "";
		tr.append(time, trigger, status, message);
		historyBody.appendChild(tr);
	});
}

async function refreshCookies() {
	const res = await fetch("/api/cookies");
	const data = await res.json();
	if (!data.exists) {
		cookieBadge.textContent = "Missing";
		cookieBadge.className = "status-badge bad";
		cookieDetail.textContent = "No cookies.json found. Export a session and place it in the data folder.";
	} else if (!data.hasAuth) {
		cookieBadge.textContent = "Invalid";
		cookieBadge.className = "status-badge bad";
		cookieDetail.textContent = "cookies.json exists but has no auth cookie. Re-export a fresh session.";
	} else if (!data.isFresh) {
		cookieBadge.textContent = "Expired";
		cookieBadge.className = "status-badge bad";
		cookieDetail.textContent = data.expiry
			? `Expired ${new Date(data.expiry).toLocaleString()} — re-export a fresh session.`
			: "Expired — re-export a fresh session.";
	} else {
		cookieBadge.textContent = "Valid";
		cookieBadge.className = "status-badge ok";
		cookieDetail.textContent = data.expiry ? `Expires ${new Date(data.expiry).toLocaleString()}` : "";
	}
}

async function refreshSchedule() {
	const res = await fetch("/api/schedule");
	const data = await res.json();
	if (document.activeElement !== cronInput) cronInput.value = data.cron;
}

async function refreshGallery() {
	const res = await fetch("/api/screenshots");
	const files = await res.json();
	gallery.innerHTML = "";
	files.forEach((f) => {
		const img = document.createElement("img");
		img.src = `/screenshots/${encodeURIComponent(f.name)}`;
		img.title = f.name;
		img.addEventListener("click", () => {
			lightboxImg.src = img.src;
			lightbox.classList.add("open");
		});
		gallery.appendChild(img);
	});
}

lightbox.addEventListener("click", () => lightbox.classList.remove("open"));

runBtn.addEventListener("click", async () => {
	runBtn.disabled = true;
	runBtn.textContent = "Running…";
	try {
		await fetch("/api/run", { method: "POST" });
	} finally {
		await refreshAll();
	}
});

cancelBtn.addEventListener("click", async () => {
	cancelBtn.disabled = true;
	cancelBtn.textContent = "Cancelling…";
	try {
		await fetch("/api/cancel", { method: "POST" });
	} finally {
		cancelBtn.disabled = false;
		cancelBtn.textContent = "Cancel run";
		await refreshAll();
	}
});

document.getElementById("saveScheduleBtn").addEventListener("click", async () => {
	const res = await fetch("/api/schedule", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cron: cronInput.value.trim() }),
	});
	const data = await res.json();
	scheduleSaved.textContent = res.ok ? "Saved." : `Error: ${data.error}`;
	setTimeout(() => (scheduleSaved.textContent = ""), 4000);
});

const pushoverUserKeyInput = document.getElementById("pushoverUserKey");
const pushoverAppTokenInput = document.getElementById("pushoverAppToken");
const notifyOnSuccessInput = document.getElementById("notifyOnSuccess");
const notifyOnStartInput = document.getElementById("notifyOnStart");
const debugScreenshotsInput = document.getElementById("debugScreenshots");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const testPushoverBtn = document.getElementById("testPushoverBtn");
const settingsSaved = document.getElementById("settingsSaved");

async function refreshSettings() {
	const res = await fetch("/api/settings");
	const data = await res.json();
	if (document.activeElement !== pushoverUserKeyInput) pushoverUserKeyInput.value = data.pushoverUserKey || "";
	if (document.activeElement !== pushoverAppTokenInput) pushoverAppTokenInput.value = data.pushoverAppToken || "";
	notifyOnSuccessInput.checked = !!data.notifyOnSuccess;
	notifyOnStartInput.checked = !!data.notifyOnStart;
	debugScreenshotsInput.checked = !!data.debugScreenshots;
}

saveSettingsBtn.addEventListener("click", async () => {
	const res = await fetch("/api/settings", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			pushoverUserKey: pushoverUserKeyInput.value.trim(),
			pushoverAppToken: pushoverAppTokenInput.value.trim(),
			notifyOnSuccess: notifyOnSuccessInput.checked,
			notifyOnStart: notifyOnStartInput.checked,
			debugScreenshots: debugScreenshotsInput.checked,
		}),
	});
	const data = await res.json();
	settingsSaved.textContent = res.ok ? "Settings saved." : `Error: ${data.error}`;
	setTimeout(() => (settingsSaved.textContent = ""), 4000);
});

testPushoverBtn.addEventListener("click", async () => {
	testPushoverBtn.disabled = true;
	testPushoverBtn.textContent = "Sending…";
	try {
		const res = await fetch("/api/settings/test-pushover", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				pushoverUserKey: pushoverUserKeyInput.value.trim(),
				pushoverAppToken: pushoverAppTokenInput.value.trim(),
			}),
		});
		const data = await res.json();
		settingsSaved.textContent = res.ok ? "Test notification sent — check your device." : `Error: ${data.error}`;
	} catch (e) {
		settingsSaved.textContent = `Error: ${e.message}`;
	} finally {
		testPushoverBtn.disabled = false;
		testPushoverBtn.textContent = "Send test notification";
		setTimeout(() => (settingsSaved.textContent = ""), 6000);
	}
});

async function refreshAll() {
	await Promise.all([refreshStatus(), refreshCookies(), refreshSchedule(), refreshGallery(), refreshSettings()]);
}

refreshAll();
setInterval(refreshAll, 2000);
