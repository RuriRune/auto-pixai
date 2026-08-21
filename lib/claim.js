const { formatDuration } = require("./format");

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfCancelled(signal) {
	if (signal && signal.aborted) throw new Error("cancelled");
}

// Anchored to the start of the text so it matches "Claim 12,000 daily
// credits" but not a "Daily Claim" heading or an "Already Claimed" label —
// a plain /claim/i substring match would hit all three.
const CLAIM_BUTTON_PATTERN = /^claim\b/i;

const CLAIMED_TEXT_PATTERN = /already claimed|next reward available|credits claimed/i;

// The claim flow: drives the device entirely through ADB and the on-screen
// accessibility tree, with no CDP/Puppeteer involvement. This proved far
// more reliable on real hardware than Chrome's remote-debugging pipeline,
// where synthetic CDP input frequently failed to register on the claim
// button and the DevTools handshake itself often stalled.
//
// Cookies are refreshed separately (and optionally) after a successful
// claim — see connectCdpForCookies in androidBrowser.js.
async function claimViaAdbOnly(log, shot, deps, signal) {
	const { waitForTextOnScreen, screenHasText, tapByText, swipeUp } = deps;
	const MODAL_WAIT_MS = 180000;

	log("CLAIM", "Claiming via ADB and the accessibility tree.");

	// Wait for the modal to actually be on screen.
	const modal = await waitForTextOnScreen(log, /daily claim/i, MODAL_WAIT_MS, signal);
	if (!modal) {
		await shot("1_before_claim");
		return {
			status: "CLAIM_BUTTON_NOT_FOUND",
			message: `Daily Claim modal never appeared on screen within ${formatDuration(MODAL_WAIT_MS)} (via ADB).`,
		};
	}
	log("CLAIM", "Daily Claim modal detected on screen.");
	await shot("1_before_claim");

	if (await screenHasText(log, CLAIMED_TEXT_PATTERN)) {
		log("CLAIM", "Already claimed today — nothing to do.");
		return { status: "ALREADY_CLAIMED" };
	}

	// Wait for the claim button to actually exist on screen. Cloudflare
	// gates it, so this doubles as waiting for the challenge to clear.
	const CLAIM_WAIT_MS = 120000;
	log("CLAIM", "Waiting for the claim button to appear (Cloudflare must clear first)...");
	let button = await waitForTextOnScreen(log, CLAIM_BUTTON_PATTERN, CLAIM_WAIT_MS, signal);

	if (!button && typeof swipeUp === "function") {
		log("CLAIM", "Claim button not found — swiping up in case it's below the fold.");
		await swipeUp(log);
		await delay(1000);
		button = await waitForTextOnScreen(log, CLAIM_BUTTON_PATTERN, 15000, signal);
	}

	if (!button) {
		await shot("2_claim_button_not_found");
		return {
			status: "CLAIM_BUTTON_NOT_FOUND",
			message: `Claim button never appeared on screen within ${formatDuration(CLAIM_WAIT_MS)} (via ADB).`,
		};
	}

	// Tap it, then confirm by checking the button is gone / claimed text shows.
	for (let attempt = 1; attempt <= 2; attempt++) {
		throwIfCancelled(signal);
		log("CLAIM", `Tapping "${button.text}" via OS-level input tap (attempt ${attempt}).`);
		await tapByText(log, CLAIM_BUTTON_PATTERN);
		await delay(3000);

		if (await screenHasText(log, CLAIMED_TEXT_PATTERN)) {
			await shot("2_after_claim");
			return { status: "SUCCESS" };
		}
		// Button gone is also a good sign the claim went through.
		if (!(await screenHasText(log, CLAIM_BUTTON_PATTERN))) {
			await shot("2_after_claim");
			return { status: "SUCCESS" };
		}
		log("CLAIM", "Claim button still present after tap — retrying.");
	}

	await shot("2_after_claim");
	return {
		status: "CLICKED_UNCONFIRMED",
		message: "Tapped the claim button but it was still on screen afterward (via ADB).",
	};
}

module.exports = { claimViaAdbOnly, CLAIM_BUTTON_PATTERN, CLAIMED_TEXT_PATTERN };
