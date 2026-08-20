# Auto-Pixai

A daily PixAI credit claimer that drives **real Chrome running on an Android
emulator** (connected over ADB + the Chrome DevTools Protocol) instead of a
desktop headless/Xvfb browser. A genuine, unmodified Chrome instance doesn't
carry the automation fingerprints (CDP-launch artifacts, `navigator.webdriver`,
etc.) that a desktop Puppeteer-launched browser does, which is what was
getting stuck on Cloudflare Turnstile before. This is better odds, not a
guarantee — Turnstile can still fail depending on IP reputation and other
signals.

No automated login — PixAI's login page has reCAPTCHA v3, which can silently
block automated logins. This relies entirely on a manually-exported session
cookie instead (see "Seeding a session" below).

## Architecture

Two containers, wired together by `docker-compose.yml`:

- **`android`** — [`budtmo/docker-android`](https://github.com/budtmo/docker-android),
  a real Android emulator with ADB exposed on `5555` and a noVNC web viewer
  on `6080` (open `http://<host>:6080` in a browser to watch it directly,
  useful for setup/debugging or manually solving Turnstile if it ever gets
  stuck).
- **`auto-pixai`** — the Node/Express server. Serves the dashboard, schedules
  the claim job via `node-cron`, and drives Chrome on the `android` container
  by: `adb connect`, launching Chrome via `am start`, `adb forward`-ing the
  Chrome DevTools socket, then connecting with Puppeteer's `connect()` (not
  `launch()` — no bundled Chromium involved on this side at all).

Each run: loads `/data/cookies.json`, applies it to the Android Chrome tab,
confirms the site accepts it (checks for the actual `user_token` auth
cookie), handles the Turnstile widget, clicks Claim, and re-saves cookies
afterward so the session stays fresh. On any non-success result — including
missing/invalid cookies — it sends a Pushover notification (if configured)
and records the result in run history. Debug screenshots land in
`/data/*.png` and show up in the dashboard gallery.

## Prerequisites

The emulator needs hardware-accelerated virtualization. Check before
anything else:

```
ls -l /dev/kvm
```

If that doesn't exist, the emulator will be unusably slow or won't start.
Since Unraid itself runs on KVM for its own VM feature, `/dev/kvm` should
already be present on the host — this compose file passes it through to the
`android` container.

## Setup

1. `docker compose up -d --build`
2. Open `http://<host>:6080` (noVNC) once to confirm the emulator actually
   boots to the home screen — first boot can take a few minutes.
3. Open `http://<host>:8080` — the dashboard. Set your cron schedule,
   Pushover credentials, and notification preferences from **Settings**. Use
   **Send test notification** to confirm Pushover delivery.

**No built-in authentication** on the dashboard. This is meant for a trusted
LAN/Unraid environment — put it behind your own reverse proxy with access
control if you expose it further.

## Seeding a session (required — there is no login flow)

1. Log into pixai.art normally in your own browser.
2. Export cookies for the `pixai.art` domain with a cookie-manager extension
   (e.g. Cookie-Editor) as JSON.
3. Save that export as `cookies.json` in the mounted data folder (e.g.
   `./data/cookies.json`, or wherever you've pointed the `auto-pixai` volume).
4. The dashboard's Cookies card shows "Valid" once it confirms a `user_token`
   cookie is present, along with its expiry.

The auth cookie is long-lived (~54 days) and gets re-saved after every run,
so as long as the container runs on schedule you shouldn't need to re-export
often. A high-priority Pushover alert fires if it ever goes missing/invalid
(when configured).

## Unraid

`docker-compose.yml` needs Unraid's Compose Manager plugin (or equivalent) —
Unraid's native single-container template UI doesn't handle multi-container
stacks. Alternatively, add the two containers manually via the Docker tab:
one from `budtmo/docker-android:emulator_11.0` with the settings in
`docker-compose.yml` above, and one built from this repo, with
`ANDROID_ADB_HOST` set to the android container's Unraid-assigned IP (or
container name if on the same custom bridge network) and `ANDROID_ADB_PORT=5555`.

## If a step stops matching the site

Check the relevant screenshot in the dashboard gallery (e.g.
`1_before_claim.png`, `2_turnstile_unresolved.png`, `2_after_claim.png`,
`cookies_rejected.png`) alongside the run's message in the History table.
If it's failing before even reaching the site (ADB/connection errors), the
message will say so explicitly — check the `android` container's logs and
the noVNC view first.
