const fs = require("fs");
const path = require("path");

const IS_DOCKER = process.env.IS_DOCKER !== "false";
const DATA_PATH = process.env.DATA_PATH || (IS_DOCKER ? "/data/" : "./data/");
const COOKIE_FILE = path.join(DATA_PATH, "cookies.json");

// The auth session lives in an httpOnly cookie named "user_token" (JWT),
// alongside a signature cookie and an expiry-tracking cookie. Everything
// else in a typical browser export is analytics/tracking noise.
const AUTH_COOKIE_NAME = "user_token";

// Accepts both our own saved format (Puppeteer's page.cookies() shape) and a
// raw browser-extension export (e.g. Cookie-Editor), so an exported JSON can
// be dropped straight in as cookies.json.
function normalizeCookie(c) {
	const rawSameSite = (c.sameSite || "").toString().toLowerCase();
	let sameSite;
	if (rawSameSite === "strict") sameSite = "Strict";
	else if (rawSameSite === "lax") sameSite = "Lax";
	else if (rawSameSite === "no_restriction" || rawSameSite === "none") sameSite = "None";
	else sameSite = undefined; // "unspecified" or missing — let Chrome default

	const expires = c.expires ?? c.expirationDate ?? undefined;

	return {
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: c.path || "/",
		expires,
		httpOnly: !!c.httpOnly,
		secure: c.secure ?? true,
		sameSite,
	};
}

function cookieFileExists() {
	return fs.existsSync(COOKIE_FILE);
}

function loadCookies() {
	if (!fs.existsSync(COOKIE_FILE)) return [];
	const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
	return raw.map(normalizeCookie);
}

function saveCookies(cookies) {
	fs.mkdirSync(DATA_PATH, { recursive: true });
	fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

function hasAuthCookieInList(cookies) {
	return cookies.some((c) => c.name === AUTH_COOKIE_NAME && c.value);
}

async function applyCookies(page, cookies) {
	for (const cookie of cookies) {
		try {
			await page.setCookie({
				...cookie,
				domain: cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`,
			});
		} catch (_) {}
	}
}

async function hasAuthCookie(page) {
	const cookies = await page.cookies();
	return hasAuthCookieInList(cookies);
}

// expires is a Unix timestamp (seconds) in Puppeteer's cookie format
function authCookieExpiry(cookies) {
	const c = cookies.find((c) => c.name === AUTH_COOKIE_NAME);
	if (!c || !c.expires) return null;
	return new Date(c.expires * 1000).toISOString();
}

module.exports = {
	DATA_PATH,
	COOKIE_FILE,
	AUTH_COOKIE_NAME,
	cookieFileExists,
	loadCookies,
	saveCookies,
	applyCookies,
	hasAuthCookie,
	hasAuthCookieInList,
	authCookieExpiry,
};
