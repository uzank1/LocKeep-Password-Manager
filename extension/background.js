/**
 * ============================================================================
 * LOCKEEP EXTENSION — Background Service Worker
 * ============================================================================
 * Manages the native messaging port lifecycle and routes commands from
 * content scripts to the native messaging host.
 *
 * SECURITY (E2EE):
 * - Implements ECDH key exchange on connection to establish a shared secret.
 * - Encrypts all subsequent messages with AES-256-GCM using Web Crypto API.
 * ============================================================================
 */

'use strict';

const DEBUG = false;

const HOST_NAME = 'com.sifreyoneticisi.host';
let _port = null;
let _pendingRequests = new Map();
let _requestId = 0;
let _cachedLanguage = 'en';
let _pendingSave = null;
/** @type {ReturnType<typeof setTimeout>|null} C-03: TTL timer for _pendingSave auto-clear */
let _pendingSaveTimer = null;

// Multi-step form tracking in-memory state (M-1)
let _lastUsername = null;
let _lastUsernameDomain = null;
let _lastUsernameTime = 0;

// E2EE State
let _sharedSecretKey = null;
let _handshakePromise = null;

// ─── E2EE Helpers ───────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

async function performHandshake(port) {
  // Generate ECDH Key Pair
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );

  const exportedPubKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const clientPubKeyBase64 = arrayBufferToBase64(exportedPubKey);

  // Send Handshake Request
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

          // H-02: Derive AES key via HKDF-SHA256 (matches host.js crypto.hkdfSync)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: hostKey },
            keyPair.privateKey,
            256
          );

          // Import the raw ECDH bits as an HKDF base key
          const hkdfBaseKey = await crypto.subtle.importKey(
            'raw',
            sharedSecretBits,
            'HKDF',
            false,
            ['deriveKey']
          );

          // Derive the final AES-GCM key via HKDF with matching parameters
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

// ─── Native Messaging Port ──────────────────────────────────────────────────

function ensurePort() {
  if (_port) return _port;

  _port = chrome.runtime.connectNative(HOST_NAME);

  _port.onMessage.addListener(async (msg) => {
    if (DEBUG) console.log(" NATIVE RAW MSG:", msg);
    const id = msg._requestId || msg.requestId || msg.id;
    if (id && _pendingRequests.has(id)) {
      const { resolve, reject } = _pendingRequests.get(id);
      _pendingRequests.delete(id);

      try {
        if (msg.encrypted) {
          // Decrypt successful encrypted response
          const decrypted = await decryptPayload(msg.encrypted.iv, msg.encrypted.data);
          resolve(decrypted);
        } else {
          // Pass-through (e.g., handshake or error response)
          resolve(msg);
        }
      } catch (e) {
        reject(e);
      }
    }
  });

  _port.onDisconnect.addListener(() => {
    _port = null;
    _sharedSecretKey = null;
    _handshakePromise = null;
    for (const [, { reject }] of _pendingRequests) {
      reject(new Error('Native host disconnected'));
    }
    _pendingRequests.clear();
  });

  // Start Handshake
  _handshakePromise = performHandshake(_port).catch(err => {
    console.error('E2EE Handshake Failed:', err);
    _port.disconnect();
    _port = null;
    _handshakePromise = null;
  });

  return _port;
}

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

// ─── Language Sync ──────────────────────────────────────────────────────────

async function syncLanguage() {
  try {
    const response = await sendNativeMessage('GET_LANGUAGE');
    if (response.success && response.data && response.data.language) {
      _cachedLanguage = response.data.language;
    }
  } catch { /* use cached */ }
}

syncLanguage();

// ─── Message Handler (Content Scripts → Background) ─────────────────────────

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
            let cleanOrigin = message.domain;
            try {
              cleanOrigin = new URL(cleanOrigin.startsWith('http') ? cleanOrigin : `https://${cleanOrigin}`).origin;
            } catch (e) { }
            if (DEBUG) console.log(`[DIAGNOSTIC - Background] 2. Sending to Native Host (cleanOrigin): "${cleanOrigin}"`);
            response = await sendNativeMessage('QUERY_CREDENTIALS', { domain: cleanOrigin });
            if (DEBUG) console.log(`[DIAGNOSTIC - Background] 3. Response from Native Host:`, response);

            // KESİN ÇÖZÜM: Kasa kilitli hatası geldiyse filtreye sokma, doğrudan popup'a ilet
            if (response && response.error === 'Vault is locked.') {
              // response nesnesine dokunmuyoruz, hata olduğu gibi popup.js'e aktarılacak
            } else if (!response || !response.success || !response.data || !Array.isArray(response.data.entries)) {
              response = { success: true, data: { entries: [] } };
            }
          } catch (e) {
            response = { success: true, data: { entries: [] } };
          }
          break;

        case 'GET_CREDENTIAL':
          response = await sendNativeMessage('GET_CREDENTIAL', { id: message.id });
          break;
        case 'ADD_ENTRY':
          if (message.entry && message.entry.url) {
            try { message.entry.url = new URL(message.entry.url).origin; } catch (e) { }
          }
          response = await sendNativeMessage('SAVE_CREDENTIAL', message.entry);
          if (response && response.success) {
            _pendingSave = null;
            if (_pendingSaveTimer) { clearTimeout(_pendingSaveTimer); _pendingSaveTimer = null; }
            _lastUsername = null;
            _lastUsernameDomain = null;
            _lastUsernameTime = 0;
          }
          break;
        case 'SET_PENDING_SAVE':
          _pendingSave = message.entry;
          if (_pendingSave && _pendingSave.url) {
            try { _pendingSave.url = new URL(_pendingSave.url).origin; } catch (e) { }
          }
          // C-03: Auto-clear _pendingSave after 120 seconds to limit credential exposure
          if (_pendingSaveTimer) clearTimeout(_pendingSaveTimer);
          _pendingSaveTimer = setTimeout(() => { _pendingSave = null; _pendingSaveTimer = null; }, 120 * 1000);
          response = { success: true };
          break;
        case 'GET_PENDING_SAVE':
          response = { success: true, data: _pendingSave };
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
          _lastUsernameDomain = message.domain;
          _lastUsernameTime = Date.now();
          response = { success: true };
          break;
        case 'GET_LAST_USERNAME':
          if (_lastUsername && Date.now() - _lastUsernameTime < 15 * 60 * 1000) {
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

  return true; // Keep message channel open for async response
});
