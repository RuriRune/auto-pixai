# Auto-Pixai

A daily PixAI credit claimer that drives **real Chrome running on a real
Android device** (connected over ADB + the Chrome DevTools Protocol)
instead of a desktop headless/Xvfb browser. A genuine, unmodified Chrome
instance doesn't carry the automation fingerprints (CDP-launch artifacts,
`navigator.webdriver`, etc.) that a desktop Puppeteer-launched browser does,
which is what was getting stuck on Cloudflare Turnstile before. This is
better odds, not a guarantee — Turnstile can still fail depending on IP
reputation and other signals.

No automated login — PixAI's login page has reCAPTCHA v3, which can silently
block automated logins. This relies entirely on a manually-exported session
cookie instead (see "Seeding a session" below).

## Architecture

A single container (`auto-pixai`) drives Chrome on a separate Android
device on your LAN — a spare phone (e.g. a Galaxy XCover 5) works well for
this, since real hardware carries none of the emulator-specific
fingerprints an emulated device would.

Each run: connects over ADB, wakes the device's screen and holds it awake
for the run's duration (`svc power stayon`), launches Chrome via `am start`,
`adb forward`s the Chrome DevTools socket, then connects with Puppeteer's
`connect()` (not `launch()` — no bundled Chromium involved on this side at
all). It loads `/data/cookies.json`, applies it to the tab, confirms the
site accepts it (checks for the actual `user_token` auth cookie), handles
the Turnstile widget, clicks Claim, and re-saves cookies afterward so the
session stays fresh. The screen is released back to its normal timeout when
the run finishes.

On any non-success result — including missing/invalid cookies — it sends a
Pushover notification (if configured) and records the result in run
history. Debug screenshots land in `/data/*.png` and show up in the
dashboard gallery.

## Phone setup

1. **Enable Developer Options + USB debugging**: Settings → About phone →
   tap Build number 7× → Developer options → USB debugging on.
2. **Pair once**: connect via USB to any PC with `adb` (Android SDK
   platform-tools) installed, accept the on-device authorization prompt (USB
   mode must be "Transferring files," not "Charging only," or the prompt
   won't appear), then run `adb tcpip 5555` and unplug. Alternatively, on
   Android 11+, use Settings → Developer options → Wireless debugging →
   Pair device with pairing code, and `adb pair <ip>:<port> <code>` from a
   PC or the container console — then lock it onto the standard port with
   `adb -s <ip>:<port> tcpip 5555`.
3. **Reserve its IP** via a DHCP reservation on your router/firewall so it
   never changes — that's the value for `ANDROID_ADB_HOST`.
4. **Screen lock**: Settings → Security and privacy → Screen lock → None.
   The app forces the screen awake for the duration of each run regardless
   of your normal timeout setting, so a short timeout the rest of the time
   is fine — but a PIN/pattern lock would block Chrome even after waking.
5. **Battery**: exclude Chrome from battery optimization / sleeping-apps
   restrictions (Settings → Battery and device care → Battery → Background
   usage limits), and set Battery protection → Maximum if the device stays
   permanently plugged in.
6. **Display zoom**: Settings → Display → Screen zoom and font → set zoom to
   minimum. PixAI's Daily Claim modal has grown taller over time (extra
   promo banners), and at default zoom the Claim button sits below the
   fold — reducing zoom fits the whole modal on-screen with no scrolling
   needed at all, which is far more reliable than trying to programmatically
   scroll to it. (The app still attempts a real touch-swipe scroll as a
   fallback if a future layout change pushes something out of view again,
   but this setting is what actually makes claiming reliable day-to-day.)

Important: `adb tcpip 5555` (and wireless-debugging pairing) doesn't
survive a device reboot — after a reboot you'll need to briefly reconnect
via USB (or re-pair) to re-enable it.

## Setup

1. Build and run the `auto-pixai` container (Unraid template or
   `docker-compose.yml`), with `ANDROID_ADB_HOST`/`ANDROID_ADB_PORT` pointed
   at the phone.
2. **The container's `adb` key needs authorizing on the phone once** — its
   key pair lives at `/data/.android/adbkey`, inside the persistent volume,
   so this survives image rebuilds/container recreation. From the container
   console: `adb connect <phone-ip>:5555` — the phone will show an
   authorization popup the first time; tick "Always allow from this
   computer" and tap Allow. If it doesn't reappear after a previous failed
   attempt, use Settings → Developer options → Revoke USB debugging
   authorizations on the phone to force a fresh prompt.
3. Open `http://<host>:8080` — the dashboard. Set your cron schedule,
   Pushover credentials, and notification preferences from **Settings**. Use
   **Send test notification** to confirm Pushover delivery.

**No built-in authentication** on the dashboard. This is meant for a trusted
LAN/Unraid environment — put it behind your own reverse proxy with access
control if you expose it further.

## Seeding a session (required — there is no login flow)

1. Log into pixai.art normally in any browser (doesn't have to be the phone
   — cookies aren't device-specific).
2. Export cookies for the `pixai.art` domain with a cookie-manager extension
   (e.g. Cookie-Editor) as JSON.
3. Save that export as `cookies.json` in the mounted data folder.
4. The dashboard's Cookies card shows "Valid" once it confirms a `user_token`
   cookie is present, along with its expiry.

The auth cookie is long-lived (~54 days) and gets re-saved after every run,
so as long as the container runs on schedule you shouldn't need to re-export
often. A high-priority Pushover alert fires if it ever goes missing/invalid
(when configured).

## Pushover

Set your Pushover user key and app token in the dashboard's **Settings**
section, then click **Send test notification** to confirm delivery. By
default it only notifies on problems (missing/expired cookies, claim button
not found, device unreachable, errors). Cancelled runs never notify.

Two optional toggles:

- **Notify on success too** — also ping on successful claims. Off by
  default, which is why a successful run can look "silent" while failures
  come through.
- **Notify when a run starts** — a heartbeat at the start of every run, sent
  at Pushover priority -1 so it arrives silently. Its *absence* is the
  signal: if the expected daily message doesn't arrive, something upstream
  broke (container stopped, host down, schedule not firing). This only helps
  if you'd notice a missing message — for reliable detection of a dead
  container, point an uptime monitor at the dashboard as well.

Note that the environment variables only *seed* these settings on first run.
Once `settings.json` exists, the dashboard values win.

## If a step stops matching the site

Check the relevant screenshot in the dashboard gallery (e.g.
`1_before_claim.png`, `2_turnstile_unresolved.png`, `2_after_claim.png`,
`cookies_rejected.png`) alongside the run's message in the History table.
If it's failing before even reaching the site (ADB/connection errors, or an
"unauthorized" device), the message will say so explicitly — check that the
phone is reachable and its screen/Chrome behave as expected, ideally by
watching it live with [scrcpy](https://github.com/Genymobile/scrcpy) from a
PC on the same network.
