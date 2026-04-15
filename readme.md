<h1 align="center">
    <img width="120" height="120" src="public/pic/logo.png" alt=""><br>
    auto-pixai
</h1>

<p align="center">
    <a href="https://github.com/RuriRune/auto-pixai/blob/main/LICENSE"><img src="https://img.shields.io/github/license/RuriRune/auto-pixai?style=flat-square"></a>
    <a href="https://github.com/RuriRune/auto-pixai"><img src="https://img.shields.io/github/stars/RuriRune/auto-pixai?style=flat-square"></a>
    <a href="https://github.com/RuriRune/auto-pixai/pkgs/container/auto-pixai"><img src="https://img.shields.io/badge/version-2.1.0-orange?style=flat-square"></a>
</p>

<p align="center">
Automatically claim daily rewards on pixai.art using Puppeteer Stealth and JSON session injection.
</p>

---

## 📢 Credits & Modifications
This is an English-localised fork of the original [auto-pixai](https://github.com/Mr-Smilin/auto-pixai) project by **Mr-Smilin**.

### Key Enhancements
- **Full English Support**  
  Logs and error messages translated for easier troubleshooting.

- **JSON Cookie Injection**  
  Supports `cookies.json` to bypass login screens and maintain sessions.

- **Cloudflare / Turnstile Aware**  
  Detects and interacts with “Verify you are human” challenges.

- **Headless Optimised**  
  Tuned for Docker environments with anti-detection flags.

---

## 🚀 Getting Started

### 1. Prepare Your Cookies
This script uses your browser session to bypass 2FA and login hurdles.

1. Log in to https://pixai.art  
2. Use a browser extension (e.g. Cookie-Editor) to export cookies in JSON format  
3. Save the file as `cookies.json`

---

### 2. File Placement

The container requires a volume mounted to `/data`.

#### Expected Structure
```text
your-local-folder/
└── cookies.json
```

---

## 🐳 Deployment

Ensure your volume path points to the folder containing `cookies.json`.

### Docker Compose (Recommended)
```yaml
services:
  pixai-claimer:
    image: ghcr.io/RuriRune/auto-pixai:latest
    container_name: auto-pixai
    volumes:
      - /path/to/your-local-folder:/data
    environment:
      - IS_DOCKER=true
      - TZ=UTC
    restart: unless-stopped
```

---

## 🛠 Troubleshooting

### Log Indicators
- `[INFO] Injected X cookies`  
  Cookies detected and loaded successfully

- `[AUTH] Turnstile click sent`  
  Cloudflare verification handled

- `[RESULT] Claim Status: SUCCESS`  
  Credits successfully claimed

---

### Common Issues

**Session Expired**  
If you appear as a guest, your cookies have expired. Export a fresh `cookies.json`.

**Debug Screenshots**  
Check your mounted folder for:
- `1_before_claim.png`
- `2_after_claim.png`

These show exactly what the bot sees.

---

## ⚖️ License

Distributed under the MIT License. See `LICENSE` for more information.