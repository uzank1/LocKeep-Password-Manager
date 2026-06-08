/**
 * ============================================================================
 * LOCKEEP EXTENSION — Background Service Worker
 * ============================================================================
 * Architecture: Browser Extension / Background Layer (Manifest V3 Service Worker)
 *
 * This file is the central message router of the LocKeep browser extension.
 * It sits between two boundaries:
 *
 *   Content Script  ──(chrome.runtime.sendMessage)──►  THIS FILE
 *       (DOM layer)                                     (background SW)
 *                                                          │
 *                                                          ▼
 *                                                    Native Messaging Host
 *                                                      (host.js / Node.js)
 *                                                          │
 *                                                          ▼
 *                                                    Electron Main Process
 *                                                      (vaultManager.js)
 *
 * Responsibilities:
 *   1. Manage the Native Messaging port lifecycle (connect / disconnect / reconnect).
 *   2. Perform ECDH (P-256) key exchange with the native host on first connection,
 *      then derive an AES-256-GCM session key via HKDF-SHA256 for E2EE.
 *   3. Encrypt every outgoing command and decrypt every incoming response.
 *   4. Route messages from content scripts to the appropriate native command.
 *   5. Hold ephemeral, in-memory state for pending saves and multi-step form
 *      username tracking (M-1) — NEVER written to disk.
 *   6. Cache the user's language preference for the content script's i18n layer.
 *
 * SECURITY (E2EE):
 *   - Ephemeral ECDH key pair generated per connection (not persisted).
 *   - Shared secret stretched via HKDF-SHA256 with info string 'lockeep-e2ee-v1'
 *     to achieve domain separation from other potential uses of the same key.
 *   - All post-handshake messages use AES-256-GCM with a fresh 96-bit IV per message.
 *   - On port disconnect, all crypto state (_sharedSecretKey) is immediately nullified.
 * ============================================================================
 */

'use strict';

// L-4: Master toggle for diagnostic console.log statements.
// Set to `true` only during local development / debugging sessions.
// In production, this MUST remain `false` to prevent leaking internal
// state (domains, credential counts, native host responses) to the
// browser's DevTools console.
const DEBUG = false;

/** Native Messaging host identifier — must match the value in the host manifest JSON. */
const HOST_NAME = 'com.sifreyoneticisi.host';

/** @type {chrome.runtime.Port|null} Active native messaging port connection. */
let _port = null;

/** @type {Map<number, {resolve: Function, reject: Function}>} In-flight request ID → {resolve, reject}. */
let _pendingRequests = new Map();

/** Auto-incrementing request ID counter for correlating requests with responses. */
let _requestId = 0;

/** Cached UI language code (e.g. 'en', 'tr', 'de'). Synced from the Electron main process. */
let _cachedLanguage = 'en';

/**
 * @type {Object|null} In-memory pending-save payload.
 * Holds {username, password, url, domain, baseDomain} between the content script's
 * SET_PENDING_SAVE call and the user's decision to save or dismiss.
 * C-03: Auto-cleared after 120 seconds via _pendingSaveTimer to limit exposure window.
 */
let _pendingSave = null;

/** @type {ReturnType<typeof setTimeout>|null} TTL timer handle for auto-clearing _pendingSave. */
let _pendingSaveTimer = null;

// ─── M-1: In-Memory Multi-Step Form State ──────────────────────────────────
// These variables track the most recently typed username across multi-step
// login/registration flows (e.g., Riot Games: Email → Code → Username → Password).
// They are held EXCLUSIVELY in this service worker's V8 heap — never written
// to chrome.storage.local or any other persistent store. If the service worker
// is terminated by Chrome (idle timeout), the values are naturally lost, which
// is the desired security behaviour.

/** @type {string|null} Last captured username text from any credential input field. */
let _lastUsername = null;

/** @type {string|null} Base domain where the username was captured (e.g. 'riotgames.com'). */
let _lastUsernameDomain = null;

/** @type {number} Epoch timestamp (ms) of when _lastUsername was last set. Used for 15-min TTL. */
let _lastUsernameTime = 0;

// ─── E2EE Cryptographic State ───────────────────────────────────────────────
// These are populated during the ECDH handshake and cleared on port disconnect.

/** @type {CryptoKey|null} AES-256-GCM key derived from ECDH + HKDF. Used for all post-handshake E2EE. */
let _sharedSecretKey = null;

/** @type {Promise|null} Resolves when the ECDH handshake completes. Awaited before sending any command. */
let _handshakePromise = null;

// ─── Origin Helpers ─────────────────────────────────────────────────────────
// Content scripts can include a domain in their payload, but Chrome's sender
// metadata is the value we can trust. Extension pages do not have sender.tab,
// so they keep the older explicit-domain path used by the popup status check.

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return '';
  const raw = value.trim();
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return '';
  }
}

function getSenderOrigin(sender) {
  if (!sender || !sender.tab) return '';
  return normalizeOrigin(sender.origin || sender.url || (sender.tab && sender.tab.url) || '');
}

function getEffectiveOrigin(sender, fallback) {
  return getSenderOrigin(sender) || normalizeOrigin(fallback || '');
}

function getBaseDomain(value) {
  const origin = normalizeOrigin(value);
  if (!origin) return '';
  const host = new URL(origin).hostname.toLowerCase();
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

function sameBaseDomain(a, b) {
  const left = getBaseDomain(a);
  const right = getBaseDomain(b);
  return !!left && left === right;
}

function bindEntryToSenderOrigin(entry, origin) {
  const next = { ...(entry || {}) };
  if (origin) {
    // Save prompts can fire after redirects, so we keep the origin that the
    // content script captured, but we never let a web page claim another site.
    next.url = origin;
    next.domain = origin;
    next.baseDomain = getBaseDomain(origin);
  }
  return next;
}

// ─── E2EE Encoding Helpers ──────────────────────────────────────────────────
// Web Crypto API operates on ArrayBuffers, but Chrome's Native Messaging
// protocol uses JSON (which cannot embed raw binary). These helpers convert
// between ArrayBuffer ↔ Base64 strings for wire transport.

/**
 * Converts an ArrayBuffer to a Base64-encoded string.
 * Used to serialise public keys, IVs, and ciphertext for JSON transport.
 * @param {ArrayBuffer} buffer
 * @returns {string} Base64 representation
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a Base64-encoded string back to an ArrayBuffer.
 * Used to deserialise incoming public keys, IVs, and ciphertext from JSON.
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Performs the ECDH key exchange with the native messaging host.
 *
 * Protocol:
 *   1. Generate an ephemeral ECDH key pair (P-256, non-extractable).
 *   2. Send our public key to the host as a HANDSHAKE command.
 *   3. Receive the host's public key in the response.
 *   4. Compute 256 bits of shared secret via ECDH.
 *   5. Stretch the raw ECDH output through HKDF-SHA256 with info='lockeep-e2ee-v1'
 *      to derive the final AES-256-GCM session key.
 *
 * The resulting _sharedSecretKey is stored module-wide and used by
 * encryptPayload() / decryptPayload() for all subsequent messages.
 *
 * @param {chrome.runtime.Port} port - The active native messaging port
 * @returns {Promise<void>} Resolves on successful handshake, rejects on error/timeout
 */
async function performHandshake(port) {
  // Step 1: Generate an ephemeral ECDH key pair (P-256).
  // `extractable: false` ensures the private key cannot be exported from Web Crypto.
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );

  // Export the public key in uncompressed point format for wire transport
  const exportedPubKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const clientPubKeyBase64 = arrayBufferToBase64(exportedPubKey);

  // Step 2: Send HANDSHAKE command and wait for the host's public key
  return new Promise((resolve, reject) => {
    const id = ++_requestId;

    const timeout = setTimeout(() => {
      _pendingRequests.delete(id);
      reject(new Error('Handshake timed out'));
    }, 5000);

    _pendingRequests.set(id, {
      resolve: async (msg) => {
        clearTimeout(timeout);
        try {
          if (!msg.success) throw new Error(msg.error || 'Handshake failed');

          const hostPubKeyBuffer = base64ToArrayBuffer(msg.data.publicKey);
          const hostKey = await crypto.subtle.importKey(
            'raw',
            hostPubKeyBuffer,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
          );

          // Step 4: Compute 256 bits of raw ECDH shared secret
          // H-02: Then derive the final AES key via HKDF-SHA256
          // (must use identical parameters as host.js crypto.hkdfSync)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: hostKey },
            keyPair.privateKey,
            256
          );

          // Step 5a: Import the raw ECDH bits as an HKDF base key
          const hkdfBaseKey = await crypto.subtle.importKey(
            'raw',
            sharedSecretBits,
            'HKDF',
            false,
            ['deriveKey']
          );

          // Step 5b: Derive the final AES-256-GCM key via HKDF.
          // Parameters MUST exactly match host.js: hash=SHA-256, salt=empty, info='lockeep-e2ee-v1'.
          // Any mismatch will produce a different key and cause decryption failures.
          _sharedSecretKey = await crypto.subtle.deriveKey(
            {
              name: 'HKDF',
              hash: 'SHA-256',
              salt: new Uint8Array(0),  // empty salt (matches '' in Node.js hkdfSync)
              info: new TextEncoder().encode('lockeep-e2ee-v1')
            },
            hkdfBaseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
          );

          resolve();
        } catch (e) {
          reject(e);
        }
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    });

    port.postMessage({ _requestId: id, command: 'HANDSHAKE', data: { publicKey: clientPubKeyBase64 } });
  });
}

/**
 * Encrypts a command payload with the E2EE session key (AES-256-GCM).
 *
 * A fresh 96-bit IV is generated for every message. Web Crypto's encrypt()
 * returns the ciphertext concatenated with the 128-bit GCM auth tag, which
 * the host.js side splits and feeds to Node's createDecipheriv separately.
 *
 * @param {Object} payload - The plaintext command object (e.g., { command, data })
 * @returns {Promise<{iv: string, data: string}>} Base64-encoded IV and ciphertext+tag
 */
async function encryptPayload(payload) {
  if (!_sharedSecretKey) throw new Error('E2EE Handshake incomplete');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));

  const ciphertextWithTag = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    _sharedSecretKey,
    encodedPayload
  );

  return {
    iv: arrayBufferToBase64(iv),
    data: arrayBufferToBase64(ciphertextWithTag)
  };
}

/**
 * Decrypts an incoming encrypted response from the native host.
 *
 * Web Crypto's decrypt() expects the auth tag appended to the ciphertext,
 * which matches how host.js's encryptPayload() concatenates them.
 *
 * @param {string} ivBase64   - Base64-encoded 96-bit IV
 * @param {string} dataBase64 - Base64-encoded ciphertext + GCM auth tag
 * @returns {Promise<Object>} Parsed JSON response object
 */
async function decryptPayload(ivBase64, dataBase64) {
  if (!_sharedSecretKey) throw new Error('E2EE Handshake incomplete');

  const iv = base64ToArrayBuffer(ivBase64);
  const ciphertextWithTag = base64ToArrayBuffer(dataBase64);

  const decryptedBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    _sharedSecretKey,
    ciphertextWithTag
  );

  const jsonStr = new TextDecoder().decode(decryptedBuf);
  return JSON.parse(jsonStr);
}

// ─── Native Messaging Port Management ───────────────────────────────────────

/**
 * Lazily establishes and returns the native messaging port connection.
 *
 * On first call (or after a disconnect), this function:
 *   1. Opens a persistent connection to the native host (com.sifreyoneticisi.host).
 *   2. Registers an onMessage listener that routes responses back to the
 *      correct pending Promise via the _requestId correlation key.
 *   3. Registers an onDisconnect listener that cleans up all crypto and
 *      request state, ensuring no stale keys survive a reconnect.
 *   4. Initiates the ECDH handshake (performHandshake) and stores the
 *      resulting Promise in _handshakePromise, which sendNativeMessage()
 *      awaits before sending any encrypted commands.
 *
 * @returns {chrome.runtime.Port} The active native messaging port
 */
function ensurePort() {
  if (_port) return _port;

  _port = chrome.runtime.connectNative(HOST_NAME);

  // Response router: correlates incoming messages with pending request Promises
  _port.onMessage.addListener(async (msg) => {
    if (DEBUG) console.log(" NATIVE RAW MSG:", msg);
    const id = msg._requestId || msg.requestId || msg.id;
    if (id && _pendingRequests.has(id)) {
      const { resolve, reject } = _pendingRequests.get(id);
      _pendingRequests.delete(id);

      try {
        if (msg.encrypted) {
          // Post-handshake: all real responses arrive encrypted
          const decrypted = await decryptPayload(msg.encrypted.iv, msg.encrypted.data);
          resolve(decrypted);
        } else {
          // Pre-handshake or error responses arrive in plaintext
          resolve(msg);
        }
      } catch (e) {
        reject(e);
      }
    }
  });

  // Cleanup handler: nullify all crypto state when the host process exits
  _port.onDisconnect.addListener(() => {
    _port = null;
    _sharedSecretKey = null;
    _handshakePromise = null;
    for (const [, { reject }] of _pendingRequests) {
      reject(new Error('Native host disconnected'));
    }
    _pendingRequests.clear();
  });

  // Initiate the ECDH handshake immediately after connecting
  _handshakePromise = performHandshake(_port).catch(err => {
    console.error('E2EE Handshake Failed:', err);
    _port.disconnect();
    _port = null;
    _handshakePromise = null;
  });

  return _port;
}

/**
 * Sends an E2EE-encrypted command to the native host and returns the decrypted response.
 *
 * Data flow:
 *   1. Ensure a port exists (lazily connect + handshake if needed).
 *   2. Wait for the ECDH handshake to complete (if still in progress).
 *   3. Encrypt the {command, data} payload with the session AES key.
 *   4. Send via the native messaging port with a unique _requestId.
 *   5. The onMessage listener in ensurePort() will route the host's
 *      encrypted response back to this Promise via the correlation ID.
 *
 * @param {string} command - The command verb (e.g., 'QUERY_CREDENTIALS', 'SAVE_CREDENTIAL')
 * @param {Object} [data]  - Command-specific payload
 * @returns {Promise<Object>} Decrypted response from the Electron main process
 */
async function sendNativeMessage(command, data) {
  const port = ensurePort();
  if (_handshakePromise) await _handshakePromise;

  return new Promise(async (resolve, reject) => {
    try {
      const id = ++_requestId;
      const timeout = setTimeout(() => {
        _pendingRequests.delete(id);
        reject(new Error('Request timed out'));
      }, 5000);

      _pendingRequests.set(id, {
        resolve: (msg) => { clearTimeout(timeout); resolve(msg); },
        reject: (err) => { clearTimeout(timeout); reject(err); }
      });

      const encryptedData = await encryptPayload({ command, data });
      port.postMessage({ _requestId: id, command: 'ENCRYPTED', data: encryptedData });
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Language Synchronisation ───────────────────────────────────────────────

/**
 * Fetches the user's preferred language from the Electron main process
 * (stored in settings.json) and caches it in _cachedLanguage.
 *
 * Called once at service worker startup and again on every GET_LANGUAGE
 * request from a content script, ensuring the cached value stays fresh.
 * If the native host is unreachable, the previously cached value is retained.
 */
async function syncLanguage() {
  try {
    const response = await sendNativeMessage('GET_LANGUAGE');
    if (response.success && response.data && response.data.language) {
      _cachedLanguage = response.data.language;
    }
  } catch { /* use cached value — native host may not be running yet */ }
}

// Eagerly sync language on service worker startup
syncLanguage();

// ─── Message Handler (Content Scripts → Background) ─────────────────────────
// This is the single entry point for all messages from content_script.js.
// Each message.type maps to a specific action: querying credentials,
// saving entries, managing pending saves, tracking multi-step form state,
// generating passwords, or returning the cached language.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    let response;

    try {
      switch (message.type) {
        case 'PING':
          response = await sendNativeMessage('PING');
          break;
        case 'SEARCH_DOMAIN':
          try {
            if (DEBUG) console.log(`[DIAGNOSTIC - Background] 1. Received SEARCH_DOMAIN raw domain: "${message.domain}"`);
            const cleanOrigin = getEffectiveOrigin(sender, message.domain);
            if (DEBUG) console.log(`[DIAGNOSTIC - Background] 2. Sending to Native Host (cleanOrigin): "${cleanOrigin}"`);
            response = await sendNativeMessage('QUERY_CREDENTIALS', { domain: cleanOrigin, origin: cleanOrigin });
            if (DEBUG) console.log(`[DIAGNOSTIC - Background] 3. Response from Native Host:`, response);

            // If the vault is locked, pass the error through to the content script as-is.
            // The content script / popup will display the appropriate "vault locked" message.
            if (response && response.error === 'Vault is locked.') {
              // Intentionally not modifying the response — the error propagates directly
            } else if (!response || !response.success || !response.data || !Array.isArray(response.data.entries)) {
              response = { success: true, data: { entries: [] } };
            }
          } catch (e) {
            response = { success: true, data: { entries: [] } };
          }
          break;

        case 'GET_CREDENTIAL':
          {
            // The page can suggest an origin, but sender metadata wins when a
            // content script is involved.
            const origin = getEffectiveOrigin(sender, message.origin || message.domain);
            response = await sendNativeMessage('GET_CREDENTIAL', { id: message.id, origin });
          }
          break;
        case 'ADD_ENTRY':
          {
            const origin = getEffectiveOrigin(sender, message.entry && message.entry.url);
            const entry = bindEntryToSenderOrigin(message.entry, origin);
            response = await sendNativeMessage('SAVE_CREDENTIAL', entry);
          }
          if (response && response.success) {
            _pendingSave = null;
            if (_pendingSaveTimer) { clearTimeout(_pendingSaveTimer); _pendingSaveTimer = null; }
            _lastUsername = null;
            _lastUsernameDomain = null;
            _lastUsernameTime = 0;
          }
          break;
        case 'SET_PENDING_SAVE':
          {
            const origin = getEffectiveOrigin(sender, message.entry && message.entry.url);
            _pendingSave = bindEntryToSenderOrigin(message.entry, origin);
          }
          // C-03: Auto-clear _pendingSave after 120 seconds to limit the window
          // during which plaintext credentials exist in the service worker's memory
          if (_pendingSaveTimer) clearTimeout(_pendingSaveTimer);
          _pendingSaveTimer = setTimeout(() => { _pendingSave = null; _pendingSaveTimer = null; }, 120 * 1000);
          response = { success: true };
          break;
        case 'GET_PENDING_SAVE':
          {
            const origin = getSenderOrigin(sender);
            const pendingOk = !_pendingSave || !origin || sameBaseDomain(origin, _pendingSave.url || _pendingSave.domain);
            response = { success: true, data: pendingOk ? _pendingSave : null };
          }
          break;
        case 'CLEAR_PENDING_SAVE':
          _pendingSave = null;
          if (_pendingSaveTimer) { clearTimeout(_pendingSaveTimer); _pendingSaveTimer = null; }
          _lastUsername = null;
          _lastUsernameDomain = null;
          _lastUsernameTime = 0;
          response = { success: true };
          break;
        case 'SET_LAST_USERNAME':
          _lastUsername = message.username;
          {
            const origin = getEffectiveOrigin(sender, message.domain);
            _lastUsernameDomain = getBaseDomain(origin || message.domain);
          }
          _lastUsernameTime = Date.now();
          response = { success: true };
          break;
        case 'GET_LAST_USERNAME':
          {
            const origin = getSenderOrigin(sender);
            const sameSite = !origin || sameBaseDomain(origin, _lastUsernameDomain);
            if (_lastUsername && sameSite && Date.now() - _lastUsernameTime < 15 * 60 * 1000) {
              response = {
                success: true,
                username: _lastUsername,
                domain: _lastUsernameDomain,
                time: _lastUsernameTime
              };
            } else {
              _lastUsername = null;
              _lastUsernameDomain = null;
              _lastUsernameTime = 0;
              response = { success: false, error: 'Expired or not set' };
            }
          }
          break;
        case 'CLEAR_LAST_USERNAME':
          _lastUsername = null;
          _lastUsernameDomain = null;
          _lastUsernameTime = 0;
          response = { success: true };
          break;
        case 'GENERATE_PASSWORD':
          response = await sendNativeMessage('GENERATE_PASSWORD', message.options || {});
          break;
        case 'GET_LANGUAGE':
          syncLanguage();
          response = { success: true, language: _cachedLanguage };
          break;
        default:
          response = { success: false, error: 'Unknown message type' };
      }
    } catch (err) {
      response = { success: false, error: err.message };
    }

    sendResponse(response);
  })();

  return true; // REQUIRED: keeps the message channel open for async sendResponse()
});
