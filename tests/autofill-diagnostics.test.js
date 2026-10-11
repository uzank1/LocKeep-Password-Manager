'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = {};
global.chrome = { runtime: { getURL: resource => resource } };
const ContentScript = require('../extension/content_script');
const Diagnostics = require('../extension/autofill_diagnostics');

function pageHarness(types = ['text', 'password']) {
  const messageListeners = [];
  const documentListeners = {};
  const inputs = types.map(type => ({
    tagName: 'INPUT', type, name: type === 'password' ? 'login-password' : 'username',
    id: '', className: '', placeholder: '', dataset: {}, hidden: false, disabled: false,
    attributes: {}, listeners: {},
    getAttribute(name) { return this.attributes[name] || null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getBoundingClientRect: () => ({ width: 200, height: 30, top: 20, left: 20, right: 220, bottom: 50 }),
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }));
  const select = selector => {
    const typeMatch = selector.match(/type="([^"]+)"/);
    const nameMatch = selector.match(/name(\*?)="([^"]+)"/);
    return inputs.filter(input => (!typeMatch || input.type === typeMatch[1]) &&
      (!nameMatch || (nameMatch[1] ? input.name.includes(nameMatch[2]) : input.name === nameMatch[2])));
  };
  const form = { id: 'login-form', name: '', action: '/login', getAttribute: () => '', querySelectorAll: select };
  inputs.forEach(input => { input.closest = () => form; });
  const doc = {
    body: { contains: element => element.connected === true, querySelectorAll: select, getAttribute: () => '' },
    title: 'Private page title',
    querySelectorAll: selector => selector === 'iframe, frame' ? [] : select(selector),
    querySelector: selector => select(selector)[0] || null,
    addEventListener: (name, fn) => { documentListeners[name] = fn; }
  };
  global.document = doc;
  global.window = {
    location: { hostname: 'login.microsoftonline.com', origin: 'https://login.microsoftonline.com',
      pathname: '/private-tenant/login', href: 'https://login.microsoftonline.com/private-tenant/login?token=PRIVATE_URL_TOKEN' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    innerHeight: 800, innerWidth: 1200
  };
  global.chrome = {
    storage: { local: { remove: async () => {} } },
    runtime: {
      id: 'test-id', getURL: resource => `chrome-extension://test-id/${resource}`,
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: fn => messageListeners.push(fn) }
    }
  };
  const content = new ContentScript();
  content.sendMessageToBackground = async () => ({ success: true, data: { entries: [] } });
  return { content, inputs, form, doc, messageListeners, documentListeners };
}

test('Diagnostics distinguish both locked-vault messages, failures and a genuine empty search', () => {
  for (const error of ['Vault is locked.', 'VAULT: Operation requires an unlocked vault.']) {
    assert.equal(Diagnostics.lookupStatus({ success: false, error }), 'vault_locked');
  }
  assert.equal(Diagnostics.lookupStatus({ success: false, error: 'Native host disconnected' }), 'native_unavailable');
  assert.equal(Diagnostics.lookupStatus({ success: false, error: 'Electron app is not running. Cannot read IPC port.' }), 'native_unavailable');
  assert.equal(Diagnostics.lookupStatus({ success: false, error: 'Request timed out' }), 'request_timeout');
  assert.equal(Diagnostics.lookupStatus({ success: false, error: 'E2EE Handshake incomplete' }), 'handshake_failed');
  assert.equal(Diagnostics.lookupStatus({ success: true, data: {} }), 'invalid_response');
  assert.equal(Diagnostics.lookupStatus({ success: true, data: { entries: [] } }), 'ok');
});

test('Fresh probe diagnoses the stale empty cache without changing the failed lookup or exposing credentials', async () => {
  const { content, inputs } = pageHarness();
  content.sendMessageToBackground = async () => ({ success: false, error: 'VAULT: Operation requires an unlocked vault.' });
  await content._fetchCredentials();
  content._credentialsFetched = true;
  content.diagnostics.phase = 'ready';
  const lastFetch = content.diagnostics.lastFetch;
  const cache = content.credentials;
  inputs.forEach(input => { Object.defineProperty(input, 'value', { get() { throw new Error('Input values must not be read'); } }); });
  content.sendMessageToBackground = async () => ({ success: true, data: { entries: [{
    id: 'PRIVATE_ID', username: 'PRIVATE_USER', password: 'PRIVATE_PASSWORD',
    title: 'PRIVATE_TITLE', url: 'https://login.microsoftonline.com/PRIVATE_SAVED_PATH'
  }] } });
  const report = await content.diagnostics.collect();
  assert.equal(report.cache.lastFetch.status, 'vault_locked');
  assert.equal(report.freshLookup.count, 1);
  assert.ok(report.findings.includes('stale_empty_cache'));
  assert.equal(content.credentials, cache);
  assert.equal(content.diagnostics.lastFetch, lastFetch);
  assert.equal(content.diagnostics.fetchAttempts, 1);
  assert.equal(report.site, 'login.microsoftonline.com');
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(report).includes('private-tenant'), false);
});

test('The actual initialization path retains a locked-vault result after unlock until the page fetches again', async () => {
  const { content, inputs } = pageHarness();
  content.resolveLanguage = async () => {};
  content.syncAuthFlowModeFromBackground = async () => {};
  content.captureAuthFlowContext = () => {};
  content.setupSubmissionListeners = () => {};
  content._setupMutationObserver = () => {};
  content.sendMessageToBackground = async message => message.type === 'SEARCH_DOMAIN'
    ? { success: false, error: 'VAULT: Operation requires an unlocked vault.' } : { success: true };
  await content.init();
  assert.equal(content._credentialsFetched, true);
  assert.equal(content.diagnostics.lastFetch.status, 'vault_locked');
  content.sendMessageToBackground = async () => ({ success: true, data: { entries: [{ id: '1' }] } });
  content.analyzeAndInject();
  assert.equal(inputs[1]._lockeepAutofillListener, undefined);
  const report = await content.diagnostics.collect();
  assert.ok(report.findings.includes('stale_empty_cache'));
  assert.equal(content.credentials.length, 0);
});

test('Google compatibility lookup still runs after an unsuccessful exact-host response', async () => {
  const { content } = pageHarness();
  window.location = { hostname: 'accounts.google.com', origin: 'https://accounts.google.com',
    pathname: '/v3/signin/challenge/pwd', href: 'https://accounts.google.com/v3/signin/challenge/pwd' };
  content.sendMessageToBackground = async message => message.domain === window.location.origin
    ? { success: false, error: 'Request timed out' }
    : { success: true, data: { entries: [{ id: '1', url: 'https://google.com' }] } };
  const result = await content._queryCredentials();
  assert.equal(result.entries.length, 1);
  assert.equal(result.lookups[0].status, 'request_timeout');
  assert.equal(result.status, 'ok');
});

test('Microsoft username-only step is diagnosed without attaching autofill or changing hostname matching', async () => {
  const { content } = pageHarness(['text']);
  content.resolveLanguage = async () => {};
  content.syncAuthFlowModeFromBackground = async () => {};
  content.captureAuthFlowContext = () => {};
  content.setupSubmissionListeners = () => {};
  content._setupMutationObserver = () => { content.diagnostics.observerActive = true; };
  const origins = [];
  content.sendMessageToBackground = async message => {
    if (message.type !== 'SEARCH_DOMAIN') return { success: true };
    origins.push(message.domain);
    return { success: true, data: { entries: [{ id: '1', url: 'https://login.microsoftonline.com' }] } };
  };
  await content.init();
  const report = await content.diagnostics.collect();
  assert.equal(report.initialization.phase, 'waiting_for_inputs');
  assert.ok(report.findings.includes('no_password_field'));
  assert.ok(report.findings.includes('credentials_not_fetched'));
  assert.deepEqual(origins, ['https://login.microsoftonline.com']);
  assert.equal(content._credentialsFetched, false);
});

test('Report explains remembered registration mode and identifies fields that missed analysis', async () => {
  const { content } = pageHarness();
  content._authFlowMode = 'signup';
  content._authFlowModeTime = Date.now();
  content._credentialsFetched = true;
  content.credentials = [{ id: '1' }];
  let report = await content.diagnostics.collect();
  assert.equal(report.page.fields[0].signupReason, 'remembered_signup_flow');
  assert.ok(report.findings.includes('signup_classification'));
  content._authFlowMode = null;
  report = await content.diagnostics.collect();
  assert.ok(report.findings.includes('autofill_listener_missing'));
});

test('Only the same-extension popup may request the report', async () => {
  const { content, messageListeners } = pageHarness();
  content.diagnostics.register();
  let calls = 0;
  content.diagnostics.collect = async () => { calls++; return { findings: [] }; };
  const listener = messageListeners[0];
  const message = { type: 'GET_AUTOFILL_DIAGNOSTICS' };
  for (const sender of [
    { id: 'other-id', url: chrome.runtime.getURL('popup/popup.html') },
    { id: 'test-id', url: window.location.href, tab: { id: 1 } },
    { id: 'test-id', url: chrome.runtime.getURL('background.js') }
  ]) assert.equal(listener(message, sender, () => {}), false);
  const response = await new Promise(resolve => {
    assert.equal(listener(message, { id: 'test-id', url: chrome.runtime.getURL('popup/popup.html') }, resolve), true);
  });
  assert.equal(calls, 1);
  assert.equal(response.success, true);
});

test('Interaction capture diagnoses missing listeners and preserves synthetic-event protection', () => {
  const { content, inputs, documentListeners } = pageHarness();
  content.diagnostics.register();
  documentListeners.click({ type: 'click', target: inputs[0], isTrusted: true });
  assert.equal(content.diagnostics.interactions.at(-1).outcome, 'listener_missing');
  content.setupAutofillDropdown(inputs[0], inputs[1]);
  inputs[1].listeners.focus({ type: 'focus', currentTarget: inputs[1], target: inputs[1], isTrusted: false });
  assert.equal(content.activeDropdown, null);
  assert.equal(content.diagnostics.interactions.at(-1).outcome, 'untrusted_event');
  inputs[1].listeners.focus({ type: 'focus', currentTarget: inputs[1], target: inputs[1], isTrusted: true });
  assert.equal(content.diagnostics.interactions.at(-1).outcome, 'focus_without_user_action');
  for (let i = 0; i < 30; i++) documentListeners.click({ type: 'click', target: inputs[0], isTrusted: true });
  assert.equal(content.diagnostics.interactions.length, 20);
});

test('LocKeep autofill targets suppress inline passkey suggestions while retaining login autocomplete tokens', () => {
  const { content, inputs } = pageHarness();
  content.credentials = [{ id: '1' }];
  inputs[0].attributes.autocomplete = 'section-login username webauthn';
  inputs[1].attributes.autocomplete = 'current-password webauthn';
  content.setupAutofillDropdown(inputs[0], inputs[1]);
  assert.equal(inputs[0].attributes.autocomplete, 'section-login username');
  assert.equal(inputs[1].attributes.autocomplete, 'current-password');
  assert.equal(inputs[0]._lockeepInlinePasskeySuppressed, true);
  assert.equal(inputs[1]._lockeepInlinePasskeySuppressed, true);
  assert.equal(inputs[1]._lockeepAutofillListener, true);
});

test('Passkey annotation is untouched without LocKeep accounts, and unrelated autocomplete remains unchanged', () => {
  const { content, inputs } = pageHarness();
  inputs[0].attributes.autocomplete = 'username webauthn';
  content.suppressInlinePasskeySuggestions(inputs[0]);
  assert.equal(inputs[0].attributes.autocomplete, 'username webauthn');
  content.credentials = [{ id: '1' }];
  inputs[0].attributes.autocomplete = '  section-webauthn username  ';
  content.suppressInlinePasskeySuggestions(inputs[0]);
  assert.equal(inputs[0].attributes.autocomplete, '  section-webauthn username  ');
  inputs[0].attributes.autocomplete = 'WebAuthn';
  content.suppressInlinePasskeySuggestions(inputs[0]);
  assert.equal(inputs[0].attributes.autocomplete, 'off');
});

test('SPA-restored passkey annotations on managed fields are removed without a mutation loop', () => {
  const { content, inputs } = pageHarness();
  content.credentials = [{ id: '1' }];
  content.setupAutofillDropdown(inputs[0], inputs[1]);
  let observerCallback;
  let observedAttributes;
  global.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe(root, options) { observedAttributes = options.attributeFilter; }
  };
  try {
    content._setupMutationObserver();
    assert.ok(observedAttributes.includes('autocomplete'));
    inputs[0].attributes.autocomplete = 'username webauthn';
    observerCallback([{ type: 'attributes', attributeName: 'autocomplete', target: inputs[0] }]);
    assert.equal(inputs[0].attributes.autocomplete, 'username');
    let writes = 0;
    inputs[0].setAttribute = () => { writes++; };
    observerCallback([{ type: 'attributes', attributeName: 'autocomplete', target: inputs[0] }]);
    assert.equal(writes, 0);
  } finally { delete global.MutationObserver; }
});

test('Password classification honors autocomplete tokens before WebAuthn annotation is removed', () => {
  const { content, inputs, form } = pageHarness();
  content._authFlowMode = 'signup';
  content._authFlowModeTime = Date.now();
  inputs[1].attributes.autocomplete = 'section-login current-password webauthn';
  assert.equal(content.isKnownLoginPasswordStep(form, inputs[1]), true);
  assert.equal(content.hasLoginFlowSignal(inputs[1]), true);
  assert.equal(content.getSignupReason(form, inputs[1]), null);
  inputs[1].attributes.autocomplete = 'new-password webauthn';
  assert.equal(content.getSignupReason(form, inputs[1]), 'new_password_autocomplete');
});

test('Removed and offscreen dropdowns are differentiated from a working menu', () => {
  const { content } = pageHarness();
  content.activeDropdown = { connected: false };
  assert.deepEqual(content.diagnostics.inspectDropdown(), { present: true, connected: false });
  content.activeDropdown = { connected: true, getBoundingClientRect: () => ({
    width: 250, height: 200, top: 850, bottom: 1050, left: 20, right: 270
  }) };
  assert.equal(content.diagnostics.inspectDropdown().inViewport, false);
});

test('Embedded frames and open shadow password fields are reported without reading their values or URLs', () => {
  const { content, doc, inputs } = pageHarness();
  const passwordInput = inputs[1];
  const shadowHost = { shadowRoot: { querySelectorAll: () => [passwordInput] } };
  const frames = [{ contentDocument: { querySelectorAll: () => [passwordInput] } }, { contentDocument: null }];
  doc.querySelectorAll = selector => selector === '*' ? [shadowHost] : selector === 'iframe, frame' ? frames : inputs;
  assert.deepEqual(content.diagnostics.inspectUnsupportedContexts(), {
    frames: 2, inaccessibleFrames: 1, framePasswordInputs: 1,
    openShadowRoots: 1, shadowPasswordInputs: 1, scanTruncated: false
  });
});

function backgroundHarness() {
  let handler;
  const context = vm.createContext({ URL, Map, console, setTimeout, clearTimeout,
    chrome: { runtime: {
      connectNative: () => { throw new Error('Test bridge unavailable'); },
      onMessage: { addListener: fn => { handler = fn; } }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  vm.runInContext('sendNativeMessage = async (command, data) => { lastQuery = data; if (bridgeFailure) throw new Error(bridgeFailure); return bridgeResult; };', context);
  context.bridgeFailure = '';
  return { context, query: () => new Promise(resolve => handler(
    { type: 'SEARCH_DOMAIN', domain: 'https://untrusted.invalid' },
    { origin: 'https://login.microsoftonline.com', url: 'https://login.microsoftonline.com/login', tab: { id: 1 } }, resolve
  )) };
}

test('Background preserves native errors and keeps the browser-provided origin authoritative', async () => {
  const { context, query } = backgroundHarness();
  context.bridgeResult = { success: false, error: 'VAULT: Operation requires an unlocked vault.' };
  assert.equal((await query()).error, context.bridgeResult.error);
  assert.equal(context.lastQuery.origin, 'https://login.microsoftonline.com');
  context.bridgeFailure = 'Native host disconnected';
  assert.equal((await query()).success, false);
  assert.equal((await query()).error, 'Native host disconnected');
  context.bridgeFailure = '';
  context.bridgeResult = { success: true, data: { entries: [] } };
  assert.equal((await query()).success, true);
  context.bridgeResult = { success: true, data: {} };
  assert.equal((await query()).success, false);
});

function popupHarness(searchResponse, pageResponse) {
  const elements = new Map();
  const element = () => ({ textContent: '', className: '', hidden: true, value: '', listeners: {}, children: [],
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
    focus() {}, select() {}
  });
  const context = vm.createContext({ console, URL, Number, Promise, Date, setTimeout, clearTimeout,
    LocKeepAutofillDiagnostics: Diagnostics,
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element
    },
    navigator: { clipboard: { writeText: async text => { context.copiedText = text; } } },
    chrome: {
      runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage(message, callback) {
        if (message.type === 'GET_LANGUAGE') return Promise.resolve({ language: 'tr' });
        callback(message.type === 'PING' ? { success: true } : searchResponse);
      } },
      tabs: { query: async () => [{ id: 1, url: 'https://login.microsoftonline.com/PRIVATE_PATH?token=SECRET' }],
        sendMessage: async (tabId, message, options) => {
          context.targetFrame = options.frameId;
          if (pageResponse instanceof Error) throw pageResponse;
          return pageResponse;
        } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/popup/popup.js'), 'utf8'), context);
  return { context, elements };
}

test('Popup recognizes the actual locked-vault error and does not label other search failures connected', async () => {
  const locked = popupHarness({ success: false, error: 'VAULT: Operation requires an unlocked vault.' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(locked.elements.get('status').className, 'status locked');
  const failed = popupHarness({ success: false, error: 'Native host disconnected' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.elements.get('status').className, 'status disconnected');
});

test('Popup collects and copies the report from the main frame', async () => {
  const report = { site: 'login.microsoftonline.com', findings: ['stale_empty_cache'] };
  const { context, elements } = popupHarness({ success: true, data: { entries: [] } }, { success: true, report });
  await new Promise(resolve => setImmediate(resolve));
  await elements.get('diagnoseButton').listeners.click();
  assert.equal(context.targetFrame, 0);
  assert.equal(elements.get('diagnoseButton').disabled, false);
  assert.equal(elements.get('reportDetails').hidden, false);
  assert.deepEqual(JSON.parse(elements.get('diagnosticsReport').value), report);
  await elements.get('copyReportButton').listeners.click();
  assert.equal(context.copiedText, elements.get('diagnosticsReport').value);
});

test('Unavailable page script produces a copyable report without leaking the full page URL', async () => {
  const { elements } = popupHarness({ success: true, data: { entries: [] } }, new Error('Receiving end does not exist'));
  await new Promise(resolve => setImmediate(resolve));
  await elements.get('diagnoseButton').listeners.click();
  const report = JSON.parse(elements.get('diagnosticsReport').value);
  assert.deepEqual(report.findings, ['content_script_unavailable']);
  assert.equal(report.site, 'login.microsoftonline.com');
  assert.equal(JSON.stringify(report).includes('PRIVATE_PATH'), false);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});
