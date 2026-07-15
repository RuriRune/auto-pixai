// Uses Node 20's built-in fetch — no extra HTTP dependency needed.
async function sendPushover({ title, message, priority = 0 }) {
	const token = process.env.PUSHOVER_APP_TOKEN;
	const user = process.env.PUSHOVER_USER_KEY;

	if (!token || !user) {
		return { skipped: true, reason: "PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY not set" };
	}

	try {
		const res = await fetch("https://api.pushover.net/1/messages.json", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token,
				user,
				title,
				message,
				priority: String(priority),
			}),
		});
		const data = await res.json();
		if (data.status !== 1) {
			console.error("[PUSHOVER] Send failed:", JSON.stringify(data));
		}
		return data;
	} catch (e) {
		console.error("[PUSHOVER] Request error:", e.message);
		return { error: e.message };
	}
}

module.exports = { sendPushover };
