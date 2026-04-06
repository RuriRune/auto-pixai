const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/login";

const username = process.env.LOGINNAME ? process.env.LOGINNAME : undefined;
const password = process.env.PASSWORD ? process.env.PASSWORD : undefined;

const COOKIE_STRING = process.env.PIXAI_COOKIE || "";

const isDocker = true;
const headless = true;

const tryCountMax = 3;
let tryCount = 0;

const LANG = process.env.APP_LANG || "en-GB";

function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time);
	});
}

async function applyCookies(page) {
	if (!COOKIE_STRING) return;

	const cookies = COOKIE_STRING.split(";").map(c => {
		const [name, ...rest] = c.trim().split("=");
		return {
			name,
			value: rest.join("="),
			domain: ".pixai.art",
			path: "/"
		};
	});

	await page.setCookie(...cookies);
	console.log("Cookies applied");
}

async function loginAndScrape(url, username, password, isDocker, headless) {
	console.log("Starting");

	if (!COOKIE_STRING && (username == undefined || password == undefined)) {
		throw new Error("Set LOGINNAME/PASSWORD or PIXAI_COOKIE");
	}

	let config = {
		headless: headless,
	};

	if (isDocker) {
		config = {
			...config,
			executablePath: "/usr/bin/google-chrome",
			args: [
				"--disable-gpu",
				"--disable-setuid-sandbox",
				"--no-sandbox",
				"--no-zygote",
				"--lang=" + LANG
			],
		};
	}

	const browser = await puppeteer.launch(config);
	const page = await browser.newPage();

	await page.setUserAgent(
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
		"AppleWebKit/537.36 (KHTML, like Gecko) " +
		"Chrome/120.0.0.0 Safari/537.36"
	);

	await page.setExtraHTTPHeaders({
		"Accept-Language": `${LANG},en;q=0.9`
	});

	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, "language", {
			get: () => "en-GB"
		});
		Object.defineProperty(navigator, "languages", {
			get: () => ["en-GB", "en"]
		});
	});

	try {
		// open base site first
		await page.goto("https://pixai.art", { waitUntil: "domcontentloaded" });

		// apply cookies
		await applyCookies(page);

		// reload so cookies take effect
		await page.reload({ waitUntil: "domcontentloaded" });

		// go to login page (or dashboard)
		await page.goto(url, { waitUntil: "domcontentloaded" });

	} catch (error) {
		console.error("Failed to access URL:", error);
		tryCount++;
		if (tryCount <= tryCountMax) {
			return await loginAndScrape(url, username, password, isDocker, headless);
		} else {
			throw new Error("Retry failed: access URL");
		}
	}

	try {
		await delay(300);
		await page.waitForSelector(
			'div[id="root"] > div > div > div > div > div form > div > div button:last-of-type'
		);
		await page.click(
			'div[id="root"] > div > div > div > div > div form > div > div button:last-of-type'
		);
		await delay(3000);
	} catch {}

	try {
		if (!COOKIE_STRING) {
			console.log("Logging in with credentials");
			await login(page, username, password);
		} else {
			console.log("Using cookies, skipping login");
		}
	} catch (error) {
		console.error("Login failed:", error);
		tryCount++;
		if (tryCount <= tryCountMax) {
			return await loginAndScrape(url, username, password, isDocker, headless);
		} else {
			throw new Error("Retry failed: login");
		}
	}

	try {
		console.log("Claiming reward");
		await claimCreditFromPop(page);
	} catch (error) {
		console.error("Popup claim failed:", error);
		await originalScrape(url, username, password, isDocker, headless, page);
	}

	await browser.close();
}

async function login(page, username, password) {
	await page.type("#email-input", username);
	await page.type("#password-input", password);
	await delay(300);
	await page.click('button[type="submit"]');
	await delay(6000);
}

async function checkPopup(page) {
	try {
		await page.click('//*[@id="app"]/body/div[4]/div[3]/div/div[2]/div/button');
		return true;
	} catch {
		try {
			await page.click('//*[@id="app"]/body/div[2]/div[3]/div/div/button');
			return true;
		} catch {
			return false;
		}
	}
}

async function selectProfileButton(page) {
	while (true) {
		await checkPopup(page);
		try {
			await page.$eval("header > button:nth-of-type(2)", (el) => el.click());
			await delay(300);
			break;
		} catch (err) {
			throw new Error(err);
		}
		await delay(49);
	}
}

async function clickProfile(page) {
	await page.waitForSelector(
		"div[role='menu'] > a[role='menuitem']:nth-of-type(1)"
	);
	await page.click("div[role='menu'] > a[role='menuitem']:nth-of-type(1)");
	await delay(300);
}

async function claimCredit(page) {
	await page.waitForSelector(
		"section > div > div:nth-of-type(2) > div:nth-of-type(2) > button"
	);

	while (true) {
		try {
			await page.click(
				"section > div > div:nth-of-type(1) > div:nth-of-type(2) > button"
			);
			await delay(300);
			await page.reload();
			await delay(5000);

			const text = await page.$eval(
				"section > div > div:nth-of-type(1) > div:nth-of-type(2) > button > span",
				(el) => el.innerText.toLowerCase()
			);

			if (text.includes("claimed")) {
				console.log("Claim successful");
				break;
			}
		} catch {
			if (!(await checkPopup(page))) {
				console.log("Already claimed");
				break;
			}
		}
	}
}

async function claimCreditFromPop(page) {
	await page.waitForSelector("section > div > div > button");

	while (true) {
		try {
			await page.click("section > div > div > button");
			await delay(300);
			await page.reload();
			await delay(5000);
		} catch {
			if (!(await checkPopup(page))) {
				console.log("Already claimed");
				break;
			}
		}
	}
}

loginAndScrape(url, username, password, isDocker, headless)
	.then(() => {
		console.log("Completed");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Error:", error);
		process.exit(1);
	});