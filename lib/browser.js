const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

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
		];
		if (!headless) {
			config.args.push(`--display=${process.env.DISPLAY || ":99"}`);
		}
	}

	const browser = await puppeteer.launch(config);
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	await page.setUserAgent(
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
			"AppleWebKit/537.36 (KHTML, like Gecko) " +
			"Chrome/124.0.0.0 Safari/537.36"
	);
	return { browser, page };
}

module.exports = { launchBrowser };
