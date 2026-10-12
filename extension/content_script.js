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
 *   - Shared visual tracking follows layout changes, hides covered controls,
 *     and keeps native-dialog controls in their own top-layer context.
 *   - All DOM construction uses createElement() (never innerHTML) to prevent XSS.
 * ============================================================================
 */

'use strict';

// L-4: Master toggle for diagnostic console.log statements.
// Must remain `false` in production to prevent leaking credential counts,
// domain queries, and response data to the browser's DevTools console.
const DEBUG = false;

const AutofillDiagnostics = typeof module !== 'undefined' && module.exports
  ? require('./autofill_diagnostics')
  : globalThis.LocKeepAutofillDiagnostics;

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

    /**
     * Timestamp of the last real user gesture seen by this isolated script.
     * We use it as a small safety rail so page scripts cannot open/fill the
     * autofill menu with synthetic DOM events while normal clicks and keyboard
     * navigation keep working exactly as users expect.
     */
    this._lastTrustedUserAction = 0;
    
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
      password: '',
      capturedAt: 0,
      awaitingCompletion: false
    };

    /** Tracks multi-step registration flows whose password step appears later. */
    this._authFlowMode = null;
    this._authFlowModeTime = 0;

    this._floatingViews = new Map();

    this.diagnostics = new AutofillDiagnostics(this);
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
    // Available even if initialization stalls before form listeners are ready.
    this.diagnostics.register();
    this.diagnostics.phase = 'initializing';
    // Legacy cleanup: remove old chrome.storage.local entries once
    try {
      await chrome.storage.local.remove(['lockeep_last_username', 'lockeep_last_domain', 'lockeep_last_time']);
    } catch (e) { }

    // BUG-2 FIX: Resolve and cache language early so injectGenerateIcon can use
    // this._cachedLang synchronously without any async delay.
    await this.resolveLanguage();
    await this.syncAuthFlowModeFromBackground();
    this.captureAuthFlowContext();

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

    // Keep a short-lived record of genuine user input. Focus events can be
    // caused by scripts on some pages, so the autofill menu only trusts focus
    // when it follows a real pointer or keyboard action.
    const rememberTrustedUserAction = (e) => {
      if (e && e.isTrusted) this._lastTrustedUserAction = Date.now();
      if (e && e.target && e.target._lockeepAutofillListener) {
        this.suppressInlinePasskeySuggestions(e.target);
      }
      const input = e?.composedPath?.()[0] || e?.target;
      if (e?.isTrusted && this.isUsernameControl(input)) this.retryCredentialsOnInteraction(e, input);
    };
    this._rememberTrustedAction = rememberTrustedUserAction;
    document.addEventListener('pointerdown', rememberTrustedUserAction, true);
    document.addEventListener('keydown', rememberTrustedUserAction, true);

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
    this._captureUsername = (e) => {
      const target = e.composedPath?.()[0] || e.target;
      if (!this.isUsernameControl(target)) return;
      this.captureAuthFlowContext(target);

      const type = (target.type || '').toLowerCase();
      // Only the selected, visible username control may populate the fallback.
      // Coupons, one-time codes and text-based password controls are excluded.
      const isCredentialField = !this.isPasswordLikeInput(target) &&
        target === this.findUsernameInput(this.getFieldScope(target));

      if (isCredentialField) {
        // ISSUE-2 FIX: Lock the session URL on the FIRST credential interaction.
        // On multi-step forms (e.g. Riot Games), the URL at password-submit time
        // differs from where the user actually filled in their credentials.
        // Capturing it here (earliest possible moment) preserves the correct URL.
        if (!this._sessionUrl) {
          this._sessionUrl = window.location.href;
        }

        const val = this.getFieldValue(target).trim();
        if (val.length > 0) {
          this.sendMessageToBackground({
            type: 'SET_LAST_USERNAME',
            username: val,
            domain: this.getBaseDomain(this.domain)
          }).catch(() => {});
        }
      }
    };
    document.addEventListener('input', this._captureUsername, true);

    document.addEventListener('click', (e) => {
      if (e && e.isTrusted) this.captureAuthFlowContext(e.target, { fromClick: true });
    }, true);

    // Skip the initial lookup when neither password nor username controls exist.
    // credential fetch and inject. The MutationObserver registered above will
    // trigger _fetchCredentials + analyzeAndInject once inputs arrive.
    if (this.getPasswordInputs(document).length === 0 && !this.findUsernameInput(document)) {
      this.diagnostics.phase = 'waiting_for_inputs';
      return;
    }

    // Fetch credentials and run initial analysis
    await this._fetchCredentials();
    this._credentialsFetched = true;
    if (!Array.isArray(this.credentials)) this.credentials = [];
    this.analyzeAndInject();
    this.diagnostics.phase = 'ready';
  }

  /**
   * Fetches credentials for the current domain from the background service worker.
   * Extracted so both init() and the MutationObserver can call it independently.
   */
  async _fetchCredentials() {
    if (this._credentialFetch) return this._credentialFetch;
    this._credentialFetch = this.fetchCredentialsOnce();
    try { return await this._credentialFetch; }
    finally { this._credentialFetch = null; }
  }

  async fetchCredentialsOnce() {
    this.diagnostics.fetchAttempts++;
    const startedAt = Date.now();
    const result = await this._queryCredentials();
    this.credentials = result.entries;
    this.diagnostics.lastFetch = {
      at: Date.now(), durationMs: Date.now() - startedAt,
      status: result.status, count: result.entries.length, lookups: result.lookups
    };
  }

  async retryCredentialsOnInteraction(event, target = event.target) {
    if (!this.isInputVisible(target) || (!this.isPasswordLikeInput(target) &&
        target !== this.findUsernameInput(this.getFieldScope(target)))) return;
    if (this.credentials.length || !this._credentialsFetched) return;
    const retryDelay = this.diagnostics.lastFetch?.status === 'ok' ? 10000 : 1000;
    if (Date.now() - (this._lastCredentialRetry || 0) < retryDelay) return;
    this._lastCredentialRetry = Date.now();
    await this._fetchCredentials();
    this.analyzeAndInject();
    if (target.isConnected && target.getRootNode().activeElement === target && this.hasRecentTrustedUserAction()) {
      target._lockeepShowDropdown?.(event, target);
    }
  }

  // Shared by normal autofill and the read-only diagnostic probe. The probe
  // must not refresh the page's cache or hide an intermittent failure.
  async _queryCredentials() {
    const lookups = [];
    let entries = [];
    let failureStatus = null;
    try {
      const lookupOrigins = this.getCredentialLookupOrigins();

      for (const lookupOrigin of lookupOrigins) {
        const baseDomain = this.getBaseDomain(lookupOrigin);
        if (DEBUG) console.log(`[DIAGNOSTIC - Content] 1. Requesting credentials for origin: "${lookupOrigin}", baseDomain: "${baseDomain}"`);
        const response = await this.sendMessageToBackground({
          type: 'SEARCH_DOMAIN',
          domain: lookupOrigin,
          baseDomain: baseDomain
        });
        if (DEBUG) console.log(`[DIAGNOSTIC - Content] 2. Raw Response from Background:`, response);
        const status = AutofillDiagnostics.lookupStatus(response);
        const lookup = { host: new URL(lookupOrigin).hostname, status, returnedCount: 0, selectedCount: 0 };
        lookups.push(lookup);
        if (status !== 'ok') {
          failureStatus = failureStatus || status;
          continue;
        }

        if (DEBUG) console.log("LocKeep: Data received for UI:", response.data.entries);
        lookup.returnedCount = response.data.entries.length;
        const uniqueEntries = this.dedupeCredentials(response.data.entries);
        if (this.isGoogleAccountsSignin() && lookupOrigin === window.location.origin) {
          const exactHost = window.location.hostname.toLowerCase();
          const exactHostEntries = uniqueEntries.filter(entry =>
            this.getCredentialEntryHost(entry) === exactHost
          );
          if (exactHostEntries.length > 0) {
            entries = exactHostEntries;
            lookup.selectedCount = entries.length;
            break;
          }

          // Parent-domain entries can be included in an exact-host query by
          // the vault's safe subdomain matching. Ignore them here so the next
          // lookup can perform the intentional Google compatibility fallback.
          continue;
        }

        const domainMatches = uniqueEntries.filter(entry => {
          const entryDomain = entry.domain || entry.url || '';
          return this.getBaseDomain(entryDomain) === baseDomain;
        });

        // If the backend already applied a stricter origin filter, keep its
        // result instead of discarding it because of a missing legacy field.
        entries = domainMatches.length > 0 ? domainMatches : uniqueEntries;
        lookup.selectedCount = entries.length;
        if (entries.length > 0) break;
      }
      return { entries, lookups, status: entries.length > 0 ? 'ok' : (failureStatus || 'ok') };
    } catch (e) {
      return { entries: [], lookups, status: AutofillDiagnostics.errorStatus(e) };
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
      this.scheduleFloatingViews();
      this.checkSubmissionFailure();
      let shouldReanalyze = false;

      mutations.forEach(m => {
        if (m.type === 'childList') {
          // Track removed nodes — clean up icon/listeners for detached inputs
          m.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const inputs = this.isUsernameControl(node) ? [node] : this.getInputs(node);
              inputs.forEach(inp => {
                if (inp.isConnected) return;
                inp._lockeepAutofillCleanup?.();
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
                this.isUsernameControl(node) ||
                this.getInputs(node).length || this.getShadowRoot(node)
              ) {
                shouldReanalyze = true;
              }
            }
          });
        } else if (m.type === 'attributes' && m.attributeName === 'autocomplete') {
          // SPAs can restore the WebAuthn autofill annotation after injection.
          // Keep the inline passkey menu out of fields handled by LocKeep.
          if (m.target && m.target._lockeepAutofillListener) {
            this.suppressInlinePasskeySuggestions(m.target);
          }
          shouldReanalyze = true;
        } else if (m.type === 'attributes' && m.attributeName === 'type') {
          const target = m.target;
          if (target && target.tagName === 'INPUT' && target.type === 'password') {
            shouldReanalyze = true;
          }
        } else if (m.type === 'attributes' && !m.target.closest('.lockeep-generate-icon, .lockeep-dropdown, .lockeep-save-prompt') &&
            (this.isUsernameControl(m.target) || this.getInputs(m.target).length)) {
          shouldReanalyze = true;
        }
      });

      if (!shouldReanalyze) return;
      this.captureAuthFlowContext();

      // BUG-1 FIX: If the early-exit in init() fired before credentials were fetched,
      // fetch them now on the first mutation that shows us an input field.
      if (!this._credentialsFetched) {
        this._fetchCredentials().then(() => {
          this._credentialsFetched = true;
          if (!Array.isArray(this.credentials)) this.credentials = [];
          this.analyzeAndInject();
          this.diagnostics.phase = 'ready';
        });
      } else {
        this.analyzeAndInject();
      }
    });

    this._formObserver = observer;
    this._observedRoots = new WeakSet();
    this.observeFormRoot(document.body);
    this.diagnostics.observerActive = true;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  observeFormRoot(root) {
    if (!this._formObserver || this._observedRoots.has(root)) return;
    this._observedRoots.add(root);
    this._formObserver.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['type', 'autocomplete', 'class', 'style', 'hidden', 'open', 'aria-invalid', 'role'] });
    if (root.host) {
      this._shadowRoots ||= new Set();
      this._shadowRoots.add(root);
      // Submit does not cross a component boundary. Closed components also
      // retarget composed input/pointer events outside the root.
      if (this._handleSubmitEvent) root.addEventListener('submit', this._handleSubmitEvent);
      if (root.mode === 'closed') {
        if (this._handleSubmitClick) root.addEventListener('click', this._handleSubmitClick, true);
        if (this._captureUsername) root.addEventListener('input', this._captureUsername, true);
        if (this._rememberTrustedAction) {
          root.addEventListener('pointerdown', this._rememberTrustedAction, true);
          root.addEventListener('keydown', this._rememberTrustedAction, true);
        }
      }
    }
  }

  getShadowRoot(element) {
    if (element.shadowRoot) return element.shadowRoot;
    // Supported Chromium extension API. No page-world attachShadow patching
    // or prototype interception is needed; unavailable APIs simply yield null.
    try { return chrome.dom?.openOrClosedShadowRoot?.(element) || null; }
    catch { return null; }
  }

  isUsernameControl(element) {
    return element && (element.tagName === 'INPUT' || element.isContentEditable && element.getAttribute('role') === 'textbox');
  }

  getFieldValue(element) {
    return element.isContentEditable ? element.textContent || '' : element.value || '';
  }

  setFieldValue(element, value) {
    if (element.isContentEditable) element.textContent = value;
    else {
      // Chromium's editing command emits the browser's actual InputEvent. Some
      // controlled forms ignore a plain synthetic Event('input'). No clipboard
      // operation or key simulation is involved. Use the native setter fallback
      // if editing is unavailable, cancelled, or transformed by the page.
      const previousFocus = element.getRootNode().activeElement;
      let edited = false;
      try {
        element.focus({ preventScroll: true });
        element.select();
        edited = document.execCommand('insertText', false, value) && element.value === value;
      } catch { /* unsupported editing path */ }
      if (!edited) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
      }
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      if (previousFocus?.isConnected && previousFocus !== element) previousFocus.focus({ preventScroll: true });
      return;
    }
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  getFloatingHost(anchor) {
    // Native dialogs/popovers are in the browser's top layer. A body child
    // cannot be painted above them, regardless of its z-index.
    let element = anchor;
    while (element && element !== document.body) {
      if (element.matches && (element.matches('dialog[open]') ||
          element.matches('[popover]') && element.matches(':popover-open'))) return element;
      element = element.parentElement || element.getRootNode?.().host;
    }
    return document.body;
  }

  getViewport() {
    const viewport = window.visualViewport;
    return { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
      width: viewport?.width || document.documentElement.clientWidth,
      height: viewport?.height || document.documentElement.clientHeight };
  }

  setFloatingStyle(element, property, value, priority = '') {
    if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== priority) {
      element.style.setProperty(property, value, priority);
    }
  }

  isAnchorExposed(anchor) {
    if (!anchor.isConnected || !this.isInputVisible(anchor)) return false;
    const rect = anchor.getBoundingClientRect();
    const viewport = this.getViewport();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < viewport.left || y < viewport.top || x >= viewport.left + viewport.width || y >= viewport.top + viewport.height) return false;
    const root = anchor.getRootNode();
    const hits = (root.elementsFromPoint ? root : document).elementsFromPoint(x, y);
    const hit = hits.find(element => !element.closest?.('.lockeep-generate-icon, .lockeep-dropdown'));
    return hit === anchor || anchor.contains(hit);
  }

  isFloatingPointExposed(anchor, x, y) {
    const root = anchor.getRootNode();
    const hits = (root.elementsFromPoint ? root : document).elementsFromPoint(x, y);
    const hit = hits.find(element => !element.closest?.('.lockeep-generate-icon, .lockeep-dropdown'));
    if (!hit) return false;
    for (let node = anchor; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node === hit) return true;
    }
    return anchor.contains(hit);
  }

  scheduleFloatingViews() {
    if (!this._floatingViews.size || this._floatingFrame) return;
    this._floatingFrame = requestAnimationFrame(() => {
      this._floatingFrame = null;
      this.updateFloatingViews();
    });
  }

  updateFloatingViews() {
    for (const [element, view] of this._floatingViews) {
      if (!element.isConnected || !view.anchor.isConnected) {
        element.remove();
        this._floatingViews.delete(element);
        if (this.activeDropdown === element) this.activeDropdown = null;
        continue;
      }
      const host = this.getFloatingHost(view.anchor);
      if (element.parentElement !== host) host.appendChild(element);
      view.position(this.isAnchorExposed(view.anchor));
    }
    if (!this._floatingViews.size && this._floatingTimer) {
      clearInterval(this._floatingTimer);
      this._floatingTimer = null;
    }
  }

  trackFloatingView(element, anchor, position) {
    this.getFloatingHost(anchor).appendChild(element);
    this._floatingViews.set(element, { anchor, position });
    if (!this._floatingTimer) {
      // Position can change without an input resizing or a DOM mutation (CSS
      // animation/layout). One shared, bounded-rate check covers those cases.
      this._floatingTimer = setInterval(() => this.updateFloatingViews(), 150);
    }
    if (!this._floatingListeners) {
      this._floatingListeners = true;
      const update = () => this.scheduleFloatingViews();
      window.addEventListener('scroll', update, true);
      window.addEventListener('resize', update);
      window.visualViewport?.addEventListener('resize', update);
      window.visualViewport?.addEventListener('scroll', update);
      document.addEventListener('transitionrun', update, true);
    }
    this.updateFloatingViews();
  }

  // Extracts the base domain from a full hostname.
  // Example: "login.riotgames.com" → "riotgames.com"
  // Used to compare domains across subdomains for credential matching.
  getBaseDomain(hostname) {
    if (!hostname) return '';
    let h = String(hostname).trim().toLowerCase();
    try {
      // URL parsing keeps paths and query strings out of the hostname. That
      // matters for entries saved as full login URLs such as /signin or /auth.
      h = new URL(h.includes('://') ? h : `https://${h}`).hostname.toLowerCase();
    } catch {
      h = h.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
    }
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

  isGoogleAccountsSignin() {
    const host = (window.location.hostname || '').toLowerCase();
    const path = (window.location.pathname || '').toLowerCase();
    return host === 'accounts.google.com' && /\/(?:v\d+\/)?signin\//.test(path);
  }

  getCredentialLookupOrigin() {
    // Google collects Gmail credentials on accounts.google.com, while users
    // usually save entries for mail.google.com or google.com. Query the Google
    // parent domain only for the real Google sign-in host so sibling Google
    // login pages can find the saved Gmail entry without broadening matching
    // rules for unrelated websites.
    if (this.isGoogleAccountsSignin()) return 'https://google.com';
    return window.location.origin;
  }

  getCredentialLookupOrigins() {
    const fallbackOrigin = this.getCredentialLookupOrigin();
    if (!this.isGoogleAccountsSignin()) return [fallbackOrigin];

    // Prefer credentials saved for the actual Google sign-in host. Only use
    // the parent-domain lookup when no exact-host entry exists, which keeps
    // accounts.google.com and mail.google.com copies out of the same dropdown.
    const exactOrigin = window.location.origin;
    return exactOrigin === fallbackOrigin
      ? [exactOrigin]
      : [exactOrigin, fallbackOrigin];
  }

  getCredentialEntryHost(entry) {
    const value = entry && (entry.domain || entry.url);
    if (!value || typeof value !== 'string') return '';
    try {
      return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
    } catch {
      return value.toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
    }
  }

  dedupeCredentials(entries) {
    const seen = new Set();
    return (Array.isArray(entries) ? entries : []).filter(entry => {
      if (!entry || typeof entry !== 'object') return false;
      const key = entry.id
        ? `id:${entry.id}`
        : `row:${entry.username || ''}\u0000${entry.title || ''}\u0000${entry.url || entry.domain || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  getAuthFlowBaseDomain() {
    return this.getBaseDomain(this.domain);
  }

  getAuthFlowSignalText(contextEl = null, options = {}) {
    const includeContextText = Boolean(options.fromClick);
    const parts = [
      window.location.href,
      document.title,
      document.body && document.body.getAttribute('aria-label')
    ];

    const addElementAttrs = (el, includeText = false) => {
      if (!el || !el.getAttribute) return;
      if (includeText) {
        parts.push(el.textContent, el.value);
      }
      parts.push(
        el.id,
        el.name,
        el.className,
        el.getAttribute('action'),
        el.getAttribute('aria-label'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-test-id'),
        el.getAttribute('data-cy')
      );
    };

    addElementAttrs(contextEl, includeContextText);
    const form = contextEl && contextEl.closest ? contextEl.closest('form') : null;
    addElementAttrs(form, false);

    if (form && includeContextText) {
      const submitLike = form.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
      Array.from(submitLike).slice(0, 12).forEach(el => {
        parts.push(el.textContent, el.value, el.getAttribute && el.getAttribute('aria-label'));
      });
    }

    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  hasSignupFlowSignal(contextEl = null, options = {}) {
    const text = this.getAuthFlowSignalText(contextEl, options);
    const signupLike = /(signup|sign-up|sign_up|register|registration|create[-_\s]*account|new[-_\s]*account|join|kayit|kayıt|kaydol|hesab[ıi]?[-_\s]*olu[şs]tur|hesap[-_\s]*olu[şs]tur)/i.test(text);
    if (!signupLike) return false;

    // A plain login page can contain a small "create account" link. Treat the
    // signal as strong only when it is not merely paired with current-password
    // or a known login challenge.
    const isPasswordContext = contextEl &&
      contextEl.tagName === 'INPUT' &&
      (contextEl.type || '').toLowerCase() === 'password';
    if (this.isGoogleAccountsSignin()) return false;
    if (isPasswordContext && this.isKnownLoginPasswordStep(contextEl.closest('form') || document.body, contextEl)) {
      return false;
    }

    return true;
  }

  hasLoginFlowSignal(contextEl = null) {
    if (this.isGoogleAccountsSignin()) return true;
    if (contextEl && contextEl.getAttribute) {
      if (this.getAutocompleteTokens(contextEl).includes('current-password')) return true;
    }
    return false;
  }

  isSignupFlowActive(maxAgeMs = 15 * 60 * 1000) {
    return this._authFlowMode === 'signup' && Date.now() - this._authFlowModeTime < maxAgeMs;
  }

  setAuthFlowMode(mode) {
    this._authFlowMode = mode;
    this._authFlowModeTime = Date.now();
    this.sendMessageToBackground({
      type: 'SET_AUTH_FLOW_MODE',
      mode,
      domain: this.getAuthFlowBaseDomain()
    }).catch(() => {});
  }

  async syncAuthFlowModeFromBackground() {
    try {
      const res = await this.sendMessageToBackground({ type: 'GET_AUTH_FLOW_MODE' });
      if (
        res &&
        res.success &&
        res.mode &&
        this.getBaseDomain(res.domain) === this.getAuthFlowBaseDomain() &&
        Date.now() - res.time < 15 * 60 * 1000
      ) {
        this._authFlowMode = res.mode;
        this._authFlowModeTime = res.time;
      }
    } catch { /* keep local state */ }
  }

  captureAuthFlowContext(contextEl = null, options = {}) {
    if (this.hasLoginFlowSignal(contextEl)) {
      this.setAuthFlowMode('login');
      return;
    }

    if (this.hasSignupFlowSignal(contextEl, options)) {
      this.setAuthFlowMode('signup');
    }
  }

  hasRecentTrustedUserAction(maxAgeMs = 1500) {
    return Date.now() - this._lastTrustedUserAction <= maxAgeMs;
  }

  shouldHonorAutofillEvent(e) {
    if (!e || !e.isTrusted) return false;
    if (e.type === 'focus') return this.hasRecentTrustedUserAction();
    return true;
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
        const error = chrome.runtime.lastError;
        resolve(error ? { success: false, error: error.message } : (response || null));
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

  isInputVisible(input) {
    if (!input || input.type === 'hidden' || input.hidden || input.disabled || input.readOnly) return false;

    const style = window.getComputedStyle ? window.getComputedStyle(input) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

    const rect = input.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  isPasswordLikeInput(input) {
    if (!input || input.tagName !== 'INPUT') return false;

    const type = (input.type || '').toLowerCase();
    if (type === 'password') {
      const tokens = this.getAutocompleteTokens(input);
      // Some sign-in pages mask the account identifier with type=password.
      // Explicit password autocomplete remains authoritative.
      if (tokens.some(token => ['current-password', 'new-password'].includes(token))) return true;
      return !tokens.includes('username') && !this.hasIdentitySignal(input);
    }
    if (!['text', 'search', ''].includes(type)) return false;

    return /password|passwort|parola|sifre|şifre|\bpass\b/.test(this.getFieldSignal(input));
  }

  hasIdentitySignal(input) {
    const signal = this.getFieldSignal(input);
    return !/password|passwort|parola|sifre|şifre|\bpass\b/.test(signal) &&
      /\bkimlik\b|\b(?:national|citizen|personal|identity|identification)\s+(?:id|number|no)\b|\b(?:national|citizen)\s+identification\b|\bsocial\s+security\b|\bssn\b|\bpersonnummer\b/.test(signal);
  }

  getFieldSignal(input) {
    const labelledBy = (input.getAttribute('aria-labelledby') || '').split(/\s+/);
    const root = input.getRootNode ? input.getRootNode() : document;
    // Some React fields render a sibling label without for/id association.
    // Only read labels in an exclusive wrapper, never a whole form's text.
    let wrapper = input.parentElement;
    let nearbyLabels = [];
    for (let level = 0; level < 3 && wrapper && wrapper !== document.body; level++, wrapper = wrapper.parentElement) {
      const controls = wrapper.querySelectorAll('input:not([type="hidden"])');
      if (controls.length !== 1 || controls[0] !== input) break;
      nearbyLabels = Array.from(wrapper.querySelectorAll('label, .field-label, [data-label]'));
      if (nearbyLabels.length) break;
    }
    return [
      input.name,
      input.id,
      input.className,
      input.placeholder,
      input.getAttribute('title'),
      input.getAttribute('aria-label'),
      input.getAttribute('autocomplete'),
      input.getAttribute('data-testid'),
      input.getAttribute('data-test-id'),
      input.getAttribute('data-cy'),
      ...Array.from(input.labels || []).map(label => label.textContent),
      ...nearbyLabels.map(label => label.textContent),
      input.isContentEditable ? input.parentElement?.querySelector('label')?.textContent : '',
      ...labelledBy.map(id => root.getElementById?.(id)?.textContent)
    ].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  }

  getFieldScope(input) {
    return input.form || input.closest('form') || input.closest('[role="form"], .formless') || document.body;
  }

  getInputs(scope = document, observe = true) {
    const inputs = scope.tagName === 'FORM' && scope.elements
      ? [...Array.from(scope.elements).filter(element => element.tagName === 'INPUT'),
        ...scope.querySelectorAll('[contenteditable="true"][role="textbox"]')]
      : Array.from(scope.querySelectorAll('input, [contenteditable="true"][role="textbox"]'));
    for (const element of scope.querySelectorAll('*')) {
      const shadow = this.getShadowRoot(element);
      if (shadow) {
        if (observe) this.observeFormRoot(shadow);
        inputs.push(...this.getInputs(shadow, observe));
      }
    }
    return [...new Set(inputs)];
  }

  getPasswordInputs(scope = document, observe = true) {
    return this.getInputs(scope, observe)
      .filter(input => this.isPasswordLikeInput(input));
  }

  getVisiblePasswordInputs(scope = document) {
    return this.getPasswordInputs(scope)
      .filter(input => this.isInputVisible(input));
  }

  isKnownLoginPasswordStep(form, passwordInput) {
    if (!passwordInput) return false;

    const autocomplete = this.getAutocompleteTokens(passwordInput);
    if (autocomplete.includes('current-password')) return true;
    if (autocomplete.includes('new-password')) return false;

    const host = (window.location.hostname || '').toLowerCase();
    const path = (window.location.pathname || '').toLowerCase();
    if (host === 'accounts.google.com' && /\/signin\/challenge\/pwd\b/.test(path)) {
      return true;
    }

    const formAction = form && form.getAttribute ? form.getAttribute('action') : '';
    const haystack = [
      host,
      path,
      form && form.id,
      form && form.name,
      formAction,
      passwordInput.id,
      passwordInput.name,
      passwordInput.placeholder,
      passwordInput.getAttribute('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();

    const loginLike = /(login|log-in|signin|sign-in|sign_in|giris|oturum|auth|authenticate|challenge\/pwd)/i.test(haystack);
    const signupLike = /(signup|sign-up|register|join|create|new-password)/i.test(haystack);
    return loginLike && !signupLike;
  }

  // ─── Core Analysis ─────────────────────────────────────────────────────────

  analyzeAndInject() {
    this.diagnostics.analysisCount++;
    const passwordInputs = this.getPasswordInputs(document);
    if (DEBUG) console.log(`[DIAGNOSTIC - DOM] 1. Found Password Inputs:`, passwordInputs.length);
    // Username-only steps need their own menu before the password is rendered.
    const scopes = new Set(this.getInputs(document).map(input => this.getFieldScope(input)));
    scopes.forEach(scope => {
      if (this.getVisiblePasswordInputs(scope).length || this.hasSignupFlowSignal(scope) || this.isSignupFlowActive()) return;
      const username = this.findUsernameInput(scope);
      if (username && (/user|email|e-posta|member|identifier|telefon|phone|üye/.test(this.getFieldSignal(username)) || this.hasIdentitySignal(username)) &&
          this.credentials.length && !username._lockeepAutofillListener) this.setupAutofillDropdown(username, null, username);
    });

    passwordInputs.forEach(passInput => {
      if (!this.isInputVisible(passInput)) return;
      const form = this.getFieldScope(passInput);
      const usernameInput = this.findUsernameInput(form, passInput);
      const isSignup = this.isSignupForm(form, passInput);
      this.diagnostics.fieldModes.set(passInput, isSignup ? 'signup' : 'login');
      if (DEBUG) console.log(`[DIAGNOSTIC - DOM] 2. Form Analysis:`, { usernameInputFound: !!usernameInput, isSignup, credsCount: this.credentials?.length });

      const hasGenerateIcon = !!(passInput._lockeepIcon && document.body.contains(passInput._lockeepIcon));
      if (hasGenerateIcon && !isSignup) {
        passInput._lockeepCleanup?.();
        delete passInput._lockeepIcon;
        delete passInput._lockeepCleanup;
      }
      if (passInput._lockeepAutofillSetup && (isSignup || passInput._lockeepUsernameInput !== usernameInput)) {
        this.clearAutofillPair(passInput);
      }
      const hasCredentials = Array.isArray(this.credentials) && this.credentials.length > 0;
      const needsGenerateIcon = isSignup && !hasGenerateIcon;
      const needsAutofill = !isSignup && hasCredentials && !passInput._lockeepAutofillSetup;
      if (passInput.dataset.lockeepInjected && !needsGenerateIcon && !needsAutofill) return;
      passInput.dataset.lockeepInjected = 'true';

      if (isSignup) {
        // BUG-5 FIX: usernameInput is no longer passed — icon positioning is
        // purely relative to passwordInput via getSingleInputWrapper().
        this.injectGenerateIcon(passInput);
      } else {
        if (hasCredentials && !passInput._lockeepAutofillSetup) {
          // Multi-step login pages often remove the username field before
          // showing the password step. In that case, anchor the dropdown to
          // the password input without treating it as a username field.
          const autofillAnchor = usernameInput || passInput;
          this.setupAutofillDropdown(autofillAnchor, passInput, usernameInput);
          passInput._lockeepAutofillSetup = true;
          passInput._lockeepUsernameInput = usernameInput;
        }
      }
    });
  }

  // Rank visible username controls by semantics, then proximity. Unrelated
  // codes, coupons and hidden controls must never receive account information.
  findUsernameInput(form, passwordInput = null, observe = true) {
    const inputs = this.getInputs(form, observe);
    const candidates = inputs.filter(input => input !== passwordInput && this.isInputVisible(input) &&
      (['text', 'email', 'tel', 'number', 'password', ''].includes(input.type) || input.isContentEditable) && !this.isPasswordLikeInput(input));
    const ranked = candidates.map(input => {
      const tokens = this.getAutocompleteTokens(input);
      const signal = this.getFieldSignal(input);
      if (tokens.some(token => ['one-time-code', 'current-password', 'new-password'].includes(token)) || tokens.some(token => /^(cc-|address|postal|given-name|family-name|bday)/.test(token)) ||
          /coupon|discount|kupon|do[ğg]rulama|verification|captcha|\botp\b|\bsecurity\s+code\b|g[uü]venlik\s+kod|sicherheits\s*code|search|sitede ara|date of birth|birth date|birth year|birthday|do[ğg]um/.test(signal)) return { input, score: -1 };
      let score = tokens.includes('username') ? 100 : 0;
      if (input.type === 'email' || /e-?mail|e-posta/.test(signal)) score += 60;
      if (/user|kullanıcı|kullanici|üye|member|identifier|login|benutzer/.test(signal)) score += 50;
      if (this.hasIdentitySignal(input)) score += 50;
      if (input.type === 'tel' || /phone|telefon/.test(signal)) score += 30;
      // Numeric quantities and dates do not become fallback usernames merely
      // because they happen to precede a password field.
      if (input.type === 'number' && score === 0) return { input, score: -1 };
      // Prefer a nearby field preceding the password when semantics tie.
      const distance = passwordInput ? inputs.indexOf(passwordInput) - inputs.indexOf(input) : 0;
      score += distance > 0 ? 5 / distance : 0;
      return { input, score };
    }).filter(candidate => candidate.score >= 0).sort((a, b) => b.score - a.score);
    return ranked[0]?.input || null;
  }

  getGenerationTargets(passwordInput) {
    const candidates = this.getVisiblePasswordInputs(this.getFieldScope(passwordInput))
      .filter(input => this.getPasswordRole(input) !== 'current');
    const explicitNew = candidates.some(input => this.getPasswordRole(input) === 'new');
    return explicitNew ? candidates.filter(input => ['new', 'confirm'].includes(this.getPasswordRole(input))) : candidates;
  }

  getPasswordRole(input) {
    const tokens = this.getAutocompleteTokens(input);
    const signal = this.getFieldSignal(input);
    if (tokens.includes('current-password') ||
        /\b(current|old|existing|previous)\s+(?:password|passwort|parola|sifre|şifre)\b|\b(mevcut|eski|bisherig\w*|aktuell\w*)\b/.test(signal)) return 'current';
    if (this.isConfirmationInput(input)) return 'confirm';
    if (tokens.includes('new-password') || /\b(new|yeni|neu\w*)\s+(password|passwort|parola|sifre|şifre)\b/.test(signal)) return 'new';
    return 'unknown';
  }

  isConfirmationInput(input) {
    return /confirm|onayla|re-?enter|repeat|tekrar|again|bestätig/.test(this.getFieldSignal(input));
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
    return this.getSignupReason(form, passwordInput) !== null;
  }

  getSignupReason(form, passwordInput) {
    const autocomplete = this.getAutocompleteTokens(passwordInput);
    const role = this.getPasswordRole(passwordInput);
    if (role === 'current' || this.isGoogleAccountsSignin()) return null;
    if (autocomplete.includes('new-password')) return 'new_password_autocomplete';
    if (role === 'new') return 'new_password_label';
    if (role === 'confirm') return 'confirmation_field';
    if (this.isSignupFlowActive()) return 'remembered_signup_flow';
    if (this.isKnownLoginPasswordStep(form, passwordInput)) return null;

    if (!form || form === document.body) {
      if (passwordInput) {
        const inputAttr = `${passwordInput.id || ''} ${passwordInput.name || ''}`.toLowerCase();
        if (/(new|signup|register)/i.test(inputAttr)) return 'password_field_attributes';
      }
      const allPass = this.getVisiblePasswordInputs(document);
      if (allPass.length > 1) return 'multiple_visible_password_fields';
      return null;
    }

    const passwordInputs = this.getVisiblePasswordInputs(form);
    if (passwordInputs.length > 1) return 'multiple_visible_password_fields';

    const formAttr = `${form.id || ''} ${form.name || ''} ${form.action || ''}`.toLowerCase();
    if (/(signup|register|join|create|new)/i.test(formAttr)) {
      if (!/(login|signin|sign-in|auth)/i.test(formAttr)) {
        return 'form_attributes';
      }
    }

    if (passwordInput) {
      const inputAttr = `${passwordInput.id || ''} ${passwordInput.name || ''}`.toLowerCase();
      if (/(new|signup|register)/i.test(inputAttr)) return 'password_field_attributes';
    }

    return null;
  }

  // ─── Autofill Dropdown ─────────────────────────────────────────────────────

  getAutocompleteTokens(input) {
    return ((input && input.getAttribute('autocomplete')) || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  }

  suppressInlinePasskeySuggestions(input) {
    if (!input || !Array.isArray(this.credentials) || this.credentials.length === 0) return;
    const tokens = (input.getAttribute('autocomplete') || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.some(token => token.toLowerCase() === 'webauthn')) return;

    // The `webauthn` token opts this field into the browser's conditional
    // passkey dropdown. Remove only that token on our autofill targets. Keep
    // username/current-password semantics and explicit passkey sign-in intact.
    input.setAttribute('autocomplete', tokens.filter(token => token.toLowerCase() !== 'webauthn').join(' ') || 'off');
    input._lockeepInlinePasskeySuppressed = true;
  }

  clearAutofillPair(passwordInput) {
    [passwordInput, passwordInput._lockeepUsernameInput].filter(Boolean).forEach(input => {
      if (input._lockeepAutofillTarget === passwordInput) input._lockeepAutofillCleanup?.();
    });
    delete passwordInput._lockeepAutofillSetup;
    delete passwordInput._lockeepUsernameInput;
    this.activeDropdown?.remove();
    this.activeDropdown = null;
  }

  setupAutofillDropdown(anchorInput, passwordInput, usernameInput = anchorInput) {
    if (!anchorInput) return;

    const showDropdown = (e, requestedInput = null) => {
      if (!this.shouldHonorAutofillEvent(e)) {
        this.diagnostics.recordInteraction(e, e && e.isTrusted ? 'focus_without_user_action' : 'untrusted_event');
        return;
      }
      this.suppressInlinePasskeySuggestions(e.currentTarget?.tagName === 'INPUT' ? e.currentTarget : anchorInput);
      if (e) e.stopPropagation();

      // If dropdown is already active, just return to prevent flicker
      if (this.activeDropdown) {
        this.diagnostics.recordInteraction(e, 'dropdown_already_active');
        return;
      }

      const credentials = Array.isArray(this.credentials) ? this.credentials : [];
      if (credentials.length === 0) {
        this.diagnostics.recordInteraction(e, 'no_cached_credentials');
        return;
      }

      const triggerInput = requestedInput || (e && e.currentTarget && typeof e.currentTarget.getBoundingClientRect === 'function'
        ? e.currentTarget
        : anchorInput);
      const dropdown = document.createElement('div');
      dropdown.className = 'lockeep-dropdown';

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
          // A real click is required before we ask the vault for the password.
          // Synthetic events from the page can still reach this DOM node, but
          // they should never be able to turn an entry id into cleartext.
          if (!e.isTrusted) return;

          // FIX: Use mousedown + preventDefault to prevent the input losing focus
          // before the click registers, which previously caused the dropdown to
          // close via the document click listener before the item could be selected.
          e.preventDefault();
          e.stopPropagation();

          let passwordToFill = cred.password;
          if (passwordInput && !passwordToFill && cred.id) {
            const detailRes = await this.sendMessageToBackground({
              type: 'GET_CREDENTIAL',
              id: cred.id,
              origin: this.getCredentialLookupOrigin()
            });
            if (detailRes && detailRes.success) {
              const resData = detailRes.data || {};
              passwordToFill = (resData.entry && resData.entry.password) || resData.password || detailRes.password;
            }
          }

          if (usernameInput && usernameInput !== passwordInput) {
            this.setFieldValue(usernameInput, cred.username);
          }

          if (passwordToFill && passwordInput) {
            this.setFieldValue(passwordInput, passwordToFill);
          }

          dropdown.remove();
          this.activeDropdown = null;
        });

        dropdown.appendChild(item);
      });

      this.activeDropdown = dropdown;
      this.trackFloatingView(dropdown, triggerInput, exposed => {
        if (!exposed) {
          dropdown.remove();
          if (this.activeDropdown === dropdown) this.activeDropdown = null;
          return;
        }
        const rect = triggerInput.getBoundingClientRect();
        const viewport = this.getViewport();
        const margin = 8;
        const width = Math.min(Math.max(250, rect.width), viewport.width - margin * 2);
        const below = viewport.top + viewport.height - rect.bottom - margin - 5;
        const above = rect.top - viewport.top - margin - 5;
        const flip = below < Math.min(200, dropdown.scrollHeight) && above > below;
        this.setFloatingStyle(dropdown, 'width', `${width}px`, 'important');
        this.setFloatingStyle(dropdown, 'max-height', `${Math.max(0, Math.min(200, flip ? above : below))}px`, 'important');
        this.setFloatingStyle(dropdown, 'left', `${Math.max(viewport.left + margin, Math.min(rect.left, viewport.left + viewport.width - width - margin))}px`);
        this.setFloatingStyle(dropdown, 'top', `${flip ? rect.top - dropdown.getBoundingClientRect().height - 5 : rect.bottom + 5}px`);
      });
      this.diagnostics.recordInteraction(e, 'dropdown_opened');
    };

    // FIX: Listen to both 'focus' and 'click' — 'focus' alone misses the case
    // where the input is already focused when the page loads (e.g. autofocused inputs).
    const triggerInputs = [anchorInput, passwordInput].filter((input, index, inputs) =>
      input && inputs.indexOf(input) === index
    );
    triggerInputs.forEach(input => {
      if (input._lockeepAutofillListener && input._lockeepAutofillTarget !== passwordInput &&
          (!input._lockeepAutofillTarget || !input._lockeepAutofillTarget.isConnected)) input._lockeepAutofillCleanup?.();
      if (input._lockeepAutofillListener) return;
      this.suppressInlinePasskeySuggestions(input);
      input.addEventListener('focus', showDropdown);
      input.addEventListener('click', showDropdown);
      input._lockeepAutofillListener = true;
      input._lockeepAutofillTarget = passwordInput;
      input._lockeepShowDropdown = showDropdown;
      input._lockeepAutofillCleanup = () => {
        input.removeEventListener('focus', showDropdown);
        input.removeEventListener('click', showDropdown);
        delete input._lockeepAutofillListener;
        delete input._lockeepAutofillSetup;
        delete input._lockeepAutofillTarget;
        delete input._lockeepShowDropdown;
      };
    });
  }

  // ─── Generate Icon ─────────────────────────────────────────────────────────

  /**
   * BUG-5 FIX: usernameInput parameter removed — icon positioning is now
   * purely relative to passwordInput using getSingleInputWrapper().
   */
  injectGenerateIcon(passwordInput) {
    const getVisiblePassInputs = () => this.getGenerationTargets(passwordInput);
    const primary = getVisiblePassInputs().find(input => !this.isConfirmationInput(input));
    if (passwordInput !== primary) return;

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

    if (typeof passwordInput._lockeepCleanup === 'function') passwordInput._lockeepCleanup();
    passwordInput._lockeepIcon = icon;
    passwordInput._lockeepCleanup = () => {
      this._floatingViews.delete(icon);
      icon.remove();
    };
    this.trackFloatingView(icon, passwordInput, exposed => {
      const inputRect = passwordInput.getBoundingClientRect();
      const viewport = this.getViewport();
      const wrapper = this.getSingleInputWrapper(passwordInput);
      const widthRect = wrapper ? wrapper.getBoundingClientRect() : inputRect;
      const left = Math.min(widthRect.right + 4, viewport.left + viewport.width - 24);
      const top = inputRect.top + inputRect.height / 2;
      // The field can be inside an overflow panel while the floating icon is
      // outside it. Both must fit the visible clipping area.
      let fits = exposed && top - 10 >= viewport.top && top + 10 <= viewport.top + viewport.height &&
        this.isFloatingPointExposed(passwordInput, left + 10, top);
      let ancestor = passwordInput.parentElement;
      while (fits && ancestor && ancestor !== document.body) {
        const style = window.getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (top - 10 < rect.top || top + 10 > rect.bottom)) fits = false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (left < rect.left || left + 20 > rect.right)) fits = false;
        ancestor = ancestor.parentElement;
      }
      const display = fits ? 'flex' : 'none';
      if (icon.style.display !== display) icon.style.display = display;
      if (icon.style.top !== top + 'px') icon.style.top = top + 'px';
      if (icon.style.left !== left + 'px') icon.style.left = left + 'px';
    });

    // Generate only into the associated form's new/confirmation fields.
    icon.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      const res = await this.sendMessageToBackground({ type: 'GENERATE_PASSWORD' });
      if (res && res.success && res.data && res.data.password) {
        const generatedPassword = res.data.password;
        getVisiblePassInputs().forEach(inp => {
          this.setFieldValue(inp, generatedPassword);
        });
      }
    });
  }

  // ─── Form Submission ───────────────────────────────────────────────────────

  getAuthSubmitKind(button) {
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
    if (button.type === 'submit' && (button.form || button.closest('form'))) return 'native_form';
    const signal = [button.textContent, button.value, button.name, button.id,
      button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'),
      button.getAttribute('data-test-id'), button.getAttribute('data-cy')].filter(Boolean).join(' ');
    if (/login|log[-_\s]?in|sign[-_\s]?in|giriş\s*yap|register|sign[-_\s]?up|kaydol|hesap\s*oluştur|create[-_\s]*(?:an?[-_\s]*)?account/i.test(signal)) return 'auth_button';
    const scope = button.form || button.closest('form, [role="form"], .formless') || document.body;
    const completionLabel = (button.textContent || button.getAttribute('aria-label') || '').trim();
    if (this.authBuffer.awaitingCompletion && this.hasRemainingRegistrationConsent(scope) &&
        this.getRegistrationConsentInputs(scope).every(input => input.checked) &&
        !button.closest('[class*="cookie" i], [class*="osano" i], [aria-label*="cookie" i]') &&
        /^(accept|agree|i agree|kabul et|kabul ediyorum|onayla|akzeptieren|zustimmen)$/i.test(completionLabel)) return 'registration_completion';
    return null;
  }

  clearRegistrationBuffer() {
    if (this._authBufferTimer) clearTimeout(this._authBufferTimer);
    this._authBufferTimer = null;
    this.authBuffer = { username: '', password: '', capturedAt: 0, awaitingCompletion: false };
  }

  rememberRegistrationPair(username, password) {
    this.clearRegistrationBuffer();
    this.authBuffer = { username, password, capturedAt: Date.now(), awaitingCompletion: false };
    this._authBufferTimer = setTimeout(() => {
      this.clearRegistrationBuffer();
      this._submissionPhase = 'registration_expired';
    }, 120000);
  }

  hasLiveRegistrationPair() {
    return Boolean(this.isSignupFlowActive() && this.authBuffer.password && Date.now() - this.authBuffer.capturedAt < 120000);
  }

  hasRemainingRegistrationConsent(scope) {
    return this.hasLiveRegistrationPair() && this.getVisiblePasswordInputs(scope).length === 0 &&
      this.getRegistrationConsentInputs(scope).length > 0;
  }

  getRegistrationConsentInputs(scope) {
    return this.getInputs(scope).filter(input => input.type === 'checkbox' && this.isInputVisible(input) &&
      (input.required || /\bterms\b|\btos\b|consent|agreement|hizmet şart|şartlar|nutzungsbedingung/.test(this.getFieldSignal(input))));
  }

  getSubmissionErrors() {
    const roots = [document, ...this._shadowRoots || []].filter(root => !root.host || root.host.isConnected);
    return roots.flatMap(root => Array.from(root.querySelectorAll('[role="alert"], [aria-invalid="true"], .error-message, .validation-error')))
      .filter(element => !element.closest('.lockeep-save-prompt') && this.isInputVisible(element));
  }

  checkSubmissionFailure() {
    const candidate = this._saveCandidate;
    if (!candidate) return;
    const failed = this.getSubmissionErrors().some(element =>
      !candidate.errors.has(element) || candidate.errors.get(element) !== element.textContent);
    if (!failed) return;
    this._saveCandidate = null;
    this.clearRegistrationBuffer();
    this._submissionPhase = 'site_error';
    clearTimeout(candidate.timer);
    this.activePrompt?.remove();
    this.activePrompt = null;
    this.sendMessageToBackground({ type: 'CLEAR_PENDING_SAVE' });
  }

  setupSubmissionListeners() {
    let lastSubmitTime = 0;
    let lastSubmitUser = '';
    let lastSubmitPass = '';

    // BUG-3 FIX: handleSubmit now accepts optional pre-captured values.
    const handleSubmit = async (formElement, capturedUsername, capturedPassword, options = {}) => {
      if (!formElement) return;

      let password = capturedPassword;
      let username = capturedUsername;

      // If values weren't pre-captured (native submit), read from DOM
      if (password === undefined) {
        const passwordInput = this.getVisiblePasswordInputs(formElement).find(input => this.getAutocompleteTokens(input).includes('new-password')) || this.getVisiblePasswordInputs(formElement)[0];
        if (!passwordInput || !passwordInput.value) return;
        password = passwordInput.value;
        const usernameInput = this.findUsernameInput(formElement, passwordInput);
        username = usernameInput ? this.getFieldValue(usernameInput).trim() : '';
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
      if (!options.registrationCompletion && username === lastSubmitUser && password === lastSubmitPass && (now - lastSubmitTime < 1000)) return;
      lastSubmitUser = username;
      lastSubmitPass = password;
      lastSubmitTime = now;

      const isKnown = Array.isArray(this.credentials) && this.credentials.some(c => c.username === username);
      this._submissionPhase = isKnown ? 'existing_account' : 'captured';
      this._lastSubmissionTime = now;

      if (!isKnown && password.length >= 4) {
        if (this.isSignupFlowActive()) this.rememberRegistrationPair(username, password);
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
        const candidate = { errors: new Map(this.getSubmissionErrors().map(element => [element, element.textContent])) };
        if (this._saveCandidate) clearTimeout(this._saveCandidate.timer);
        this._saveCandidate = candidate;
        await this.sendMessageToBackground({
          type: 'SET_PENDING_SAVE',
          entry: {
            domain: loginDomain,
            baseDomain: this.getBaseDomain(loginDomain),
            url: loginOrigin,
            username,
            password
          }
        });
        if (this._saveCandidate !== candidate) return;
        this._submissionPhase = 'pending_save';
        // Let synchronous validation and promise callbacks render their error
        // first. Later visible error updates also withdraw the pending offer.
        candidate.timer = setTimeout(() => {
          this.checkSubmissionFailure();
          if (this._saveCandidate !== candidate) return;
          if (!options.registrationCompletion && this.hasRemainingRegistrationConsent(formElement)) {
            // The password screen was only an intermediate step. Keep the pair
            // in this page's short-lived memory until the real final consent
            // click, rather than offering to save before account creation.
            this.authBuffer.awaitingCompletion = true;
            this._submissionPhase = 'waiting_for_consent';
            this.activePrompt?.remove();
            this.activePrompt = null;
            this.sendMessageToBackground({ type: 'CLEAR_PENDING_SAVE' });
            return;
          }
          this.showSavePrompt(username, password, loginOrigin, candidate);
        }, 75);
      }
    };

    // 1. Native form submissions
    this._handleSubmitEvent = (e) => {
      if (!e.isTrusted || (e.target.checkValidity && !e.target.checkValidity())) return;
      handleSubmit(e.target);
    };
    document.addEventListener('submit', this._handleSubmitEvent);

    // 2. JS-driven form submissions (listening to button clicks)
    // BUG-3 FIX: Capture input values SYNCHRONOUSLY at click time.
    this._handleSubmitClick = (e) => {
      if (!e.isTrusted) return;
      const btn = (e.composedPath?.()[0] || e.target).closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!btn) return;
      if (btn.closest('.lockeep-save-prompt')) return;

      if (this.getAuthSubmitKind(btn)) {
        const form = btn.form || btn.closest('form') || btn.closest('[role="form"], .formless') || document.body;
        if (form.tagName === 'FORM' && !form.checkValidity()) return;
        const passwordInput = this.getVisiblePasswordInputs(form).find(input => this.getAutocompleteTokens(input).includes('new-password')) || this.getVisiblePasswordInputs(form)[0];
        if (!passwordInput || !passwordInput.value) {
          if (this.authBuffer.awaitingCompletion && this.hasRemainingRegistrationConsent(form) &&
              this.getRegistrationConsentInputs(form).every(input => input.checked)) {
            handleSubmit(form, this.authBuffer.username, this.authBuffer.password, { registrationCompletion: true });
          }
          return;
        }
        const capturedPassword = passwordInput.value;
        const usernameInput = this.findUsernameInput(form, passwordInput);
        const capturedUsername = usernameInput ? this.getFieldValue(usernameInput).trim() : '';
        handleSubmit(form, capturedUsername, capturedPassword);
      }
    };
    document.addEventListener('click', this._handleSubmitClick, true);
  }

  // ─── Save Prompt ───────────────────────────────────────────────────────────

  async showSavePrompt(username, password, loginUrl, candidate = null) {
    // BUG-2 FIX: Use resolveLanguage() — reads from the centralised i18n table
    const t = await this.resolveLanguage();
    if (candidate && this._saveCandidate !== candidate) return;
    this.clearRegistrationBuffer();
    this._submissionPhase = 'prompt_shown';

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
      if (!e.isTrusted) return;
      e.preventDefault();
      this._saveCandidate = null;
      this.sendMessageToBackground({ type: 'CLEAR_PENDING_SAVE' });
      prompt.remove();
      this.activePrompt = null;
    });

    saveBtn.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      this._saveCandidate = null;

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocKeepContentScript;
}

// Initialize script in the browser. The document guard also allows the class to
// be loaded by the Node-based regression tests without starting the extension.
if (typeof document !== 'undefined') {
  const start = () => {
    const contentScript = new LocKeepContentScript();
    contentScript.init().catch(() => { contentScript.diagnostics.phase = 'initialization_failed'; });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
