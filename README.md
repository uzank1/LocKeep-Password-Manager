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

## Diagnosing a Missing Autofill List

Reload the unpacked extension from your browser's extensions page after changing
the extension source, then refresh the affected website once to load the new
page script. If you use the installed desktop app's bundled extension, these
changes must first be included in a new app build, or load this repository's
`extension` folder as the unpacked extension.

When the problem happens again, **do not refresh the website before collecting
the report**:

1. Click the username or password field where the list should appear.
2. Open LocKeep from the browser toolbar and click **Check autofill**
   (**Otomatik doldurmayı kontrol et** in Turkish).
3. Read the findings, then expand **Technical report** and use **Copy report**.
4. If all websites are affected, unlock the desktop vault and repeat the check
   on the same page. Compare the initial cached lookup with the fresh lookup.

The report includes the website hostname, initialization state, account counts,
lookup failure categories, form classification reasons, listener state, the
last 20 field focus/click outcomes, and dropdown visibility. It compares the
page's cached result against a fresh read-only account search without replacing
the cache, filling a field, or retrieving a password. Nothing is uploaded or
persistently logged; the observations live in page memory until navigation.
Only **Copy report** puts the report on the clipboard.

No usernames, passwords, account IDs/titles, input values, raw error messages,
page text, or URL paths/query strings are included. The hostname and counts
are included intentionally to diagnose domain matching.

`stale_empty_cache` means accounts are available now but the page retained an
earlier empty/failed result. `vault_locked` and `native_unavailable` identify
vault/bridge problems. `signup_classification` explains why the form received
the generator instead of the account list. `no_password_field` can describe a
username-first step; these steps now receive the account list when a suitable
username control is found. Frame and Shadow DOM findings describe where forms
are located, rather than proving that they are unsupported. Each matching HTTP(S)
frame receives its own script and uses its own browser-provided origin. Closed
component access uses Chromium's `chrome.dom` API when available. The main-frame
report cannot inspect cross-origin frame internals. Context scanning is bounded
and reports when truncated.

The report is diagnostic evidence; a successful fresh search does not repair
the page's cached state. After unlocking/starting LocKeep, click the login field to
retry an earlier failed/empty lookup without reloading the page. Repeated clicks
are throttled and concurrent lookups are shared.

### Browser Passkey Dropdown Overlap

When LocKeep has matching accounts and attaches its autofill list, it removes
only the `webauthn` autocomplete token from the fields it handles. That token
enables the browser's inline passkey suggestions, including Windows Hello
suggestions in Brave. Username and password autocomplete semantics remain
intact. The guard reapplies if a SPA restores the token. Fields without LocKeep
autofill are untouched, and explicit passkey sign-in remains available.

This targets the inline passkey popup; it does not disable the browser's entire
password manager or erase saved browser credentials. Reload the extension and
the page after updating. The diagnostic report records whether the annotation
was suppressed with `inlinePasskeySuggestionsSuppressed`.

## Browser Compatibility Lab

Run `npm run lab` and open `http://127.0.0.1:4318` for the local browser test
dashboard. It provides 54 repeatable scenarios, from ordinary login and
registration to unusual field names, multiple forms, dynamic pages, overlays,
dialogs, embedded forms, and connection failures. The default simulation uses
the current extension source with sample accounts and an in-memory fake bridge.
Each fixture can also be opened separately to test the actual browser extension.

Run `npm run test:browser` for automated Chromium input, layout, and behavior
checks. Results and screenshots are written to `dist/browser-lab`; compatibility
gaps cause a nonzero exit code and are listed in the report. See
[the lab guide](tests/browser-lab/README.md) for setup, coverage, and real-browser
testing boundaries.

## Publishing an Auto-Update Release

1. Set the new stable version in `package.json`, `package-lock.json`, and
   `extension/manifest.json`.
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
