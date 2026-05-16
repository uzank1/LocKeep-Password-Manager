/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Vault Manager
 * ============================================================================
 * Core vault CRUD: create, unlock, lock, add/update/delete entries, search.
 *
 * VAULT FILE FORMAT (v1):
 * {
 *   "version": 1,
 *   "kdf": { algorithm, salt, memoryCost, timeCost, parallelism },
 *   "data": { iv, ciphertext, authTag },
 *   "integrity": "<sha256 hex of plaintext JSON before encryption>"
 * }
 *
 * The "data" blob is a single AES-256-GCM encrypted JSON array of entries.
 * Decrypted entry shape:
 * {
 *   id, title, username, password, url, notes, category,
 *   createdAt, updatedAt, favorite
 * }
 *
 * SECURITY:
 * - All crypto runs here (Main process only)
 * - Derived key held in memory only while vault is unlocked
 * - lockVault() zeroizes key and plaintext entries
 * - Custom vault path supported (e.g., encrypted USB)
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const { generateSalt, deriveKey, deriveKeyWithParams, getDefaultKdfConfig, zeroizeBuffer } = require('../crypto/keyDerivation');
const { encrypt, decrypt } = require('../crypto/encryption');
const { randomUUID } = require('../crypto/secureRandom');

// ─── Constants ──────────────────────────────────────────────────────────────

const VAULT_FILENAME = 'vault.dat';
const SETTINGS_FILENAME = 'settings.json';
const VAULT_VERSION = 1;

// ─── Module State (private) ─────────────────────────────────────────────────

/** @type {Buffer|null} Derived master key — only populated while unlocked */
let _masterKey = null;

/** @type {Array|null} Decrypted entries — only populated while unlocked */
let _entries = null;

/** @type {Object|null} Vault header (kdf params, version) */
let _vaultHeader = null;

/** @type {string|null} Full path to the active vault file */
let _vaultPath = null;

/** @type {boolean} Whether the vault is currently unlocked */
let _isUnlocked = false;

// ─── Path Management ────────────────────────────────────────────────────────

/**
 * Returns the default vault directory (%APPDATA%/LocKeepPasswordManager).
 * Creates the directory if it does not exist.
 * @returns {string} Absolute path to the vault directory
 */
function getDefaultVaultDir() {
  const dir = path.join(app.getPath('appData'), 'LocKeepPasswordManager');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the active vault file path.
 * If a custom path was set, returns that; otherwise uses default.
 * @returns {string} Absolute path to the vault file
 */
function getVaultPath() {
  if (_vaultPath) return _vaultPath;
  return path.join(getDefaultVaultDir(), VAULT_FILENAME);
}

/**
 * Sets a custom vault file path (e.g., USB drive).
 * @param {string} customPath - Absolute path to the vault file
 */
function setVaultPath(customPath) {
  if (!customPath || typeof customPath !== 'string') {
    throw new Error('VAULT: Custom path must be a non-empty string.');
  }
  _vaultPath = customPath;
  saveSettings({ vaultPath: customPath });
}

/**
 * Resets the vault path to the default location.
 */
function resetVaultPath() {
  _vaultPath = null;
  saveSettings({ vaultPath: null });
}

/**
 * Returns the settings file path.
 * @returns {string}
 */
function getSettingsPath() {
  return path.join(getDefaultVaultDir(), SETTINGS_FILENAME);
}

/**
 * Loads user settings from disk (vault path, language, auto-lock timeout).
 * @returns {Object} Settings object (empty if file doesn't exist)
 */
function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Corrupted settings — return defaults
  }
  return {};
}

/**
 * Saves user settings to disk (merged with existing).
 * @param {Object} newSettings - Settings to merge
 */
function saveSettings(newSettings) {
  try {
    const settingsPath = getSettingsPath();
    const existing = loadSettings();
    const merged = { ...existing, ...newSettings };
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err) {
    console.error('VAULT: Failed to save settings:', err.message);
  }
}

/**
 * Initializes the vault path from saved settings (call at app startup).
 */
function initializeFromSettings() {
  const settings = loadSettings();
  if (settings.vaultPath && fs.existsSync(settings.vaultPath)) {
    _vaultPath = settings.vaultPath;
  }
}

// ─── Vault Lifecycle ────────────────────────────────────────────────────────

/**
 * Checks whether a vault file exists at the active path.
 * @returns {boolean}
 */
function vaultExists() {
  return fs.existsSync(getVaultPath());
}

/**
 * Returns whether the vault is currently unlocked.
 * @returns {boolean}
 */
function isUnlocked() {
  return _isUnlocked;
}

/**
 * Creates a new vault with the given master password.
 *
 * Steps:
 * 1. Generate a random 128-bit salt
 * 2. Derive a 256-bit master key via Argon2id
 * 3. Encrypt an empty entries array with the derived key
 * 4. Write the vault file with KDF params + encrypted data
 * 5. Leave the vault in an unlocked state
 *
 * @param {string} masterPassword - The user's chosen master password
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function createVault(masterPassword) {
  if (!masterPassword || masterPassword.length < 8) {
    return { success: false, message: 'Master password must be at least 8 characters.' };
  }

  if (vaultExists()) {
    return { success: false, message: 'A vault already exists at this location.' };
  }

  // Step 1: Generate salt
  const salt = generateSalt();

  // Step 2: Derive master key
  const kdfConfig = getDefaultKdfConfig();
  _masterKey = await deriveKey(masterPassword, salt, {
    memoryCost: kdfConfig.memoryCost,
    timeCost: kdfConfig.timeCost,
    parallelism: kdfConfig.parallelism
  });

  // Step 3: Encrypt empty entries array
  _entries = [];
  const plaintext = JSON.stringify(_entries);
  const integrity = computeIntegrity(plaintext);
  const encryptedData = encrypt(plaintext, _masterKey);

  // Step 4: Build and write vault file
  _vaultHeader = {
    version: VAULT_VERSION,
    kdf: {
      algorithm: kdfConfig.algorithm,
      salt: salt.toString('base64'),
      memoryCost: kdfConfig.memoryCost,
      timeCost: kdfConfig.timeCost,
      parallelism: kdfConfig.parallelism
    }
  };

  const vaultFile = {
    ..._vaultHeader,
    data: encryptedData,
    integrity
  };

  writeVaultFile(vaultFile);
  _isUnlocked = true;

  return { success: true, message: 'Vault created successfully.' };
}

/**
 * Unlocks an existing vault by deriving the key and decrypting.
 *
 * @param {string} masterPassword - The user's master password
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function unlockVault(masterPassword) {
  if (_isUnlocked) {
    return { success: true, message: 'Vault is already unlocked.' };
  }

  if (!vaultExists()) {
    return { success: false, message: 'No vault found. Please create one first.' };
  }

  // Read vault file
  const vaultFile = readVaultFile();
  if (!vaultFile || vaultFile.version !== VAULT_VERSION) {
    return { success: false, message: 'Unsupported vault version.' };
  }

  // Derive key using stored KDF params
  try {
    _masterKey = await deriveKeyWithParams(masterPassword, vaultFile.kdf);
  } catch (err) {
    return { success: false, message: 'Key derivation failed: ' + err.message };
  }

  // Decrypt vault data
  try {
    const decrypted = decrypt(vaultFile.data, _masterKey, null, false);

    // Verify integrity
    if (vaultFile.integrity) {
      const currentIntegrity = computeIntegrity(decrypted);
      if (currentIntegrity !== vaultFile.integrity) {
        zeroizeState();
        return { success: false, message: 'SECURITY ALERT: Vault integrity check failed. Data may be tampered.' };
      }
    }

    _entries = JSON.parse(decrypted);
    _vaultHeader = { version: vaultFile.version, kdf: vaultFile.kdf };
    _isUnlocked = true;

    return { success: true, message: 'Vault unlocked successfully.' };
  } catch (err) {
    zeroizeState();
    return { success: false, message: 'Wrong master password or corrupted vault.' };
  }
}

/**
 * Locks the vault: zeroizes the master key and decrypted entries.
 * @returns {{ success: boolean, message: string }}
 */
function lockVault() {
  zeroizeState();
  return { success: true, message: 'Vault locked.' };
}

/**
 * Changes the master password. Re-encrypts the vault with a new key.
 *
 * @param {string} currentPassword - Current master password (for verification)
 * @param {string} newPassword     - New master password
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function changeMasterPassword(currentPassword, newPassword) {
  if (!_isUnlocked) {
    return { success: false, message: 'Vault must be unlocked first.' };
  }

  if (!newPassword || newPassword.length < 8) {
    return { success: false, message: 'New password must be at least 8 characters.' };
  }

  // Verify current password by deriving key and comparing
  try {
    const verifyKey = await deriveKeyWithParams(currentPassword, _vaultHeader.kdf);
    if (!crypto.timingSafeEqual(verifyKey, _masterKey)) {
      zeroizeBuffer(verifyKey);
      return { success: false, message: 'Current password is incorrect.' };
    }
    zeroizeBuffer(verifyKey);
  } catch {
    return { success: false, message: 'Current password verification failed.' };
  }

  // Generate new salt and derive new key
  const newSalt = generateSalt();
  const kdfConfig = getDefaultKdfConfig();
  const newKey = await deriveKey(newPassword, newSalt, {
    memoryCost: kdfConfig.memoryCost,
    timeCost: kdfConfig.timeCost,
    parallelism: kdfConfig.parallelism
  });

  // Re-encrypt entries with new key
  zeroizeBuffer(_masterKey);
  _masterKey = newKey;

  _vaultHeader.kdf = {
    algorithm: kdfConfig.algorithm,
    salt: newSalt.toString('base64'),
    memoryCost: kdfConfig.memoryCost,
    timeCost: kdfConfig.timeCost,
    parallelism: kdfConfig.parallelism
  };

  persistVault();
  return { success: true, message: 'Master password changed successfully.' };
}

// ─── Entry CRUD ─────────────────────────────────────────────────────────────

/**
 * Returns all decrypted entries (vault must be unlocked).
 * @returns {Array} Array of entry objects
 */
function getEntries() {
  requireUnlocked();
  // Return deep copy to prevent external mutation of internal state
  return JSON.parse(JSON.stringify(_entries));
}

/**
 * Returns a single entry by ID.
 * @param {string} id - Entry UUID
 * @returns {Object|null} The entry or null if not found
 */
function getEntryById(id) {
  requireUnlocked();
  const entry = _entries.find(e => e.id === id);
  return entry ? { ...entry } : null;
}

/**
 * Adds a new entry to the vault and persists.
 *
 * @param {Object} entryData - Entry fields:
 *   { title, username, password, url, notes, category, favorite }
 * @returns {{ success: boolean, entry: Object }}
 */
function addEntry(entryData) {
  requireUnlocked();

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    title: entryData.title || '',
    username: entryData.username || '',
    password: entryData.password || '',
    url: entryData.url || '',
    notes: entryData.notes || '',
    category: entryData.category || 'login',
    favorite: entryData.favorite || false,
    createdAt: now,
    updatedAt: now
  };

  _entries.push(entry);
  persistVault();

  return { success: true, entry: { ...entry } };
}

/**
 * Updates an existing entry.
 *
 * @param {string} id        - Entry UUID
 * @param {Object} updates   - Fields to update
 * @returns {{ success: boolean, entry?: Object, message?: string }}
 */
function updateEntry(id, updates) {
  requireUnlocked();

  const idx = _entries.findIndex(e => e.id === id);
  if (idx === -1) {
    return { success: false, message: 'Entry not found.' };
  }

  // Merge updates (exclude id and createdAt from being overwritten)
  const { id: _ignoreId, createdAt: _ignoreCreated, ...safeUpdates } = updates;
  _entries[idx] = {
    ..._entries[idx],
    ...safeUpdates,
    updatedAt: new Date().toISOString()
  };

  persistVault();
  return { success: true, entry: { ..._entries[idx] } };
}

/**
 * Deletes an entry by ID.
 *
 * @param {string} id - Entry UUID
 * @returns {{ success: boolean, message: string }}
 */
function deleteEntry(id) {
  requireUnlocked();

  const idx = _entries.findIndex(e => e.id === id);
  if (idx === -1) {
    return { success: false, message: 'Entry not found.' };
  }

  _entries.splice(idx, 1);
  persistVault();

  return { success: true, message: 'Entry deleted.' };
}

/**
 * Searches entries by domain/URL match.
 * Used by the browser extension to find credentials for a website.
 *
 * @param {string} domainQuery - The domain to search for (e.g., "github.com")
 * @returns {Array} Matching entries (without passwords for dropdown display)
 */
function searchByDomain(domainQuery) {
  requireUnlocked();

  const debugLogPath = path.join(getDefaultVaultDir(), 'lockeep_debug.txt');
  const logDebug = (msg) => {
    try {
      fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
    } catch (e) { }
  };

  logDebug(`\n--- searchByDomain Called ---`);
  logDebug(`Incoming Query: "${domainQuery}"`);

  if (!domainQuery || typeof domainQuery !== 'string') {
    logDebug(`Invalid domainQuery type or empty. Returning [].`);
    return [];
  }

  const cleanString = (str) => {
    if (!str || typeof str !== 'string') return '';
    return str.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .trim();
  };

  const cleanQuery = cleanString(domainQuery);
  logDebug(`Cleaned Query: "${cleanQuery}"`);

  if (!cleanQuery) {
    logDebug(`Cleaned Query is empty. Returning [].`);
    return [];
  }

  const matchedEntries = [];

  for (const entry of _entries) {
    const cleanUrl = cleanString(entry.url);
    const cleanDomain = cleanString(entry.domain);

    const matchUrl = cleanUrl && (cleanUrl.includes(cleanQuery) || cleanQuery.includes(cleanUrl));
    const matchDomain = cleanDomain && (cleanDomain.includes(cleanQuery) || cleanQuery.includes(cleanDomain));

    logDebug(`Evaluating Entry: ID=${entry.id}, Title="${entry.title}"`);
    logDebug(`  Raw URL: "${entry.url}" => Cleaned URL: "${cleanUrl}"`);
    logDebug(`  Raw Domain: "${entry.domain}" => Cleaned Domain: "${cleanDomain}"`);

    if (matchUrl || matchDomain) {
      logDebug(`  -> MATCHED! (matchUrl=${!!matchUrl}, matchDomain=${!!matchDomain})`);
      matchedEntries.push(entry);
    } else {
      logDebug(`  -> NO MATCH.`);
    }
  }

  const result = matchedEntries.map(entry => ({
    id: entry.id,
    title: entry.title,
    username: entry.username,
    url: entry.url
    // NOTE: Password deliberately excluded for security
  }));

  logDebug(`Returning ${result.length} matches.`);
  logDebug(`-----------------------------`);

  return result;
}

/**
 * Returns the full credential for a specific entry (including password).
 * Used by the browser extension after user selects from dropdown.
 *
 * @param {string} id - Entry UUID
 * @returns {Object|null} Full entry including password, or null
 */
function getCredential(id) {
  requireUnlocked();
  const entry = _entries.find(e => e.id === id);
  return entry ? { ...entry } : null;
}

/**
 * Adds multiple entries at once (used by import).
 * @param {Array} entries - Array of entry data objects
 * @returns {{ success: boolean, imported: number }}
 */
/**
 * Adds multiple entries at once (used by import).
 * Prevents exact duplicates (same username, password, and domain).
 * @param {Array} entries - Array of entry data objects
 * @returns {{ success: boolean, imported: number }}
 */
function addBulkEntries(entries) {
  requireUnlocked();

  const now = new Date().toISOString();
  let imported = 0;

  // URL'den domain çıkarmak için ufak yardımcı fonksiyon (Karşılaştırma için)
  const getDomain = (url) => {
    if (!url) return '';
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  };

  for (const entryData of entries) {
    // ÇİFTE KAYIT KONTROLÜ (DEDUPLICATION)
    // Kasadaki mevcut şifreler (_entries) içinde birebir aynısı var mı diye bakıyoruz
    const isDuplicate = _entries.some(existing =>
      existing.username === entryData.username &&
      existing.password === entryData.password &&
      getDomain(existing.url) === getDomain(entryData.url)
    );

    // Eğer aynısı zaten kasada varsa, bu kaydı atla ve diğerine geç
    if (isDuplicate) {
      continue;
    }

    const entry = {
      id: randomUUID(),
      title: entryData.title || entryData.name || '',
      username: entryData.username || '',
      password: entryData.password || '',
      url: entryData.url || '',
      notes: entryData.notes || '',
      category: entryData.category || 'login',
      favorite: entryData.favorite || false,
      createdAt: now,
      updatedAt: now
    };
    _entries.push(entry);
    imported++;
  }

  persistVault();
  return { success: true, imported };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Ensures the vault is unlocked before performing operations.
 * @throws {Error} If the vault is locked
 */
function requireUnlocked() {
  if (!_isUnlocked || !_masterKey || !_entries) {
    throw new Error('VAULT: Operation requires an unlocked vault.');
  }
}

/**
 * Re-encrypts and writes the current entries to the vault file.
 * Called after every CRUD operation.
 */
function persistVault() {
  requireUnlocked();

  const plaintext = JSON.stringify(_entries);
  const integrity = computeIntegrity(plaintext);
  const encryptedData = encrypt(plaintext, _masterKey);

  const vaultFile = {
    ..._vaultHeader,
    data: encryptedData,
    integrity
  };

  writeVaultFile(vaultFile);
}

/**
 * Computes a SHA-256 hash of the plaintext for integrity verification.
 * This allows detecting tampering independently of GCM's auth tag.
 *
 * @param {string} plaintext - The JSON string to hash
 * @returns {string} Hex-encoded SHA-256 hash
 */
function computeIntegrity(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf-8').digest('hex');
}

/**
 * Writes the vault object to disk atomically.
 * Uses write-then-rename to prevent corruption from crashes.
 * @param {Object} vaultData - The complete vault object
 */
function writeVaultFile(vaultData) {
  const vaultPath = getVaultPath();
  const dir = path.dirname(vaultPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = vaultPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(vaultData), 'utf-8');
  fs.renameSync(tmpPath, vaultPath);
}

/**
 * Reads and parses the vault file from disk.
 * @returns {Object|null} Parsed vault object or null on failure
 */
function readVaultFile() {
  try {
    const vaultPath = getVaultPath();
    const content = fs.readFileSync(vaultPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Zeroizes all sensitive state: master key, entries, unlock flag.
 * Called on lock and on failed unlock attempts.
 */
function zeroizeState() {
  if (_masterKey) {
    zeroizeBuffer(_masterKey);
    _masterKey = null;
  }
  if (_entries) {
    // Overwrite each entry's sensitive strings before clearing the array
    for (const entry of _entries) {
      if (entry.password) entry.password = '\0'.repeat(entry.password.length);
      if (entry.username) entry.username = '\0'.repeat(entry.username.length);
      if (entry.notes) entry.notes = '\0'.repeat(entry.notes.length);
    }
    _entries = null;
  }
  _isUnlocked = false;
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  // Path management
  getVaultPath,
  setVaultPath,
  resetVaultPath,
  initializeFromSettings,
  loadSettings,
  saveSettings,

  // Lifecycle
  vaultExists,
  isUnlocked,
  createVault,
  unlockVault,
  lockVault,
  changeMasterPassword,

  // Entry CRUD
  getEntries,
  getEntryById,
  addEntry,
  updateEntry,
  deleteEntry,
  addBulkEntries,

  // Extension support
  searchByDomain,
  getCredential,

  // Constants
  VAULT_VERSION
};
