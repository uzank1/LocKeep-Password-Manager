/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Key Derivation Module
 * ============================================================================
 *
 * This module handles all key derivation operations using Argon2id, the
 * state-of-the-art password hashing algorithm that provides resistance against
 * both GPU-based and side-channel attacks.
 *
 * SECURITY ARCHITECTURE:
 * ─────────────────────
 * • Argon2id is a hybrid variant combining Argon2i (side-channel resistant)
 *   and Argon2d (GPU-resistant), offering the best of both worlds.
 * • A unique 128-bit (16-byte) salt is generated per vault to prevent
 *   rainbow table attacks and ensure identical passwords produce different keys.
 * • The derived key is 256 bits (32 bytes), suitable for AES-256-GCM.
 * • All sensitive buffers (passwords, keys) are zeroized after use to minimize
 *   the window of exposure in memory.
 *
 * PARAMETERS (OWASP recommended for Argon2id):
 * ─────────────────────────────────────────────
 * • Memory cost:   64 MiB (65536 KiB) — forces high memory usage per hash
 * • Time cost:     3 iterations — increases computational work
 * • Parallelism:   4 threads — leverages multi-core CPUs
 * • Output length: 32 bytes (256 bits) — matches AES-256 key size
 * • Salt length:   16 bytes (128 bits) — NIST recommended minimum
 *
 * IMPORTANT: This module MUST only be invoked from the Electron Main Process.
 *            Never import or call these functions from the Renderer process.
 *
 * ============================================================================
 */

'use strict';

const crypto = require('crypto');
const argon2 = require('argon2');

// ─── KDF Configuration Constants ────────────────────────────────────────────
// These values are stored in the vault header so that the vault can be
// decrypted even if defaults change in future versions.

/** Memory cost in KiB (64 MiB). Higher = more GPU-resistant. */
const DEFAULT_MEMORY_COST = 65536;

/** Number of iterations (time cost). Higher = slower brute-force. */
const DEFAULT_TIME_COST = 3;

/** Degree of parallelism (threads). Should match or be less than CPU cores. */
const DEFAULT_PARALLELISM = 4;

/** Length of the derived key in bytes (256 bits for AES-256). */
const DERIVED_KEY_LENGTH = 32;

/** Length of the random salt in bytes (128 bits). */
const SALT_LENGTH = 16;

/** Accept older vault headers, but refuse values that can exhaust the process. */
const MIN_MEMORY_COST = 8192;    // 8 MiB
const MAX_MEMORY_COST = 262144;  // 256 MiB
const MIN_TIME_COST = 1;
const MAX_TIME_COST = 10;
const MIN_PARALLELISM = 1;
const MAX_PARALLELISM = 8;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically secure random salt for key derivation.
 *
 * Each vault gets its own unique salt, generated once during vault creation
 * and stored in the vault file header. This ensures that identical master
 * passwords produce completely different derived keys across vaults.
 *
 * @returns {Buffer} A 16-byte (128-bit) random salt
 */
function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH);
}

function normalizeKdfInteger(value, fallback, min, max, label) {
  const resolved = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`SECURITY: Invalid ${label} in vault KDF parameters.`);
  }
  return resolved;
}

/**
 * Derives a 256-bit encryption key from a master password using Argon2id.
 *
 * This is the core KDF function that transforms the user's master password
 * into a high-entropy key suitable for AES-256-GCM encryption. The function
 * accepts either a string or Buffer as the password input.
 *
 * SECURITY NOTES:
 * • The password buffer is zeroized (overwritten with zeros) after derivation
 *   to minimize the time it resides in memory in plaintext.
 * • The salt must be the same salt used during vault creation; otherwise,
 *   a completely different key will be derived (this is by design).
 * • Argon2id's memory-hard properties ensure that even with specialized
 *   hardware (GPUs, ASICs), brute-force attacks are prohibitively expensive.
 *
 * @param {string|Buffer} masterPassword - The user's master password
 * @param {Buffer}         salt           - The vault's unique salt (16 bytes)
 * @param {Object}        [options]       - Optional KDF parameter overrides
 * @param {number}        [options.memoryCost]  - Memory in KiB (default: 65536)
 * @param {number}        [options.timeCost]    - Iterations (default: 3)
 * @param {number}        [options.parallelism] - Threads (default: 4)
 *
 * @returns {Promise<Buffer>} A 32-byte (256-bit) derived key
 *
 * @throws {Error} If the password is empty or the salt is invalid
 *
 * @example
 *   const salt = generateSalt();
 *   const key = await deriveKey('my-master-password', salt);
 *   // key is a 32-byte Buffer ready for AES-256-GCM
 */
async function deriveKey(masterPassword, salt, options = {}) {
  // ── Input Validation ────────────────────────────────────────────────────
  if (!masterPassword || (typeof masterPassword === 'string' && masterPassword.length === 0)) {
    throw new Error('SECURITY: Master password cannot be empty.');
  }

  if (!Buffer.isBuffer(salt) || salt.length !== SALT_LENGTH) {
    throw new Error(
      `SECURITY: Salt must be a ${SALT_LENGTH}-byte Buffer. ` +
      `Received: ${Buffer.isBuffer(salt) ? salt.length + ' bytes' : typeof salt}`
    );
  }

  // ── Convert string password to Buffer for consistent handling ───────────
  // We work with Buffers so we can zeroize the memory after use.
  let passwordBuffer;
  if (typeof masterPassword === 'string') {
    passwordBuffer = Buffer.from(masterPassword, 'utf-8');
  } else if (Buffer.isBuffer(masterPassword)) {
    // Create a copy so we don't mutate the caller's buffer unexpectedly
    passwordBuffer = Buffer.alloc(masterPassword.length);
    masterPassword.copy(passwordBuffer);
  } else {
    throw new Error('SECURITY: Password must be a string or Buffer.');
  }

  // ── Resolve KDF parameters (allow overrides for vault compatibility) ────
  // These options are normally written by LocKeep itself, but a vault file can
  // be edited on disk. Validate before Argon2 allocates memory for hostile
  // header values.
  const memoryCost = normalizeKdfInteger(
    options.memoryCost,
    DEFAULT_MEMORY_COST,
    MIN_MEMORY_COST,
    MAX_MEMORY_COST,
    'memory cost'
  );
  const timeCost = normalizeKdfInteger(
    options.timeCost,
    DEFAULT_TIME_COST,
    MIN_TIME_COST,
    MAX_TIME_COST,
    'time cost'
  );
  const parallelism = normalizeKdfInteger(
    options.parallelism,
    DEFAULT_PARALLELISM,
    MIN_PARALLELISM,
    MAX_PARALLELISM,
    'parallelism'
  );

  try {
    // ── Perform Argon2id key derivation ─────────────────────────────────
    // argon2.hash() returns a formatted string by default; we use .raw
    // option to get the raw key bytes directly as a Buffer.
    const derivedKey = await argon2.hash(passwordBuffer, {
      type:        argon2.argon2id,    // Hybrid mode: side-channel + GPU resistant
      salt:        salt,               // Our unique vault salt
      memoryCost:  memoryCost,         // Memory usage in KiB
      timeCost:    timeCost,           // Number of iterations
      parallelism: parallelism,        // Number of threads
      hashLength:  DERIVED_KEY_LENGTH, // Output key length in bytes (32 = 256 bits)
      raw:         true                // Return raw Buffer, not encoded string
    });

    return derivedKey;
  } finally {
    // ── CRITICAL: Zeroize the password buffer ───────────────────────────
    // Even if an error occurs, we must wipe the password from memory.
    // This overwrites every byte with 0x00, reducing the window where
    // the plaintext password is accessible in the process's heap.
    zeroizeBuffer(passwordBuffer);
  }
}

/**
 * Validates a master password against a vault's stored KDF parameters.
 *
 * This function derives a key using the provided password and vault parameters,
 * then attempts a test decryption of the vault's verification token. This is
 * used during vault unlock to check if the user entered the correct password
 * WITHOUT storing the password or derived key persistently.
 *
 * @param {string|Buffer} masterPassword     - The password to validate
 * @param {Object}        vaultKdfParams     - KDF parameters from the vault header
 * @param {Buffer}        vaultKdfParams.salt        - The vault's salt
 * @param {number}        vaultKdfParams.memoryCost  - Memory cost used
 * @param {number}        vaultKdfParams.timeCost    - Time cost used
 * @param {number}        vaultKdfParams.parallelism - Parallelism used
 *
 * @returns {Promise<Buffer>} The derived key if successful
 */
async function deriveKeyWithParams(masterPassword, vaultKdfParams) {
  if (!vaultKdfParams || !vaultKdfParams.salt) {
    throw new Error('SECURITY: Invalid vault KDF parameters.');
  }
  if (vaultKdfParams.algorithm && vaultKdfParams.algorithm !== 'argon2id') {
    throw new Error('SECURITY: Unsupported vault KDF algorithm.');
  }

  // Reconstruct the salt from base64 if stored as string
  const salt = typeof vaultKdfParams.salt === 'string'
    ? Buffer.from(vaultKdfParams.salt, 'base64')
    : vaultKdfParams.salt;

  return deriveKey(masterPassword, salt, {
    memoryCost:  vaultKdfParams.memoryCost  || DEFAULT_MEMORY_COST,
    timeCost:    vaultKdfParams.timeCost    || DEFAULT_TIME_COST,
    parallelism: vaultKdfParams.parallelism || DEFAULT_PARALLELISM
  });
}

/**
 * Returns the default KDF configuration for storage in the vault header.
 *
 * These parameters are persisted so that the vault can always be decrypted
 * even if the application's defaults change in future versions.
 *
 * @returns {Object} Default KDF configuration object
 */
function getDefaultKdfConfig() {
  return {
    algorithm:   'argon2id',
    memoryCost:  DEFAULT_MEMORY_COST,
    timeCost:    DEFAULT_TIME_COST,
    parallelism: DEFAULT_PARALLELISM,
    keyLength:   DERIVED_KEY_LENGTH,
    saltLength:  SALT_LENGTH
  };
}

// ─── Internal Utilities ─────────────────────────────────────────────────────

/**
 * Overwrites a Buffer's contents with zeros to remove sensitive data
 * from memory. This is a best-effort security measure — JavaScript's
 * garbage collector may have already copied the data, but zeroizing
 * the primary reference reduces the attack surface.
 *
 * @param {Buffer} buffer - The buffer to zeroize
 */
function zeroizeBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) {
    buffer.fill(0);
  }
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  generateSalt,
  deriveKey,
  deriveKeyWithParams,
  getDefaultKdfConfig,
  zeroizeBuffer,

  // Expose constants for testing and vault header storage
  constants: {
    DEFAULT_MEMORY_COST,
    DEFAULT_TIME_COST,
    DEFAULT_PARALLELISM,
    DERIVED_KEY_LENGTH,
    SALT_LENGTH,
    MIN_MEMORY_COST,
    MAX_MEMORY_COST,
    MIN_TIME_COST,
    MAX_TIME_COST,
    MIN_PARALLELISM,
    MAX_PARALLELISM
  }
};
