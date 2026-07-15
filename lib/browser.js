// rebrowser-puppeteer: drop-in puppeteer fork that patches the Runtime.enable
// CDP leak — the primary signal Cloudflare Turnstile uses to detect puppeteer.
// No stealth plugin: puppeteer-extra-plugin-stealth is unmaintained and its
// evasions are themselves fingerprinted by CF now.
const puppeteer = require("rebrowser-puppeteer");

const IS_DOCKER = process.env.IS_DOCKER !== "false";

async function launchBrowser(headless) {
	const config = { headless };

	if (IS_DOCKER) {
		config.executablePath = "/usr/bin/google-chrome";
		config.args = [
			"--disable-gpu",
			"--disable-setuid-sandbox",
			"--no-sandbox",
			"--no-zygote",
			"--disable-blink-features=AutomationControlled",
			"--window-size=1280,900",
			"--lang=en-GB",
		];
		if (!headless) {
			config.args.push(`--display=${process.env.DISPLAY || ":99"}`);
		}
	}

	const browser = await puppeteer.launch(config);
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	// Deliberately NO setUserAgent(): a forced UA string contradicts the
	// Sec-CH-UA client hints and navigator.userAgentData that real Chrome
	// sends, and that mismatch is an instant Turnstile flag. The genuine
	// Linux Chrome UA is consistent end-to-end and passes.
	return { browser, page };
}

module.exports = { launchBrowser };
