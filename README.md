🔒 LocKeep Password Manager
LocKeep is a local-first password manager. I built this project because I wanted a secure vault where my credentials literally never leave my device. It consists of an Electron desktop app and a Manifest V3 browser extension that communicate locally via Chrome's Native Messaging API.

No cloud and no accounts. Vault data never leaves your machine. The only external connection is the application updater checking and downloading stable releases from the official GitHub repository.

✨ Features
Smart Autofill: A clean, native-feeling dropdown that appears on login fields, allowing you to inject your credentials seamlessly.

Universal Password Generator: A lightning-bolt icon injects directly into registration forms (right next to the password field). It uses a custom DOM observer, meaning it works flawlessly even on heavy, dynamic Single Page Applications (like Gmail or Outlook) without breaking the page layout.

Dynamic Save Prompts: When you log into a new site, a non-intrusive prompt slides in asking if you want to save the credentials. It instantly adapts to your system language (EN, DE, TR) on the fly.

Context-Aware UI: The browser extension knows the exact state of your desktop app. It displays a locked status if your vault requires a master password, and goes green when you are ready to autofill.

One-Click Updates: LocKeep checks the official GitHub Releases feed for stable versions. The user chooses when to download, install, and restart from the Settings screen.

Drag-and-Drop Install: You can install the extension instantly by simply dragging the integration box from the desktop app's "Browser Integration" tab and dropping it directly into your browser's extensions page (with Developer Mode enabled). It feels like magic.

🛡️ Security Architecture
Building a password manager means assuming everything is a threat. Here is how LocKeep protects your data:

Update-Only Network Access: The renderer, browser extension, and vault remain blocked from outside network access. Only the main-process updater may contact the official GitHub Releases endpoint, and no vault data is included in those requests.

Local E2E Encryption: Even though the extension and desktop app communicate locally, they do not trust the loopback connection. They perform an ECDH (P-256) handshake to generate a shared secret, and all subsequent messages are encrypted using AES-256-GCM.

Strict IPC Bouncer: The frontend (Renderer) has no direct access to Node.js. Every piece of data sent to the backend goes through strict type-checking and length sanitization to prevent object injection or buffer overflow attacks.

Registry Whitelisting: The desktop app only listens to the specific, hardcoded LocKeep extension ID. Malicious extensions cannot hijack the Native Messaging bridge.

🌐 Supported Languages
LocKeep is built with support for 3 languages and instantly adapts to your preference without needing a restart:

🇹🇷 Turkish (Türkçe)

🇺🇸 English

🇩🇪 German (Deutsch)

(More languages can be added in the future upon request!)

## Publishing an Auto-Update Release

1. Set the new stable version in `package.json` and `package-lock.json`.
2. Run `npm test`.
3. Run `npm run build`.
4. Create a non-draft, non-prerelease GitHub Release with a matching tag such as `vX.Y.Z`.
5. Upload these files from the same `dist` build:
   - `LocKeepPasswordManager-Setup-X.Y.Z.exe`
   - `LocKeepPasswordManager-Setup-X.Y.Z.exe.blockmap`
   - `latest.yml`

The installer, blockmap, and `latest.yml` must come from the same build. Draft and prerelease GitHub releases are intentionally ignored by the in-app updater.

## License & Terms of Use

This project is protected under a strict **Proprietary (All Rights Reserved)** license. 

- 🔓 **You are free to:** Download, run, inspect, and use LocKeep strictly for personal, non-commercial purposes.
- ⛔ **You are NOT allowed to:** Copy, modify, redistribute, or use parts of this source code to publish it under your own name, use it in closed-source software, or commercialize/sell it in any form.
- 🐛 **Bug Reports:** If you find any bugs or UI bugs, please open an issue in the **Issues** tab. All code modifications will be executed solely by the original author.
