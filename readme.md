<h1 align="center">
    <img width="120" height="120" src="public/pic/logo.png" alt=""><br>
    auto-pixai-english
</h1>

<p align="center">
    <a href="https://github.com/markld95/auto-pixai/blob/main/LICENSE"><img src="https://img.shields.io/github/license/markld95/auto-pixai?style=flat-square"></a>
    <a href="https://github.com/markld95/auto-pixai"><img src="https://img.shields.io/github/stars/markld95/auto-pixai?style=flat-square"></a>
    <a href="https://github.com/markld95/auto-pixai/pkgs/container/auto-pixai"><img src="https://img.shields.io/badge/version-2.1.0-orange?style=flat-square"></a>
</p>

**Automatically claim daily rewards on pixai.art using Puppeteer Stealth and JSON session injection.**

---

## 📢 Credits & Modifications
This is an English-localized fork of the original [auto-pixai](https://github.com/Mr-Smilin/auto-pixai) project by **Mr-Smilin**.

**Key Enhancements in this Fork:**
* **Full English Support:** Logs and error messages translated for easier troubleshooting.
* **JSON Cookie Injection:** Support for `cookies.json` to bypass login screens and maintain sessions securely.
* **Cloudflare/Turnstile Aware:** Automated logic to detect and interact with "Verify you are human" challenges.
* **Headless Optimized:** Specifically configured to run in Docker environments with anti-detection flags.

---

## 🚀 Getting Started

### 1. Prepare your Cookies
This script uses your browser session to bypass 2FA and login hurdles.

1.  Log in to [pixai.art](https://pixai.art) in your browser.
2.  Use a browser extension (e.g., **Cookie-Editor**) to export your cookies in **JSON** format.
3.  Save the content as a file named `cookies.json`.

### 2. Docker Setup
The container requires a volume mount at `/data`. This is where you place your `cookies.json` and where the script will save debug screenshots.

#### Volume Structure
```text
your-local-folder/
└── cookies.json