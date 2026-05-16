/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Encryption Module
 * ============================================================================
 * AES-256-GCM authenticated encryption with unique IV per operation.
 * Provides confidentiality + integrity in a single step.
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const crypto = require('crypto');

const ALGORITHM      = 'aes-256-gcm';
const IV_LENGTH      = 12;  // 96 bits — NIST recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits — full GCM security
const KEY_LENGTH     = 32;  // 256 bits for AES-256
const ENCODING       = 'base64';

/**
 * Validates that a key is a 32-byte Buffer suitable for AES-256.
 * @param {Buffer} key
 */
function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new Error(
      `SECURITY: Key must be a ${KEY_LENGTH}-byte Buffer. Got: ${Buffer.isBuffer(key) ? key.length + 'B' : typeof key}`
    );
  }
}

/**
 * Encrypts plaintext using AES-256-GCM with a fresh random IV.
 *
 * @param {string|Buffer|Object} plaintext - Data to encrypt (objects are JSON-serialized)
 * @param {Buffer} key - 32-byte encryption key from Argon2id
 * @param {Buffer|string} [aad] - Optional Additional Authenticated Data
 * @returns {{ iv: string, ciphertext: string, authTag: string }} Base64-encoded envelope
 */
function encrypt(plaintext, key, aad = null) {
  validateKey(key);

  // Serialize input to Buffer
  let ptBuf;
  if (Buffer.isBuffer(plaintext)) {
    ptBuf = plaintext;
  } else if (typeof plaintext === 'object' && plaintext !== null) {
    ptBuf = Buffer.from(JSON.stringify(plaintext), 'utf-8');
  } else if (typeof plaintext === 'string') {
    ptBuf = Buffer.from(plaintext, 'utf-8');
  } else {
    throw new Error('ENCRYPTION: Plaintext must be string, Buffer, or Object.');
  }

  // CRITICAL: Fresh IV for every operation — reuse breaks GCM completely
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  if (aad) {
    cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(String(aad), 'utf-8'));
  }

  const encrypted = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Zeroize plaintext buffer
  ptBuf.fill(0);

  return {
    iv:         iv.toString(ENCODING),
    ciphertext: encrypted.toString(ENCODING),
    authTag:    authTag.toString(ENCODING)
  };
}

/**
 * Decrypts AES-256-GCM encrypted data and verifies integrity via auth tag.
 *
 * @param {{ iv: string, ciphertext: string, authTag: string }} encData - Encrypted envelope
 * @param {Buffer} key - Same 32-byte key used for encryption
 * @param {Buffer|string} [aad] - Same AAD used during encryption (if any)
 * @param {boolean} [parseJson=true] - Attempt JSON parse on result
 * @returns {string|Object} Decrypted plaintext
 * @throws {Error} On wrong key or tampered data (auth tag mismatch)
 */
function decrypt(encData, key, aad = null, parseJson = true) {
  validateKey(key);

  if (!encData || !encData.iv || !encData.ciphertext || !encData.authTag) {
    throw new Error('DECRYPTION: Invalid envelope. Need { iv, ciphertext, authTag }.');
  }

  const iv         = Buffer.from(encData.iv, ENCODING);
  const ciphertext = Buffer.from(encData.ciphertext, ENCODING);
  const authTag    = Buffer.from(encData.authTag, ENCODING);

  if (iv.length !== IV_LENGTH) {
    throw new Error(`DECRYPTION: IV must be ${IV_LENGTH} bytes, got ${iv.length}.`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`DECRYPTION: Auth tag must be ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}.`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  if (aad) {
    decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(String(aad), 'utf-8'));
  }

  let decBuf;
  try {
    decBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      'DECRYPTION FAILED: Auth tag verification failed. ' +
      'Wrong master password or tampered vault data.'
    );
  }

  const result = decBuf.toString('utf-8');
  decBuf.fill(0); // Zeroize

  if (parseJson) {
    try { return JSON.parse(result); } catch { return result; }
  }
  return result;
}

/**
 * Compact encrypt: returns "iv.ciphertext.authTag" as a single string.
 */
function encryptCompact(plaintext, key) {
  const r = encrypt(plaintext, key);
  return `${r.iv}.${r.ciphertext}.${r.authTag}`;
}

/**
 * Compact decrypt: parses "iv.ciphertext.authTag" dot-separated string.
 */
function decryptCompact(compactStr, key, parseJson = true) {
  const p = compactStr.split('.');
  if (p.length !== 3) throw new Error('DECRYPTION: Invalid compact format.');
  return decrypt({ iv: p[0], ciphertext: p[1], authTag: p[2] }, key, null, parseJson);
}

module.exports = {
  encrypt, decrypt, encryptCompact, decryptCompact, validateKey,
  constants: { ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH, KEY_LENGTH, ENCODING }
};
