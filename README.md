🔒 LocKeep Password Manager
LocKeep is a strictly offline, local-first password manager. I built this project because I wanted a secure vault where my credentials literally never leave my device. It consists of an Electron desktop app and a Manifest V3 browser extension that communicate locally via Chrome's Native Messaging API.

No cloud, no accounts, no external network requests. Just your machine.

✨ Features
Smart Autofill: A clean, native-feeling dropdown that appears on login fields, allowing you to inject your credentials seamlessly.

Universal Password Generator: A lightning-bolt icon injects directly into registration forms (right next to the password field). It uses a custom DOM observer, meaning it works flawlessly even on heavy, dynamic Single Page Applications (like Gmail or Outlook) without breaking the page layout.

Dynamic Save Prompts: When you log into a new site, a non-intrusive prompt slides in asking if you want to save the credentials. It instantly adapts to your system language (EN, DE, TR) on the fly.

Context-Aware UI: The browser extension knows the exact state of your desktop app. It displays a locked status if your vault requires a master password, and goes green when you are ready to autofill.

Drag-and-Drop Install: You can install the extension instantly by simply dragging the integration box from the desktop app's "Browser Integration" tab and dropping it directly into your browser's extensions page (with Developer Mode enabled). It feels like magic.

🛡️ Security Architecture
Building a password manager means assuming everything is a threat. Here is how LocKeep protects your data:

Zero Network Access: The Electron app is completely blocked from making outside network requests. It is a true offline vault.

Local E2E Encryption: Even though the extension and desktop app communicate locally, they do not trust the loopback connection. They perform an ECDH (P-256) handshake to generate a shared secret, and all subsequent messages are encrypted using AES-256-GCM.

Strict IPC Bouncer: The frontend (Renderer) has no direct access to Node.js. Every piece of data sent to the backend goes through strict type-checking and length sanitization to prevent object injection or buffer overflow attacks.

Registry Whitelisting: The desktop app only listens to the specific, hardcoded LocKeep extension ID. Malicious extensions cannot hijack the Native Messaging bridge.

🌐 Supported Languages
LocKeep is built with support for 3 languages and instantly adapts to your preference without needing a restart:

🇹🇷 Turkish (Türkçe)

🇺🇸 English

🇩🇪 German (Deutsch)

(More languages can be added in the future upon request!)

## License & Terms of Use

This project is protected under a strict **Proprietary (All Rights Reserved)** license. 

- 🔓 **You are free to:** Download, run, inspect, and use LocKeep strictly for personal, non-commercial purposes.
- ⛔ **You are NOT allowed to:** Copy, modify, redistribute, or use parts of this source code to publish it under your own name, use it in closed-source software, or commercialize/sell it in any form.
- 🐛 **Bug Reports:** If you find any bugs or UI bugs, please open an issue in the **Issues** tab. All code modifications will be executed solely by the original author.
