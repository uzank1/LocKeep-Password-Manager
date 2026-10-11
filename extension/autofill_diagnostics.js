'use strict';

// Only counts, fixed reason codes and hostnames are retained. Never store
// input values, account metadata, raw errors, page text or complete URLs.
class LocKeepAutofillDiagnostics {
  constructor(contentScript) {
    this.content = contentScript;
    this.startedAt = Date.now();
    this.phase = 'created';
    this.observerActive = false;
    this.fetchAttempts = 0;
    this.analysisCount = 0;
    this.lastFetch = null;
    this.interactions = [];
    this.fieldModes = new WeakMap();
  }

  static errorStatus(error) {
    const text = String(error && error.message || error || '').toLowerCase();
    if (/vault is locked|requires an unlocked vault/.test(text)) return 'vault_locked';
    if (/timed out|timeout/.test(text)) return 'request_timeout';
    if (/handshake|e2ee/.test(text)) return 'handshake_failed';
    if (/native host|native messaging|not connected|econnrefused|enoent|electron app|ipc port|ipc auth token|app is not running|app not running|desktop app/.test(text)) return 'native_unavailable';
    if (/context invalidated|receiving end|message port|could not establish connection/.test(text)) return 'messaging_failed';
    if (/invalid credential response/.test(text)) return 'invalid_response';
    return 'query_failed';
  }

  static lookupStatus(response) {
    if (!response) return 'messaging_failed';
    if (!response.success) return this.errorStatus(response.error);
    return response.data && Array.isArray(response.data.entries) ? 'ok' : 'invalid_response';
  }

  register() {
    // A page cannot request the report through DOM events/window.postMessage.
    // Only our own popup may ask for the read-only query and snapshot.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'GET_AUTOFILL_DIAGNOSTICS' ||
          !sender || sender.id !== chrome.runtime.id || sender.tab ||
          sender.url !== chrome.runtime.getURL('popup/popup.html')) return false;
      this.collect().then(
        report => sendResponse({ success: true, report }),
        () => sendResponse({ success: false, errorCode: 'diagnostics_failed' })
      );
      return true;
    });

    // Capture also inputs where autofill never installed its own listeners.
    const record = event => {
      if (event.target && event.target.tagName === 'INPUT') {
        this.recordInteraction(event, event.target._lockeepAutofillListener ? 'listener_attached' : 'listener_missing');
      }
    };
    document.addEventListener('focus', record, true);
    document.addEventListener('click', record, true);
  }

  recordInteraction(event, outcome) {
    const input = event && (event.currentTarget && event.currentTarget.tagName === 'INPUT'
      ? event.currentTarget : event.target);
    const inputs = this.content.getInputs(document, false);
    const interaction = {
      at: Date.now(), event: event && event.type === 'focus' ? 'focus' : 'click',
      inputIndex: inputs.indexOf(input), trusted: Boolean(event && event.isTrusted),
      recentUserAction: this.content.hasRecentTrustedUserAction(), outcome
    };
    this.interactions.push(interaction);
    if (this.interactions.length > 20) this.interactions.shift();
  }

  inspectUnsupportedContexts() {
    const result = { frames: 0, inaccessibleFrames: 0, framePasswordInputs: 0,
      openShadowRoots: 0, shadowPasswordInputs: 0, scanTruncated: false };
    let remaining = 5000;
    const scan = (root, inShadow = false) => {
      for (const element of root.querySelectorAll('*')) {
        if (remaining-- <= 0) { result.scanTruncated = true; return; }
        if (inShadow && this.content.isPasswordLikeInput(element)) result.shadowPasswordInputs++;
        if (element.shadowRoot) { result.openShadowRoots++; scan(element.shadowRoot, true); }
      }
    };
    scan(document);
    const frames = Array.from(document.querySelectorAll('iframe, frame'));
    result.frames = frames.length;
    if (frames.length > 20) result.scanTruncated = true;
    for (const frame of frames.slice(0, 20)) {
      try {
        if (!frame.contentDocument) result.inaccessibleFrames++;
        else result.framePasswordInputs += this.content.getPasswordInputs(frame.contentDocument, false).length;
      } catch { result.inaccessibleFrames++; }
    }
    return result;
  }

  inspectDropdown() {
    const dropdown = this.content.activeDropdown;
    if (!dropdown) return { present: false };
    const connected = document.body.contains(dropdown);
    if (!connected) return { present: true, connected: false };
    const style = window.getComputedStyle(dropdown);
    const rect = dropdown.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    const inViewport = rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
    // Test a point in the first row rather than the scrollable menu's center.
    let covered = null;
    if (visible && inViewport) {
      const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(window.innerHeight - 1, Math.max(0, rect.top) + Math.min(15, rect.height / 2)));
      const topElement = document.elementFromPoint(x, y);
      covered = topElement ? !dropdown.contains(topElement) : null;
    }
    return { present: true, connected, visible, inViewport, covered };
  }

  snapshot() {
    const content = this.content;
    const allInputs = content.getInputs(document, false);
    const passwordInputs = content.getPasswordInputs(document, false);
    const fields = passwordInputs.slice(0, 50).map(input => {
      const form = content.getFieldScope(input);
      const signupReason = content.getSignupReason(form, input);
      const usernameInput = content.findUsernameInput(form, input, false);
      const autocompleteTokens = content.getAutocompleteTokens(input);
      const autocomplete = autocompleteTokens.find(token => ['current-password', 'new-password'].includes(token)) || 'other';
      return {
        inputIndex: allInputs.indexOf(input), visible: content.isInputVisible(input),
        autocomplete: ['current-password', 'new-password'].includes(autocomplete) ? autocomplete : 'other',
        mode: signupReason ? 'signup' : 'login', signupReason,
        passwordRole: content.getPasswordRole(input),
        generatorAttached: Boolean(input._lockeepIcon),
        analyzedMode: this.fieldModes.get(input) || null,
        usernameFieldFound: Boolean(usernameInput),
        usernameListenerAttached: usernameInput ? Boolean(usernameInput._lockeepAutofillListener) : null,
        inlinePasskeySuggestionsSuppressed: Boolean(input._lockeepInlinePasskeySuppressed ||
          (usernameInput && usernameInput._lockeepInlinePasskeySuppressed)),
        autofillSetup: Boolean(input._lockeepAutofillSetup),
        listenerAttached: Boolean(input._lockeepAutofillListener)
      };
    });
    return {
      schemaVersion: 1, extensionVersion: chrome.runtime.getManifest().version,
      site: window.location.hostname, capturedAt: new Date().toISOString(),
      initialization: { phase: this.phase, ageMs: Date.now() - this.startedAt,
        observerActive: this.observerActive, analysisCount: this.analysisCount },
      cache: { fetched: content._credentialsFetched, count: content.credentials.length,
        fetchAttempts: this.fetchAttempts,
        lastFetch: this.lastFetch ? { ...this.lastFetch, lookups: this.lastFetch.lookups.map(lookup => ({ ...lookup })) } : null },
      page: { inputCount: allInputs.length, passwordInputCount: passwordInputs.length,
        usernameLikeInputCount: allInputs.filter(input => !content.isPasswordLikeInput(input) &&
          ['email', 'text'].includes(input.type)).length,
        fields, fieldsTruncated: passwordInputs.length > fields.length,
        unsupportedContexts: this.inspectUnsupportedContexts() },
      dropdown: this.inspectDropdown(),
      submission: { phase: content._submissionPhase || 'idle',
        lastAt: content._lastSubmissionTime || null,
        waitingForFinalConsent: Boolean(content.authBuffer.awaitingCompletion) },
      interactions: this.interactions.map(interaction => ({ ...interaction }))
    };
  }

  static findings(report) {
    const findings = [];
    if (report.initialization.phase === 'initialization_failed') findings.push('initialization_failed');
    else if (['created', 'initializing'].includes(report.initialization.phase)) findings.push('initialization_pending');
    if (report.freshLookup.status !== 'ok') findings.push(report.freshLookup.status);
    else if (report.freshLookup.count === 0) findings.push('no_matching_credentials');
    else if (!report.cache.fetched) findings.push('credentials_not_fetched');
    else if (report.cache.count === 0) findings.push('stale_empty_cache');

    if (report.page.passwordInputCount === 0) findings.push('no_password_field');
    const visibleFields = report.page.fields.filter(field => field.visible);
    if (visibleFields.length && visibleFields.every(field => field.mode === 'signup')) findings.push('signup_classification');
    if (report.cache.count > 0 && visibleFields.some(field => field.mode === 'login' &&
        (!field.listenerAttached || field.usernameListenerAttached === false))) findings.push('autofill_listener_missing');
    if (visibleFields.some(field => field.analyzedMode && field.analyzedMode !== field.mode)) findings.push('form_classification_changed');
    const contexts = report.page.unsupportedContexts;
    if (contexts.framePasswordInputs > 0) findings.push('password_field_in_frame');
    else if (contexts.frames > 0) findings.push('possible_frame_form');
    if (contexts.shadowPasswordInputs > 0) findings.push('password_field_in_shadow_dom');
    const dropdown = report.dropdown;
    if (dropdown.present) {
      if (!dropdown.connected) findings.push('dropdown_detached');
      else if (!dropdown.visible) findings.push('dropdown_hidden');
      else if (!dropdown.inViewport) findings.push('dropdown_outside_viewport');
      else if (dropdown.covered) findings.push('dropdown_covered');
    }
    const lastInteraction = report.interactions[report.interactions.length - 1];
    if (lastInteraction && lastInteraction.outcome === 'focus_without_user_action') findings.push('focus_without_user_action');
    if (!findings.length) findings.push('no_blocker_detected');
    return findings;
  }

  async collect() {
    // Snapshot first: a successful probe must not erase the failed initial
    // lookup or replace the autofill cache, listeners or last interaction.
    const report = this.snapshot();
    const startedAt = Date.now();
    const fresh = await this.content._queryCredentials();
    report.freshLookup = { status: fresh.status, count: fresh.entries.length,
      durationMs: Date.now() - startedAt, lookups: fresh.lookups };
    report.findings = LocKeepAutofillDiagnostics.findings(report);
    return report;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = LocKeepAutofillDiagnostics;
else globalThis.LocKeepAutofillDiagnostics = LocKeepAutofillDiagnostics;
