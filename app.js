const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const url = "https://pixai.art/login";

const username = process.env.LOGINNAME ? process.env.LOGINNAME : undefined;
const password = process.env.PASSWORD ? process.env.PASSWORD : undefined;

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

async function loginAndScrape(url, username, password, isDocker, headless) {
	console.log("Username:", username);

	if (username == undefined || password == undefined) {
		throw new Error("Please set username and password in environment variables");
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
		await page.goto(url);
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
		await delay(30);
		await page.click(
			'div[id="root"] > div > div > div > div > div form > div > div button:last-of-type'
		);
		await delay(3000);
	} catch (error) {
		console.error("Failed to dismiss initial popup:", error);
	}

	try {
		console.log("Logging in");
		await login(page, username, password);
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
		console.log("Claiming daily reward (popup)");
		await claimCreditFromPop(page);
	} catch (error) {
		console.error("Popup claim failed:", error);
		tryCount++;
		if (tryCount <= tryCountMax) {
			console.log("Falling back to original method");
			await originalScrape(url, username, password, isDocker, headless, page);
		} else {
			throw new Error("Popup claim failed");
		}
	}

	await browser.close();
}

async function originalScrape(
	url,
	username,
	password,
	isDocker,
	headless,
	page
) {
	try {
		console.log("Opening profile menu");
		await selectProfileButton(page);
	} catch (error) {
		console.error("Failed opening profile menu:", error);
		throw error;
	}

	try {
		console.log("Opening profile");
		await clickProfile(page);
	} catch (error) {
		console.error("Failed opening profile:", error);
		throw error;
	}

	try {
		console.log("Claiming daily reward");
		await claimCredit(page);
	} catch (error) {
		console.error("Claim failed:", error);
		throw error;
	}
}

async function login(page, username, password) {
	await page.type("#email-input", username);
	await page.type("#password-input", password);
	await delay(300);
	await page.waitForSelector('button[type="submit"]');
	await page.click('button[type="submit"]');
	await delay(6000);
	try {
		await page.$eval('button[type="submit"]', (button) => button.click());
		await delay(3000);
	} catch {}
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
	while (true) {
		try {
			await page.click("div[role='menu'] > a[role='menuitem']:nth-of-type(1)");
			await delay(300);
			break;
		} catch (err) {
			throw new Error(err);
		}
	}
}

async function claimCredit(page) {
	await page.waitForSelector(
		"section > div > div:nth-of-type(2) > div:nth-of-type(2) > button"
	);
	let isClaimed = false;

	while (true) {
		try {
			if (isClaimed) break;

			await page.click(
				"section > div > div:nth-of-type(1) > div:nth-of-type(2) > button"
			);
			await delay(300);
			await page.reload();
			await delay(5000);

			const updatedClaimBtnText = await page.$eval(
				"section > div > div:nth-of-type(1) > div:nth-of-type(2) > button > span",
				(el) => el.innerText
			);

			const text = updatedClaimBtnText.toLowerCase();

			if (
				text.includes("claimed") ||
				text.includes("已認領") ||
				text.includes("已认领") ||
				text.includes("申請済み")
			) {
				console.log("Claim successful");
				isClaimed = true;
			}
		} catch {
			if (!(await checkPopup(page))) {
				await delay(500);
				if (isClaimed) {
					console.log("Already claimed");
					break;
				}
			}
		}
	}
}

async function claimCreditFromPop(page) {
	await page.waitForSelector("section > div > div > button");
	let isClaimed = false;

	while (true) {
		try {
			if (isClaimed) break;

			await page.click("section > div > div > button");
			await delay(300);
			await page.reload();
			await delay(5000);
		} catch {
			if (!(await checkPopup(page))) {
				await delay(500);
				if (isClaimed) {
					console.log("Already claimed");
					break;
				}
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