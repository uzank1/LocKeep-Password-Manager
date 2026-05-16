/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Secure Random Module
 * ============================================================================
 * Cryptographically secure random generation for salts, IVs, IDs, and
 * passwords. Wraps Node.js crypto.randomBytes with domain-specific helpers.
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const crypto = require('crypto');

// ─── Character Sets for Password Generation ─────────────────────────────────

const CHARSETS = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  digits:    '0123456789',
  symbols:   '!@#$%^&*()_+-=[]{}|;:,.<>?/~`'
};

/**
 * Generates cryptographically secure random bytes.
 * Thin wrapper around crypto.randomBytes for consistency.
 *
 * @param {number} length - Number of bytes
 * @returns {Buffer} Random bytes
 */
function randomBytes(length) {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error('RANDOM: Length must be a positive integer.');
  }
  return crypto.randomBytes(length);
}

/**
 * Generates a random integer in [0, max) using rejection sampling
 * to avoid modulo bias. This ensures perfectly uniform distribution.
 *
 * @param {number} max - Upper bound (exclusive)
 * @returns {number} Uniform random integer in [0, max)
 */
function uniformRandomInt(max) {
  if (max < 1) throw new Error('RANDOM: max must be >= 1.');
  if (max === 1) return 0;

  // Calculate the largest multiple of max that fits in 32 bits.
  // We reject any random value >= limit to eliminate modulo bias.
  const limit = Math.floor(0xFFFFFFFF / max) * max;

  let value;
  do {
    // Read 4 bytes as an unsigned 32-bit integer
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);

  return value % max;
}

/**
 * Generates a cryptographically secure random password.
 *
 * Uses rejection sampling (uniformRandomInt) to select characters
 * from the allowed charset, ensuring no modulo bias. Guarantees
 * at least one character from each enabled charset when length permits.
 *
 * @param {number} [length=20] - Password length (12–128)
 * @param {Object} [options] - Character set options
 * @param {boolean} [options.uppercase=true]  - Include A-Z
 * @param {boolean} [options.lowercase=true]  - Include a-z
 * @param {boolean} [options.digits=true]     - Include 0-9
 * @param {boolean} [options.symbols=true]    - Include special characters
 * @param {string}  [options.exclude='']      - Characters to exclude
 * @returns {{ password: string, entropy: number, charset: number }}
 */
function generatePassword(length = 20, options = {}) {
  // Validate length
  const len = Math.max(4, Math.min(128, Math.floor(length)));

  // Build the charset from enabled categories
  const useUpper   = options.uppercase !== false;
  const useLower   = options.lowercase !== false;
  const useDigits  = options.digits    !== false;
  const useSymbols = options.symbols   !== false;
  const exclude    = options.exclude   || '';

  let charset = '';
  const requiredChars = []; // Guarantee at least one from each category

  if (useUpper) {
    const filtered = filterChars(CHARSETS.uppercase, exclude);
    charset += filtered;
    if (filtered.length > 0) requiredChars.push(filtered[uniformRandomInt(filtered.length)]);
  }
  if (useLower) {
    const filtered = filterChars(CHARSETS.lowercase, exclude);
    charset += filtered;
    if (filtered.length > 0) requiredChars.push(filtered[uniformRandomInt(filtered.length)]);
  }
  if (useDigits) {
    const filtered = filterChars(CHARSETS.digits, exclude);
    charset += filtered;
    if (filtered.length > 0) requiredChars.push(filtered[uniformRandomInt(filtered.length)]);
  }
  if (useSymbols) {
    const filtered = filterChars(CHARSETS.symbols, exclude);
    charset += filtered;
    if (filtered.length > 0) requiredChars.push(filtered[uniformRandomInt(filtered.length)]);
  }

  if (charset.length === 0) {
    throw new Error('RANDOM: No characters available for password generation.');
  }

  // Generate the password using uniform random selection
  const passwordChars = new Array(len);

  // Place required chars at random positions (guarantees diversity)
  const usedPositions = new Set();
  for (let i = 0; i < Math.min(requiredChars.length, len); i++) {
    let pos;
    do { pos = uniformRandomInt(len); } while (usedPositions.has(pos));
    usedPositions.add(pos);
    passwordChars[pos] = requiredChars[i];
  }

  // Fill remaining positions with random chars from full charset
  for (let i = 0; i < len; i++) {
    if (!passwordChars[i]) {
      passwordChars[i] = charset[uniformRandomInt(charset.length)];
    }
  }

  const password = passwordChars.join('');

  // Calculate entropy: log2(charset_size ^ length) = length * log2(charset_size)
  const entropy = Math.round(len * Math.log2(charset.length) * 100) / 100;

  return {
    password,
    entropy,       // Bits of entropy
    charsetSize: charset.length
  };
}

/**
 * Generates a random hex string (e.g., for entry IDs).
 * @param {number} [bytes=16] - Number of random bytes (hex output = bytes * 2)
 * @returns {string} Hex-encoded random string
 */
function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generates a v4-style UUID using crypto.randomUUID().
 * @returns {string} RFC 4122 v4 UUID
 */
function randomUUID() {
  return crypto.randomUUID();
}

// ─── Internal Utilities ─────────────────────────────────────────────────────

/**
 * Filters out excluded characters from a charset string.
 * @param {string} chars   - Original charset
 * @param {string} exclude - Characters to remove
 * @returns {string} Filtered charset
 */
function filterChars(chars, exclude) {
  if (!exclude) return chars;
  return chars.split('').filter(c => !exclude.includes(c)).join('');
}

module.exports = {
  randomBytes,
  uniformRandomInt,
  generatePassword,
  randomHex,
  randomUUID,
  CHARSETS
};
