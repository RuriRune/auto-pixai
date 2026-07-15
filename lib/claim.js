function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, pattern, { timeout = 8000 } = {}) {
	try {
		await page.waitForFunction(
			(pat) =>
				!!Array.from(document.querySelectorAll("button, [role='button'], a")).find((el) =>
					new RegExp(pat, "i").test((el.innerText || el.textContent || "").trim())
				),
			{ timeout },
			pattern.source
		);
	} catch (_) {
		return false;
	}
	return await page.evaluate((pat) => {
		const el = Array.from(document.querySelectorAll("button, [role='button'], a")).find((el) =>
			new RegExp(pat, "i").test((el.innerText || el.textContent || "").trim())
		);
		if (!el) return false;
		el.click();
		return true;
	}, pattern.source);
}

async function isClaimButtonEnabled(page) {
	return await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(
			(b) => /claim/i.test((b.innerText || "").trim()) && !/claimed/i.test((b.innerText || "").trim())
		);
		return !!(btn && !btn.disabled);
	});
}

function findTurnstileFrame(page) {
	return page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));
}

// Turnstile here is the checkbox-style widget: it usually self-solves based
// on browser fingerprint, but occasionally needs the checkbox clicked once.
// No third-party solving service required.
async function resolveTurnstileIfPresent(page, log, timeoutMs = 15000) {
	if (!findTurnstileFrame(page)) return true; // nothing to solve

	log("TURNSTILE", "Challenge iframe detected — waiting to see if it self-solves...");
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isClaimButtonEnabled(page)) {
			log("TURNSTILE", "Claim button enabled — self-solved.");
			return true;
		}
		await delay(500);
	}

	const frame = findTurnstileFrame(page);
	if (frame) {
		log("TURNSTILE", "Did not self-solve in time — clicking the checkbox once.");
		try {
			const checkbox = await frame.waitForSelector('input[type="checkbox"], [role="checkbox"], .cb-c', {
				timeout: 4000,
			});
			await checkbox.click();
		} catch (e) {
			log("TURNSTILE", `Could not locate/click checkbox: ${e.message}`);
		}
	}

	const secondStart = Date.now();
	while (Date.now() - secondStart < 15000) {
		if (await isClaimButtonEnabled(page)) {
			log("TURNSTILE", "Claim button enabled after checkbox click.");
			return true;
		}
		await delay(500);
	}

	log("TURNSTILE", "Claim button never enabled — giving up on this attempt.");
	return false;
}

async function isAlreadyClaimed(page) {
	return await page.evaluate(() => {
		const text = document.body ? document.body.innerText : "";
		return (
			/already claimed|next reward available|credits claimed/i.test(text) ||
			/已認領|已认领|申請済み/.test(text)
		);
	});
}

async function claim(page, log, shot) {
	// Dismiss any startup/onboarding dialog.
	try {
		const dismissed = await clickByText(page, /^(close|cancel|later|no thanks|skip|maybe later)$/i, {
			timeout: 3000,
		});
		if (dismissed) await delay(500);
	} catch (_) {}

	await shot("1_before_claim");

	if (await isAlreadyClaimed(page)) {
		log("CLAIM", "Already claimed today — nothing to do.");
		return { status: "ALREADY_CLAIMED" };
	}

	const solved = await resolveTurnstileIfPresent(page, log);
	if (!solved) {
		await shot("2_turnstile_unresolved");
		return { status: "TURNSTILE_BLOCKED", message: "Turnstile challenge never cleared." };
	}

	try {
		await page.waitForFunction(
			() => {
				const btn = Array.from(document.querySelectorAll("button")).find(
					(b) => /claim/i.test((b.innerText || "").trim()) && !/claimed/i.test((b.innerText || "").trim())
				);
				return !!(btn && !btn.disabled);
			},
			{ timeout: 10000 }
		);
	} catch (_) {
		// fall through — still attempt the click and report what happened
	}

	const clicked = await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(
			(b) => /claim/i.test((b.innerText || "").trim()) && !/claimed/i.test((b.innerText || "").trim())
		);
		if (btn && !btn.disabled) {
			btn.click();
			return true;
		}
		return false;
	});

	await delay(1500);
	await shot("2_after_claim");

	if (!clicked) return { status: "CLAIM_BUTTON_NOT_FOUND", message: "No enabled Claim button found." };

	if (await isAlreadyClaimed(page)) return { status: "SUCCESS" };
	await delay(1500);
	if (await isAlreadyClaimed(page)) return { status: "SUCCESS" };

	return { status: "CLICKED_UNCONFIRMED", message: "Clicked Claim but couldn't confirm success afterward." };
}

module.exports = { claim, isAlreadyClaimed, resolveTurnstileIfPresent };
