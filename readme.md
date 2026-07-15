# Auto-Pixai

A daily PixAI credit claimer with a small web dashboard, built-in cron
scheduling, and Pushover alerts. No automated login — PixAI's login page has
a reCAPTCHA v3 badge that can silently block automated logins with no visible
error, so this relies entirely on a manually-exported session cookie instead.

## How it works

- A single Node/Express server stays running in the container and serves the
  dashboard at `http://<host>:8080`.
- It schedules the claim job internally via `node-cron`, using a cron
  expression you set from the dashboard (persisted to `/data/schedule.json`).
- Each run: loads `/data/cookies.json`, applies it, confirms the site accepts
  it (checks for the real `user_token` auth cookie — not just DOM text),
  handles the Cloudflare Turnstile widget (self-solves in most cases; clicks
  the checkbox once if it hasn't after 15s), clicks Claim, and re-saves
  cookies afterward so the session stays fresh.
- Tries headless first; only falls back to a visible (Xvfb) browser if
  Turnstile doesn't clear or something errors.
- On any non-success/non-already-claimed result — including missing or
  invalid cookies — it sends a Pushover notification (if configured) and
  records the result in run history.
- Debug screenshots at each key step land in `/data/*.png` and show up in the
  dashboard's screenshot gallery.

## Setup

1. `docker build -t auto-pixai .`
2. Run with `/data` mounted to a persistent volume and the port published:
   ```
   docker run -p 8080:8080 -v /mnt/user/appdata/auto-pixai:/data auto-pixai
   ```
3. Open `http://<host>:8080` — set your cron schedule, Pushover credentials,
   browser mode, and notification preferences all from the **Settings**
   section. A `.env` file only matters for infra-level values (`PORT`,
   `DATA_PATH`, `TZ`, `DEFAULT_CRON` for the very first run) — see
   `.env.example`.
4. Use **Send test notification** in Settings to confirm Pushover is wired up
   correctly before relying on it.

**No built-in authentication.** This is meant for a trusted LAN/Unraid
environment. If you expose it beyond that, put it behind your own
reverse proxy with access control.

## Seeding a session (required — there is no login flow)

1. Log into pixai.art normally in your own browser.
2. Export cookies for the `pixai.art` domain with a cookie-manager extension
   (e.g. Cookie-Editor) as JSON.
3. Save that export as `cookies.json` in the mounted data folder (e.g.
   `/mnt/user/appdata/auto-pixai/cookies.json`).
4. The dashboard's Cookies card will show "Valid" once it confirms a
   `user_token` cookie is present, along with its expiry.

The auth cookie is long-lived (~54 days) and gets re-saved after every run,
so as long as the container runs on schedule you shouldn't need to re-export
often. If it ever shows "Invalid" or "Missing," re-export and drop in a fresh
copy — you'll also get a high-priority Pushover alert when that happens (if
configured).

## Pushover

Set your Pushover user key and app token in the dashboard's **Settings**
section to enable notifications, then click **Send test notification** to
confirm delivery. By default it only notifies on problems (missing/invalid
cookies, Turnstile blocked, claim button not found, errors). Toggle "Notify
on success too" if you also want a ping on successful claims.

## If a step stops matching the site

Check the relevant screenshot in the dashboard gallery (e.g.
`1_before_claim.png`, `2_turnstile_unresolved.png`, `2_after_claim.png`,
`cookies_rejected.png`) alongside the run's message in the History table —
together they point at exactly which step failed.
