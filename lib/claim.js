function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Anchored to the start of the text so it matches "Claim 12,000 daily
// credits" but not a "Daily Claim" heading or an "Already Claimed" label —
// a plain /claim/i substring match would hit all three.
const CLAIM_BUTTON_PATTERN = /^claim\b/i;

// Returns a real Puppeteer ElementHandle for the first matching element, or
// null. Using an actual ElementHandle (rather than calling the DOM's raw
// .click() inside page.evaluate) matters: ElementHandle.click() scrolls the
// element into view and dispatches a real mouse click at its on-screen
// coordinates, whereas a raw .click() call fires the event handler directly
// regardless of scroll position — which can silently no-op on pages whose
// button logic depends on the element actually being visible/in-viewport.
async function findElementHandleByText(page, selector, pattern) {
	const handle = await page.evaluateHandle(
		(sel, pat) => {
			const re = new RegExp(pat, "i");
			return Array.from(document.querySelectorAll(sel)).find((el) => re.test((el.innerText || el.textContent || "").trim()));
		},
		selector,
		pattern.source
	);
	const element = handle.asElement();
	if (!element) {
		await handle.dispose();
		return null;
	}
	return element;
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

	const element = await findElementHandleByText(page, "button, [role='button'], a", pattern);
	if (!element) return false;
	try {
		await element.click();
		return true;
	} catch (_) {
		return false;
	} finally {
		await element.dispose();
	}
}

async function isClaimButtonEnabled(page) {
	return await page.evaluate((pat) => {
		const re = new RegExp(pat, "i");
		const btn = Array.from(document.querySelectorAll("button")).find((b) => re.test((b.innerText || "").trim()));
		return !!(btn && !btn.disabled);
	}, CLAIM_BUTTON_PATTERN.source);
}

function findTurnstileFrame(page) {
	return page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));
}

// Locates the outer <iframe> element (in the main page/parent frame) that
// hosts the Turnstile widget, so we can click by real screen coordinates.
// This is more reliable than selecting inside the iframe's own DOM, since
// Cloudflare sometimes renders the checkbox as a non-standard element
// (canvas/shadow DOM) that CSS selectors can't reach, or nests it in a way
// that makes in-frame selection flaky.
async function findTurnstileIframeHandle(page) {
	const handles = await page.$$("iframe");
	for (const h of handles) {
		const src = await (await h.getProperty("src")).jsonValue().catch(() => "");
		if (src && src.includes("challenges.cloudflare.com")) return h;
	}
	return null;
}

async function tryClickInnerCheckbox(frame) {
	try {
		const checkbox = await frame.waitForSelector(
			'input[type="checkbox"], [role="checkbox"], .cb-c, label, input',
			{ timeout: 3000 }
		);
		await checkbox.click();
		return true;
	} catch (_) {
		return false;
	}
}

async function tryClickByCoordinates(page, iframeHandle) {
	try {
		const box = await iframeHandle.boundingBox();
		if (!box) return false;
		// The checkbox sits near the left edge of the widget, vertically centered.
		const x = box.x + Math.min(30, box.width * 0.12);
		const y = box.y + box.height / 2;
		await page.mouse.click(x, y);
		return true;
	} catch (_) {
		return false;
	}
}

// Turnstile here is the checkbox-style widget: it usually self-solves based
// on browser fingerprint, but occasionally needs the checkbox clicked once.
// No third-party solving service required.
async function resolveTurnstileIfPresent(page, log, timeoutMs = 12000) {
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

	// Try up to 3 rounds: inner-DOM click, then coordinate click on the
	// outer iframe, each followed by a wait to see if it registered.
	for (let attempt = 1; attempt <= 3; attempt++) {
		const frame = findTurnstileFrame(page);
		const iframeHandle = await findTurnstileIframeHandle(page);

		let clicked = false;
		if (frame) clicked = await tryClickInnerCheckbox(frame);
		if (!clicked && iframeHandle) {
			log("TURNSTILE", `Attempt ${attempt}: inner selector click failed — trying coordinate click.`);
			clicked = await tryClickByCoordinates(page, iframeHandle);
		}
		if (!clicked) {
			log("TURNSTILE", `Attempt ${attempt}: could not click checkbox by any method.`);
		}

		const waitStart = Date.now();
		while (Date.now() - waitStart < 6000) {
			if (await isClaimButtonEnabled(page)) {
				log("TURNSTILE", `Claim button enabled after attempt ${attempt}.`);
				return true;
			}
			await delay(500);
		}
	}

	log("TURNSTILE", "Claim button never enabled after retries — giving up on this attempt.");
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
			(pat) => {
				const re = new RegExp(pat, "i");
				const btn = Array.from(document.querySelectorAll("button")).find((b) => re.test((b.innerText || "").trim()));
				return !!(btn && !btn.disabled);
			},
			{ timeout: 10000 },
			CLAIM_BUTTON_PATTERN.source
		);
	} catch (_) {
		// fall through — still attempt the click and report what happened
	}

	const claimHandle = await findElementHandleByText(page, "button", CLAIM_BUTTON_PATTERN);
	let clicked = false;
	if (claimHandle) {
		try {
			// Explicit scroll rather than relying on ElementHandle.click()'s
			// built-in auto-scroll, which can be unreliable for elements
			// inside a modal's own overflow:auto container (as opposed to
			// the main page) rather than the document body.
			await page.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }), claimHandle);
			await delay(400);
			await shot("1b_after_scroll");

			const isEnabled = await page.evaluate((el) => !el.disabled, claimHandle);
			if (isEnabled) {
				await claimHandle.click();
				clicked = true;
			}
		} catch (_) {
		} finally {
			await claimHandle.dispose();
		}
	}

	await delay(1500);
	await shot("2_after_claim");

	if (!clicked) return { status: "CLAIM_BUTTON_NOT_FOUND", message: "No enabled Claim button found." };

	if (await isAlreadyClaimed(page)) return { status: "SUCCESS" };
	await delay(1500);
	if (await isAlreadyClaimed(page)) return { status: "SUCCESS" };

	return { status: "CLICKED_UNCONFIRMED", message: "Clicked Claim but couldn't confirm success afterward." };
}

module.exports = { claim, isAlreadyClaimed, resolveTurnstileIfPresent };
