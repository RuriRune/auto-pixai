# Auto-Pixai

Rebuilt from the original [Mr-Smilin/Auto-Pixai](https://github.com/Mr-Smilin/Auto-Pixai), with:

- **Cookie persistence** — session cookies saved to `/data/cookies.json`, loaded on
  every run, and re-saved after every run (success or not) so they stay fresh and
  logins are skipped whenever possible.
- **Turnstile handling** — no external solving service. Detects the Cloudflare
  Turnstile iframe, gives it time to self-solve, and clicks the checkbox once if
  it hasn't. This matches how the widget behaves in a real browser.
- **Headless-first, visible-mode fallback** — tries headless Chrome first, and
  only spins up the Xvfb-backed visible browser if the headless attempt errors
  out or Turnstile never clears. Set `FORCE_HEADLESS=true` or `=false` in `.env`
  to pin one mode.
- **Debug screenshots** — written to `/data/` at each key step (before/after
  claim, and on any failure) so issues can be diagnosed without guessing.
- **Text-based button matching** instead of fixed CSS paths, since pixai.art's
  DOM/class names change over time and fixed selectors are the first thing to
  break.

## Setup

1. Copy `.env.example` to `.env` and fill in `LOGINNAME` / `PASSWORD`.
2. `docker build -t auto-pixai .`
3. Run with `/data` mounted to a persistent volume (for cookies + screenshots), e.g.:
   ```
   docker run --env-file .env -v /mnt/user/appdata/auto-pixai:/data auto-pixai
   ```
4. Schedule it daily (cron / Unraid User Scripts / docker-compose + ofelia, etc).

## If a step stops matching the site

Check the relevant screenshot in `/data/` (e.g. `login_fail_*.png`,
`2_turnstile_unresolved.png`, `2_after_claim.png`) and the console log — both
point at exactly which step failed, so a fix is usually a small selector/text
tweak in `app.js` rather than a rewrite.
