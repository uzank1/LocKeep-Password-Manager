/**
 * ============================================================================
 * LOCKEEP EXTENSION — Content Script (DOM Injection Layer)
 * ============================================================================
 * Architecture: Browser Extension / Frontend Content Script
 *
 * This script is injected into every web page matching the extension's
 * content_scripts manifest entry. It runs in an isolated world within the
 * page's DOM and communicates with the background service worker
 * (background.js) via chrome.runtime.sendMessage().
 *
 * Responsibilities:
 *   1. Detect login and registration forms by scanning for password/email inputs.
 *   2. For LOGIN forms: show an autofill dropdown populated with vault credentials.
 *   3. For SIGNUP forms: inject a "Generate Strong Password" icon next to
 *      the password field, which calls the native host's password generator.
 *   4. On form submission: offer to save new credentials via a "Save to LocKeep?"
 *      overlay prompt, then forward the entry to the Electron main process.
 *   5. Track usernames across multi-step SPA flows (M-1): send captured
 *      usernames to background.js's in-memory store (never to disk).
 *   6. Provide fully localised UI (en/tr/de) for all injected elements.
 *
 * Data Flow:
 *   Page DOM  ───(this script)───►  background.js  ───►  host.js  ───►  Electron Main
 *
 * Key Design Decisions:
 *   - MutationObserver is always registered before any early-exit guard,
 *     ensuring SPA-rendered inputs are caught without requiring page refreshes.
 *   - Icon positioning uses requestAnimationFrame-based tracking for smooth
 *     CSS-transition-aware placement (replaces the old 200ms setInterval).
 *   - All DOM construction uses createElement() (never innerHTML) to prevent XSS.
 * ============================================================================
 */

'use strict';

// L-4: Master toggle for diagnostic console.log statements.
// Must remain `false` in production to prevent leaking credential counts,
// domain queries, and response data to the browser's DevTools console.
const DEBUG = false;

class LocKeepContentScript {
  constructor() {
    /** Current page hostname (e.g. 'login.github.com'). */
    this.domain = window.location.hostname;
    
    /** @type {Array<{id:string, username:string, title:string, url:string}>} Vault entries matching this domain. */
    this.credentials = [];
    
    /** Absolute URL to the extension's 128px icon (used in save prompt header). */
    this.iconUrl = chrome.runtime.getURL('icons/icon128.png');
    
    /** Absolute URL to the extension's 48px icon (used as small logo references). */
    this.smallIconUrl = chrome.runtime.getURL('icons/icon48.png');
    
    /** @type {HTMLElement|null} Currently visible autofill dropdown element. */
    this.activeDropdown = null;
    
    /** @type {HTMLElement|null} Currently visible "Save Password?" prompt element. */
    this.activePrompt = null;
    
    /** Guard flag: prevents injection before credentials have been fetched from the vault. */
    this._credentialsFetched = false; 
    
    /** Cached language code for synchronous access in injectGenerateIcon (set by resolveLanguage()). */
    this._cachedLang = 'en';          
    
    /**
     * Locked origin URL captured at the first credential interaction.
     * On multi-step SPA flows (e.g. Riot Games), the URL at password-submit time
     * differs from where the user initially typed their email/username.
     * This field preserves the correct URL for the "Save to LocKeep?" prompt.
     * @type {string|null}
     */
    this._sessionUrl = null;          
    
    /**
     * Accumulator buffer for multi-step form credential fields.
     * Used when username and password are collected across separate SPA steps.
     */
    this.authBuffer = {
      username: '',
      password: ''
    };
  }

  // ─── i18n (Internationalisation) ─────────────────────────────────────────
  // Centralised translation dictionary shared by showSavePrompt() and
  // injectGenerateIcon(). Supports English, Turkish, and German.
  // The active language is resolved from the native host via background.js.

  static get i18n() {
    return {
      en: {
        title: "Save to LocKeep?",
        bodyPrefix: "Would you like to securely save this password for ",
        bodySuffix: " in your LocKeep vault?",
        notNow: "Not Now",
        save: "Save Password",
        success: "Saved successfully!",
        error: "LocKeep: Failed to save password. Ensure your vault is unlocked.",
        generateTooltip: "Generate strong password"
      },
      tr: {
        title: "LocKeep'e Kaydet?",
        bodyPrefix: "",
        bodySuffix: " için bu parolayı LocKeep kasanıza güvenle kaydetmek ister misiniz?",
        notNow: "Şimdi Değil",
        save: "Parolayı Kaydet",
        success: "Başarıyla kaydedildi!",
        error: "LocKeep: Parola kaydedilemedi. Kasanızın kilidinin açık olduğundan emin olun.",
        generateTooltip: "Güçlü şifre oluştur"
      },
      de: {
        title: "In LocKeep speichern?",
        bodyPrefix: "Möchten Sie dieses Passwort für ",
        bodySuffix: " sicher in Ihrem LocKeep-Tresor speichern?",
        notNow: "Jetzt nicht",
        save: "Passwort speichern",
        success: "Erfolgreich gespeichert!",
        error: "LocKeep: Passwort konnte nicht gespeichert werden. Stellen Sie sicher, dass Ihr Tresor entsperrt ist.",
        generateTooltip: "Sicheres Passwort generieren"
      }
    };
  }

  /**
   * Resolves the current language from the background service worker (which
   * syncs it from the native host via GET_LANGUAGE). Caches the result in
   * this._cachedLang for synchronous access. Safe to call multiple times.
   *
   * ROOT CAUSE of tooltip always showing Turkish: the app language is stored
   * in the native host and exposed via the background's GET_LANGUAGE handler —
   * it is NOT written to chrome.storage.local. Reading storage directly always
   * returned undefined, causing fallback to browser language (tr-TR → 'tr').
   */
  async resolveLanguage() {
    try {
      // Primary: ask the background worker, which holds the native-host language
      const bgRes = await this.sendMessageToBackground({ type: 'GET_LANGUAGE' });
      if (bgRes && bgRes.success && bgRes.language && LocKeepContentScript.i18n[bgRes.language]) {
        this._cachedLang = bgRes.language;
        return LocKeepContentScript.i18n[this._cachedLang];
      }
    } catch (e) { /* fall through */ }

    try {
      // Fallback: read directly from extension storage (future-proof)
      const storage = await chrome.storage.local.get(['language']);
      if (storage.language && LocKeepContentScript.i18n[storage.language]) {
        this._cachedLang = storage.language;
      } else {
        const browserLang = chrome.i18n.getUILanguage().split('-')[0];
        if (LocKeepContentScript.i18n[browserLang]) this._cachedLang = browserLang;
      }
    } catch (e) { /* keep current cached value */ }
    return LocKeepContentScript.i18n[this._cachedLang];
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async init() {
    // Legacy cleanup: remove old chrome.storage.local entries once
    try {
      await chrome.storage.local.remove(['lockeep_last_username', 'lockeep_last_domain', 'lockeep_last_time']);
    } catch (e) { }

    // BUG-2 FIX: Resolve and cache language early so injectGenerateIcon can use
    // this._cachedLang synchronously without any async delay.
    await this.resolveLanguage();

    // BUG-1 FIX: Check for pending save BEFORE the early exit.
    try {
      const pendingRes = await this.sendMessageToBackground({ type: 'GET_PENDING_SAVE' });
      if (pendingRes && pendingRes.success && pendingRes.data) {
        const pending = pendingRes.data;
        const pendingBase = pending.baseDomain || this.getBaseDomain(pending.domain || '');
        if (pendingBase && pendingBase === this.getBaseDomain(this.domain)) {
          this.showSavePrompt(pending.username, pending.password, pending.url);
        }
      }
    } catch (e) { }

    // ─── Always register ALL persistent listeners BEFORE the early exit ──────
    // The early-exit below fires on SPA pages where inputs haven't rendered yet
    // (e.g. Riot Games step-1 is just an email field — no password). Setting
    // everything up first means the MutationObserver and input tracker are
    // active the moment the SPA renders any field, with zero refreshes needed.
    this.setupSubmissionListeners();
    this._setupMutationObserver();

    // Click outside to close autofill dropdown
    document.addEventListener('click', (e) => {
      if (this.activeDropdown && !this.activeDropdown.contains(e.target)) {
        this.activeDropdown.remove();
        this.activeDropdown = null;
      }
    });

    // ISSUE-2 FIX: Multi-step form username capture + session URL locking.
    // Registered HERE (before the early exit) so it works on SPAs that start
    // without a password field (Riot step-1 = email only; the early exit would
    // have returned before this listener was ever registered, losing the
    // username typed in the username step and the initial page URL).
    document.addEventListener('input', (e) => {
      const target = e.target;
      if (target.tagName !== 'INPUT') return;

      const type = (target.type || '').toLowerCase();
      const name = (target.name || target.id || target.className || '').toLowerCase();

      // Safety guard: never capture values from password-type fields in the
      // username tracker — only text, email, and username-like inputs.
      if (type === 'password' || name.includes('password')) return;

      const isCredentialField =
        name.includes('user') || name.includes('email') || name.includes('login') ||
        type === 'text' || type === 'email';

      if (isCredentialField) {
        // ISSUE-2 FIX: Lock the session URL on the FIRST credential interaction.
        // On multi-step forms (e.g. Riot Games), the URL at password-submit time
        // differs from where the user actually filled in their credentials.
        // Capturing it here (earliest possible moment) preserves the correct URL.
        if (!this._sessionUrl) {
          this._sessionUrl = window.location.href;
        }

        const val = target.value.trim();
        if (val.length > 0) {
          this.sendMessageToBackground({
            type: 'SET_LAST_USERNAME',
            username: val,
            domain: this.getBaseDomain(this.domain)
          }).catch(() => {});
        }
      }
    }, true);

    // P-03: Early exit — if no password or email inputs exist yet, skip initial
    // credential fetch and inject. The MutationObserver registered above will
    // trigger _fetchCredentials + analyzeAndInject once inputs arrive.
    if (!document.querySelector('input[type="password"]') && !document.querySelector('input[type="email"]')) {
      return;
    }

    // Fetch credentials and run initial analysis
    await this._fetchCredentials();
    this._credentialsFetched = true;
    if (!Array.isArray(this.credentials)) this.credentials = [];
    this.analyzeAndInject();
  }

  /**
   * Fetches credentials for the current domain from the background service worker.
   * Extracted so both init() and the MutationObserver can call it independently.
   */
  async _fetchCredentials() {
    try {
      const baseDomain = this.getBaseDomain(this.domain);
      if (DEBUG) console.log(`[DIAGNOSTIC - Content] 1. Requesting credentials for origin: "${window.location.origin}", baseDomain: "${baseDomain}"`);
      const response = await this.sendMessageToBackground({
        type: 'SEARCH_DOMAIN',
        domain: window.location.origin,
        baseDomain: baseDomain
      });
      if (DEBUG) console.log(`[DIAGNOSTIC - Content] 2. Raw Response from Background:`, response);
      if (response && response.success && response.data && Array.isArray(response.data.entries)) {
        if (DEBUG) console.log("LocKeep: Data received for UI:", response.data.entries);
        this.credentials = response.data.entries.filter(entry => {
          const entryDomain = entry.domain || entry.url || '';
          return this.getBaseDomain(entryDomain) === baseDomain;
        });
        // If backend already filtered (filter zeroed out), use all entries
        if (this.credentials.length === 0) {
          this.credentials = response.data.entries;
        }
      } else {
        this.credentials = [];
      }
    } catch (e) {
      this.credentials = [];
    }
  }

  /**
   * BUG-1 FIX: MutationObserver extracted into its own method so it can be
   * registered unconditionally — before the early-exit guard in init().
   *
   * Key behaviour change: when the observer fires and credentials haven't been
   * fetched yet (because init() bailed out early), it fetches them now before
   * calling analyzeAndInject(). This is what eliminates the 3-refresh delay on
   * SPA pages that render inputs after the content script first runs.
   */
  _setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldReanalyze = false;

      mutations.forEach(m => {
        if (m.type === 'childList') {
          // Track removed nodes — clean up icon/listeners for detached inputs
          m.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const inputs = node.tagName === 'INPUT' ? [node] : Array.from(node.querySelectorAll('input'));
              inputs.forEach(inp => {
                inp.removeAttribute('data-lockeep-injected');
                delete inp.dataset.lockeepInjected;
                if (typeof inp._lockeepCleanup === 'function') {
                  inp._lockeepCleanup();
                  delete inp._lockeepCleanup;
                  delete inp._lockeepIcon;
                }
              });
            }
          });

          m.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (
                (node.tagName === 'INPUT' && (node.type === 'password' || node.type === 'email' || node.type === 'text')) ||
                node.querySelector('input')
              ) {
                shouldReanalyze = true;
              }
            }
          });
        } else if (m.type === 'attributes' && m.attributeName === 'type') {
          const target = m.target;
          if (target && target.tagName === 'INPUT' && target.type === 'password') {
            shouldReanalyze = true;
          }
        }
      });

      if (!shouldReanalyze) return;

      // BUG-1 FIX: If the early-exit in init() fired before credentials were fetched,
      // fetch them now on the first mutation that shows us an input field.
      if (!this._credentialsFetched) {
        this._fetchCredentials().then(() => {
          this._credentialsFetched = true;
          if (!Array.isArray(this.credentials)) this.credentials = [];
          this.analyzeAndInject();
        });
      } else {
        this.analyzeAndInject();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // Extracts the base domain from a full hostname.
  // Example: "login.riotgames.com" → "riotgames.com"
  // Used to compare domains across subdomains for credential matching.
  getBaseDomain(hostname) {
    if (!hostname) return '';
    const h = hostname.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().split('?')[0];
    const parts = h.split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return h;
  }

  // Subdomain-tolerant domain comparison.
  // Returns true if the current page's base domain matches the given domain.
  domainMatches(otherDomain) {
    if (!otherDomain) return false;
    return this.getBaseDomain(this.domain) === this.getBaseDomain(otherDomain);
  }

  /**
   * Sends a message to the background service worker and returns the response.
   * Wraps chrome.runtime.sendMessage in a Promise for async/await usage.
   * @param {Object} message - The message object (must include a `type` field)
   * @returns {Promise<Object|null>} The response from the background script
   */
  sendMessageToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(response || null);
      });
    });
  }

  /**
   * BUG-5 FIX: Returns the tightest ancestor element that wraps ONLY this one
   * input (excluding hidden inputs). Walks up at most 3 parent levels.
   *
   * Why: passwordInput.closest('.field') could resolve to a common form-row
   * ancestor that contains BOTH the username and password inputs. Using that
   * element's right edge as the icon's left reference made the icon appear
   * next to the username field. This helper ensures we only use a wrapper that
   * is exclusive to the password input itself.
   */
  getSingleInputWrapper(input) {
    let el = input.parentElement;
    for (let i = 0; i < 3; i++) {
      if (!el || el === document.body) break;
      const inputs = el.querySelectorAll('input:not([type="hidden"])');
      if (inputs.length === 1 && inputs[0] === input) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ─── Core Analysis ─────────────────────────────────────────────────────────

  analyzeAndInject() {
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]'));
    if (DEBUG) console.log(`[DIAGNOSTIC - DOM] 1. Found Password Inputs:`, passwordInputs.length);
    if (passwordInputs.length === 0) return;

    passwordInputs.forEach(passInput => {
      if (passInput.dataset.lockeepInjected) return;
      passInput.dataset.lockeepInjected = 'true';

      const form = passInput.closest('form') || document.body;
      const usernameInput = this.findUsernameInput(form, passInput);
      const isSignup = this.isSignupForm(form, passInput);
      if (DEBUG) console.log(`[DIAGNOSTIC - DOM] 2. Form Analysis:`, { usernameInputFound: !!usernameInput, isSignup, credsCount: this.credentials?.length });

      if (isSignup) {
        // BUG-5 FIX: usernameInput is no longer passed — icon positioning is
        // purely relative to passwordInput via getSingleInputWrapper().
        this.injectGenerateIcon(passInput);
      } else {
        if (usernameInput && Array.isArray(this.credentials) && this.credentials.length > 0) {
          this.setupAutofillDropdown(usernameInput, passInput);
        }
      }
    });
  }

  // Shared helper: locates the username input field nearest to a password input.
  // Tries selectors in priority order: email, identifier, user*, email*, login*, text.
  findUsernameInput(form, passwordInput = null) {
    const selectors = [
      'input[type="email"]:not([hidden])',
      'input[name="identifier"]:not([hidden])',
      'input[name*="user"]:not([hidden])',
      'input[name*="email"]:not([hidden])',
      'input[name*="login"]:not([hidden])',
      'input[type="text"]:not([hidden])',
    ];
    for (const sel of selectors) {
      const elements = form.querySelectorAll(sel);
      for (const el of elements) {
        if (passwordInput && el === passwordInput) continue;
        if (el.type === 'password') continue;
        return el;
      }
    }
    return null;
  }

  /**
   * Heuristically determines whether a form is a signup/registration form.
   * Checks: multiple password inputs, form action/id/name keywords, and
   * individual input attributes. Defaults to false (login) when ambiguous.
   * @param {HTMLElement} form - The form element (or document.body if none)
   * @param {HTMLInputElement} passwordInput - The password field being analysed
   * @returns {boolean}
   */
  isSignupForm(form, passwordInput) {
    if (!form || form === document.body) {
      if (passwordInput) {
        const inputAttr = `${passwordInput.id || ''} ${passwordInput.name || ''}`.toLowerCase();
        if (/(new|signup|register)/i.test(inputAttr)) return true;
      }
      const allPass = document.querySelectorAll('input[type="password"]');
      if (allPass.length > 1) return true;
      return false;
    }

    const passwordInputs = form.querySelectorAll('input[type="password"]');
    if (passwordInputs.length > 1) return true;

    const formAttr = `${form.id || ''} ${form.name || ''} ${form.action || ''}`.toLowerCase();
    if (/(signup|register|join|create|new)/i.test(formAttr)) {
      if (!/(login|signin|sign-in|auth)/i.test(formAttr)) {
        return true;
      }
    }

    if (passwordInput) {
      const inputAttr = `${passwordInput.id || ''} ${passwordInput.name || ''}`.toLowerCase();
      if (/(new|signup|register)/i.test(inputAttr)) return true;
    }

    return false;
  }

  // ─── Autofill Dropdown ─────────────────────────────────────────────────────

  setupAutofillDropdown(usernameInput, passwordInput) {
    const showDropdown = (e) => {
      if (e) e.stopPropagation();

      // If dropdown is already active, just return to prevent flicker
      if (this.activeDropdown) return;

      const credentials = Array.isArray(this.credentials) ? this.credentials : [];
      if (credentials.length === 0) return;

      const rect = usernameInput.getBoundingClientRect();
      const dropdown = document.createElement('div');
      dropdown.className = 'lockeep-dropdown';
      // position:fixed → coordinates relative to viewport, no scroll offset needed
      dropdown.style.top = `${rect.bottom + 5}px`;
      dropdown.style.left = `${rect.left}px`;
      dropdown.style.minWidth = `${rect.width}px`;

      credentials.forEach(cred => {
        const item = document.createElement('div');
        item.className = 'lockeep-dropdown-item';

        const userSpan = document.createElement('span');
        userSpan.className = 'lockeep-dropdown-username';
        userSpan.textContent = cred.username;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'lockeep-dropdown-title';
        titleSpan.textContent = cred.title || 'LocKeep Vault';

        item.appendChild(userSpan);
        item.appendChild(titleSpan);

        item.addEventListener('mousedown', async (e) => {
          // FIX: Use mousedown + preventDefault to prevent the input losing focus
          // before the click registers, which previously caused the dropdown to
          // close via the document click listener before the item could be selected.
          e.preventDefault();
          e.stopPropagation();

          let passwordToFill = cred.password;
          if (!passwordToFill && cred.id) {
            const detailRes = await this.sendMessageToBackground({ type: 'GET_CREDENTIAL', id: cred.id });
            if (detailRes && detailRes.success) {
              const resData = detailRes.data || {};
              passwordToFill = (resData.entry && resData.entry.password) || resData.password || detailRes.password;
            }
          }

          if (usernameInput) {
            usernameInput.value = cred.username;
            usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
            usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          if (passwordToFill && passwordInput) {
            passwordInput.value = passwordToFill;
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          dropdown.remove();
          this.activeDropdown = null;
        });

        dropdown.appendChild(item);
      });

      document.body.appendChild(dropdown);
      this.activeDropdown = dropdown;
    };

    // FIX: Listen to both 'focus' and 'click' — 'focus' alone misses the case
    // where the input is already focused when the page loads (e.g. autofocused inputs).
    usernameInput.addEventListener('focus', showDropdown);
    usernameInput.addEventListener('click', showDropdown);
  }

  // ─── Generate Icon ─────────────────────────────────────────────────────────

  /**
   * BUG-5 FIX: usernameInput parameter removed — icon positioning is now
   * purely relative to passwordInput using getSingleInputWrapper().
   */
  injectGenerateIcon(passwordInput) {
    // BUG-5 FIX: Tightened confirm-field detection — check aria-label and
    // placeholder in addition to name/id, covering more SPA patterns.
    const confirmAttrs = [
      passwordInput.name,
      passwordInput.id,
      passwordInput.placeholder,
      passwordInput.getAttribute('aria-label')
    ].filter(Boolean).join(' ');
    const isConfirm = /(confirm|onayla|re-?enter|repeat|tekrar|again)/i.test(confirmAttrs);

    // BUG-5 FIX: Only count truly visible password inputs (non-zero dimensions).
    // Some SPAs pre-render hidden password fields (offsetWidth/Height = 0) that
    // would otherwise shift the indexOf check and suppress the icon on the real field.
    const getVisiblePassInputs = () => {
      return Array.from(document.querySelectorAll('input[type="password"]'))
        .filter(inp => inp.offsetParent !== null && inp.offsetWidth > 0 && inp.offsetHeight > 0);
    };

    const allPassInputs = getVisiblePassInputs();
    if (isConfirm || allPassInputs.indexOf(passwordInput) > 0) return;

    // BUG-2 FIX: Use the cached language to get the localised tooltip.
    // this._cachedLang was populated by resolveLanguage() during init().
    const t = LocKeepContentScript.i18n[this._cachedLang] || LocKeepContentScript.i18n.en;

    const icon = document.createElement('div');
    icon.className = 'lockeep-generate-icon';
    icon.title = t.generateTooltip;  // ← localised, no longer hardcoded Turkish
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
    `;

    // BUG-3 FIX: Only force position: absolute inline — let the CSS class
    // (.lockeep-generate-icon { z-index: 9999 }) control stacking order.
    // The previous `z-index: 999999 !important` inline style caused the icon
    // to render on top of native page dropdowns (which use ~10000). At 9999
    // the icon floats above normal content but yields to page dropdowns,
    // while the LocKeep autofill dropdown (z-index: 2147483647) still wins.
    icon.style.setProperty('position', 'absolute', 'important');

    // Clean up any stale ghost icon / listeners from a previous injection attempt
    if (typeof passwordInput._lockeepCleanup === 'function') {
      passwordInput._lockeepCleanup();
    }

    // ─── BUG-4 FIX: rAF-based position tracking ────────────────────────────
    // requestAnimationFrame gives frame-accurate updates during CSS transitions
    // and JS-driven animations — something a 200ms setInterval cannot do.
    // The loop runs for RAF_MAX_FRAMES frames (~1.5 s) then stops to save CPU.
    // It is re-triggered on focus to handle "animate-on-focus" inputs (e.g. Riot).
    // Position is only written to the DOM when it actually changes, reducing
    // unnecessary layout recalculations.
    let _rafHandle = null;
    let _lastTop = null;
    let _lastLeft = null;
    const RAF_MAX_FRAMES = 90; // ~1.5 s at 60 fps

    // BUG-5 FIX: Use getSingleInputWrapper instead of .closest('.field') to
    // ensure we only use a wrapper that is exclusive to this password input.
    const _getWidthRef = () => {
      const wrapper = this.getSingleInputWrapper(passwordInput);
      return wrapper ? wrapper.getBoundingClientRect() : passwordInput.getBoundingClientRect();
    };

    const positionIcon = () => {
      const inputRect = passwordInput.getBoundingClientRect();

      if (inputRect.width <= 0 || inputRect.height <= 0) {
        icon.style.display = 'none';
        return;
      }

      icon.style.display = 'flex';

      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
      const widthRect = _getWidthRef();

      const newTop = scrollTop + inputRect.top + (inputRect.height / 2);
      const newLeft = scrollLeft + widthRect.left + widthRect.width + 4;

      // Only write to DOM when position actually changed (avoids layout thrash)
      if (newTop !== _lastTop || newLeft !== _lastLeft) {
        icon.style.top = newTop + 'px';
        icon.style.left = newLeft + 'px';
        _lastTop = newTop;
        _lastLeft = newLeft;
      }
    };

    const startRafTracking = () => {
      if (_rafHandle !== null) cancelAnimationFrame(_rafHandle);
      let frames = 0;
      const track = () => {
        positionIcon();
        frames++;
        if (frames < RAF_MAX_FRAMES) {
          _rafHandle = requestAnimationFrame(track);
        } else {
          _rafHandle = null;
        }
      };
      _rafHandle = requestAnimationFrame(track);
    };

    // Append icon to body and start rAF tracking immediately
    document.body.appendChild(icon);
    startRafTracking();

    // Steady-state position updaters (after the rAF loop ends)
    const resizeObserver = new ResizeObserver(() => positionIcon());
    resizeObserver.observe(passwordInput);
    const wrapperEl = this.getSingleInputWrapper(passwordInput) || passwordInput.parentElement;
    if (wrapperEl) resizeObserver.observe(wrapperEl);

    window.addEventListener('resize', positionIcon);
    window.addEventListener('scroll', positionIcon, true);

    const handleFocus = () => {
      positionIcon();
      startRafTracking(); // Re-trigger rAF loop to catch animate-on-focus transitions
    };
    passwordInput.addEventListener('focus', handleFocus);

    const cleanup = () => {
      if (_rafHandle !== null) {
        cancelAnimationFrame(_rafHandle);
        _rafHandle = null;
      }
      window.removeEventListener('resize', positionIcon);
      window.removeEventListener('scroll', positionIcon, true);
      passwordInput.removeEventListener('focus', handleFocus);
      resizeObserver.disconnect();
      icon.remove();
    };

    passwordInput._lockeepCleanup = cleanup;
    passwordInput._lockeepIcon = icon;

    // Password generation click handler: requests a strong password from the
    // native host and fills all visible password inputs on the page with it.
    icon.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await this.sendMessageToBackground({ type: 'GENERATE_PASSWORD' });
      if (res && res.success && res.data && res.data.password) {
        const generatedPassword = res.data.password;
        getVisiblePassInputs().forEach(inp => {
          inp.value = generatedPassword;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    });
  }

  // ─── Form Submission ───────────────────────────────────────────────────────

  setupSubmissionListeners() {
    let lastSubmitTime = 0;
    let lastSubmitUser = '';
    let lastSubmitPass = '';

    // BUG-3 FIX: handleSubmit now accepts optional pre-captured values.
    const handleSubmit = async (formElement, capturedUsername, capturedPassword) => {
      if (!formElement) return;

      let password = capturedPassword;
      let username = capturedUsername;

      // If values weren't pre-captured (native submit), read from DOM
      if (password === undefined) {
        const passwordInput = formElement.querySelector('input[type="password"]');
        if (!passwordInput || !passwordInput.value) return;
        password = passwordInput.value;
        const usernameInput = this.findUsernameInput(formElement, passwordInput);
        username = usernameInput ? usernameInput.value.trim() : '';
      }

      // Safety: if password was accidentally captured as username, discard
      if (username === password) username = '';

      // In-memory username fallback: if the page's DOM doesn't contain a
      // username input (common in multi-step SPA flows), retrieve the last
      // captured username from background.js's in-memory store (M-1).
      // This value is validated against the current domain and a 15-minute TTL.
      if (!username) {
        const res = await this.sendMessageToBackground({ type: 'GET_LAST_USERNAME' });
        if (
          res &&
          res.success &&
          res.username &&
          this.getBaseDomain(res.domain) === this.getBaseDomain(this.domain) &&
          Date.now() - res.time < 15 * 60 * 1000
        ) {
          username = res.username;
        }
      }

      // Deduplicate rapid submissions (e.g., click + submit event within 1 second)
      const now = Date.now();
      if (username === lastSubmitUser && password === lastSubmitPass && (now - lastSubmitTime < 1000)) return;
      lastSubmitUser = username;
      lastSubmitPass = password;
      lastSubmitTime = now;

      const isKnown = Array.isArray(this.credentials) && this.credentials.some(c => c.username === username);

      if (!isKnown && password.length >= 4) {
        // ISSUE-2 FIX: Use the session URL locked at first credential interaction
        // rather than window.location.origin at submission time, which may differ
        // on multi-step / redirect flows (e.g. authenticate.riotgames.com →
        // accounts.riotgames.com). Fall back to current origin if never locked.
        let loginOrigin = window.location.origin;
        if (this._sessionUrl) {
          try { loginOrigin = new URL(this._sessionUrl).origin; } catch (e) { }
        }
        const loginDomain = (() => {
          try { return new URL(loginOrigin).hostname; } catch { return this.domain; }
        })();
        this.sendMessageToBackground({
          type: 'SET_PENDING_SAVE',
          entry: {
            domain: loginDomain,
            baseDomain: this.getBaseDomain(loginDomain),
            url: loginOrigin,
            username,
            password
          }
        });
        this.showSavePrompt(username, password, loginOrigin);
      }
    };

    // 1. Native form submissions
    document.addEventListener('submit', (e) => {
      handleSubmit(e.target);
    });

    // 2. JS-driven form submissions (listening to button clicks)
    // BUG-3 FIX: Capture input values SYNCHRONOUSLY at click time.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, input[type="submit"], input[type="button"]');
      if (!btn) return;
      if (btn.closest('.lockeep-save-prompt')) return;

      const text = (btn.textContent || btn.value || '').toLowerCase();
      const isSubmitType = btn.type === 'submit';
      const isLoginOrRegister = /(login|sign in|giriş yap|register|sign up|kaydol)/i.test(text);

      if (isSubmitType || isLoginOrRegister) {
        const form = btn.closest('form') || document.body;
        const passwordInput = form.querySelector('input[type="password"]');
        if (!passwordInput || !passwordInput.value) return;
        const capturedPassword = passwordInput.value;
        const usernameInput = this.findUsernameInput(form, passwordInput);
        const capturedUsername = usernameInput ? usernameInput.value.trim() : '';
        handleSubmit(form, capturedUsername, capturedPassword);
      }
    });
  }

  // ─── Save Prompt ───────────────────────────────────────────────────────────

  async showSavePrompt(username, password, loginUrl) {
    // BUG-2 FIX: Use resolveLanguage() — reads from the centralised i18n table
    const t = await this.resolveLanguage();

    let saveUrl = loginUrl || window.location.origin;
    try { saveUrl = new URL(saveUrl).origin; } catch (e) { }
    const saveDomain = (() => {
      try { return new URL(saveUrl).hostname; } catch { return this.domain; }
    })();

    if (this.activePrompt) this.activePrompt.remove();

    // M-05: Safe DOM construction instead of innerHTML to prevent XSS
    const prompt = document.createElement('div');
    prompt.className = 'lockeep-save-prompt';

    // Header
    const header = document.createElement('div');
    header.className = 'lockeep-save-prompt-header';
    const logo = document.createElement('img');
    logo.src = this.iconUrl;
    logo.className = 'lockeep-save-prompt-logo';
    logo.alt = 'LocKeep';
    const titleEl = document.createElement('h3');
    titleEl.className = 'lockeep-save-prompt-title';
    titleEl.textContent = t.title;
    header.appendChild(logo);
    header.appendChild(titleEl);

    // Body
    const body = document.createElement('div');
    body.className = 'lockeep-save-prompt-body';
    body.appendChild(document.createTextNode(t.bodyPrefix));
    const domainStrong = document.createElement('strong');
    domainStrong.textContent = saveDomain;
    body.appendChild(domainStrong);
    body.appendChild(document.createTextNode(t.bodySuffix));

    // Actions
    const actions = document.createElement('div');
    actions.className = 'lockeep-save-prompt-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'lockeep-btn lockeep-btn-secondary';
    cancelBtn.textContent = t.notNow;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'lockeep-btn lockeep-btn-primary';
    saveBtn.textContent = t.save;
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    prompt.appendChild(header);
    prompt.appendChild(body);
    prompt.appendChild(actions);

    document.body.appendChild(prompt);
    this.activePrompt = prompt;

    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.sendMessageToBackground({ type: 'CLEAR_PENDING_SAVE' });
      prompt.remove();
      this.activePrompt = null;
    });

    saveBtn.addEventListener('click', async (e) => {
      e.preventDefault();

      // ISSUE-2 FIX: Use saveUrl (derived from loginUrl passed into this method)
      // NOT window.location.origin. On redirect flows the current URL has already
      // changed to the post-auth domain by the time the user clicks Save.
      const newEntry = {
        title: document.title || saveDomain,
        url: saveUrl,
        domain: saveUrl,
        username: username,
        password: password,
        category: 'Login',
        notes: 'Saved from browser extension'
      };

      const res = await this.sendMessageToBackground({
        type: 'ADD_ENTRY',
        entry: newEntry
      });

      if (res && res.success) {
        // M-05: Safe DOM construction for success message
        prompt.innerHTML = '';
        const successHeader = document.createElement('div');
        successHeader.className = 'lockeep-save-prompt-header';
        const successLogo = document.createElement('img');
        successLogo.src = this.iconUrl;
        successLogo.className = 'lockeep-save-prompt-logo';
        successLogo.alt = 'LocKeep';
        const successTitle = document.createElement('h3');
        successTitle.className = 'lockeep-save-prompt-title';
        successTitle.textContent = t.success;
        successHeader.appendChild(successLogo);
        successHeader.appendChild(successTitle);
        prompt.appendChild(successHeader);
        setTimeout(() => {
          if (this.activePrompt === prompt) {
            prompt.remove();
            this.activePrompt = null;
          }
        }, 2000);
      } else {
        alert(t.error);
        prompt.remove();
        this.activePrompt = null;
      }
    });
  }
}

// Initialize script
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new LocKeepContentScript().init());
} else {
  new LocKeepContentScript().init();
}