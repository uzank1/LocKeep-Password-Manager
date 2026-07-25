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
 * }
 *
 * NOTE (L-01): The "integrity" field has been removed. GCM's auth tag
 * already guarantees integrity + authenticity. Existing vault files with
 * an "integrity" field still load fine (backward compat), but after the
 * first write the field is dropped.
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
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const { app } = require('electron');

const { generateSalt, deriveKey, deriveKeyWithParams, getDefaultKdfConfig, zeroizeBuffer } = require('../crypto/keyDerivation');
const { encrypt, decrypt } = require('../crypto/encryption');
const { randomUUID } = require('../crypto/secureRandom');

// ─── Constants ──────────────────────────────────────────────────────────────

const VAULT_FILENAME = 'vault.dat';
const SETTINGS_FILENAME = 'settings.json';
const VAULT_VERSION = 1;
const ENTRY_LIMITS = {
  title: 500,
  username: 255,
  password: 1024,
  url: 2000,
  notes: 10000
};
const VALID_CATEGORIES = new Set(['login', 'note', 'card', 'identity', 'other']);
const MAX_BULK_IMPORT_ENTRIES = 10000;
const VALID_SETTING_LANGUAGES = new Set(['en', 'de', 'tr']);
const VALID_AUTO_LOCK_MINUTES = new Set([0, 1, 5, 15]);
const MAX_VAULT_PATH_LENGTH = 4096;
const MAX_VERSION_SETTING_LENGTH = 64;

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

/** @type {Map<string, Array>|null} P-05: Domain → entries index for O(1) lookup */
let _domainIndex = null;

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
 * H-05: Derives a deterministic HMAC key from machine-specific identifiers.
 * This prevents settings file tampering without requiring a stored key.
 * @returns {Buffer} 32-byte HMAC key
 */
function _getSettingsHmacKey() {
  const fingerprint = `lockeep-settings-v1-${os.hostname()}-${os.userInfo().username}`;
  return crypto.createHash('sha256').update(fingerprint).digest();
}

function _settingsHasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function _isValidVersionSetting(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_VERSION_SETTING_LENGTH
    && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(value)
  );
}

function _sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }

  const clean = {};

  if (_settingsHasOwn(settings, 'language') && VALID_SETTING_LANGUAGES.has(settings.language)) {
    clean.language = settings.language;
  }

  if (_settingsHasOwn(settings, 'autoLockMinutes') && VALID_AUTO_LOCK_MINUTES.has(settings.autoLockMinutes)) {
    clean.autoLockMinutes = settings.autoLockMinutes;
  }

  if (_settingsHasOwn(settings, 'startWithWindows') && typeof settings.startWithWindows === 'boolean') {
    clean.startWithWindows = settings.startWithWindows;
  }

  for (const key of ['lastRunVersion', 'extensionReloadNoticeVersion']) {
    if (_settingsHasOwn(settings, key) && _isValidVersionSetting(settings[key])) {
      clean[key] = settings[key];
    }
  }

  if (_settingsHasOwn(settings, 'pendingUpdateVersion')) {
    if (settings.pendingUpdateVersion === null) {
      clean.pendingUpdateVersion = null;
    } else if (_isValidVersionSetting(settings.pendingUpdateVersion)) {
      clean.pendingUpdateVersion = settings.pendingUpdateVersion;
    }
  }

  if (_settingsHasOwn(settings, 'vaultPath')) {
    if (settings.vaultPath === null) {
      clean.vaultPath = null;
    } else if (
      typeof settings.vaultPath === 'string'
      && settings.vaultPath.length > 0
      && settings.vaultPath.length <= MAX_VAULT_PATH_LENGTH
    ) {
      clean.vaultPath = settings.vaultPath;
    }
  }

  // Settings are reachable before the vault is unlocked, so only the fields
  // the app actually uses should ever land in settings.json.
  return clean;
}

/**
 * Loads user settings from disk (vault path, language, auto-lock timeout).
 * H-05: Verifies HMAC integrity. Old format (no HMAC) auto-migrated on next save.
 * @returns {Object} Settings object (empty if file doesn't exist or tampered)
 */
function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw);

      // New HMAC-protected format
      if (parsed._hmac && parsed._data) {
        const jsonStr = JSON.stringify(parsed._data);
        const expected = crypto.createHmac('sha256', _getSettingsHmacKey()).update(jsonStr).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(parsed._hmac, 'hex'), Buffer.from(expected, 'hex'))) {
          console.warn('[SECURITY] Settings integrity check failed. Using defaults.');
          return {};
        }
        return _sanitizeSettings(parsed._data);
      }

      // Old format without HMAC (backward compat — will be migrated on next save)
      return _sanitizeSettings(parsed);
    }
  } catch {
    // Corrupted settings — return defaults
  }
  return {};
}

/**
 * Saves user settings to disk (merged with existing).
 * H-05: Settings are HMAC-signed for integrity protection.
 * @param {Object} newSettings - Settings to merge
 */
function saveSettings(newSettings) {
  try {
    const settingsPath = getSettingsPath();
    const existing = _sanitizeSettings(loadSettings());
    const incoming = _sanitizeSettings(newSettings);
    const merged = _sanitizeSettings({ ...existing, ...incoming });
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // H-05: Write HMAC-protected format
    const jsonStr = JSON.stringify(merged);
    const hmac = crypto.createHmac('sha256', _getSettingsHmacKey()).update(jsonStr).digest('hex');
    const envelope = { _data: merged, _hmac: hmac };
    fs.writeFileSync(settingsPath, JSON.stringify(envelope, null, 2), 'utf-8');
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
  // L-02: Enforce the same strict policy as the UI (14+ chars, mixed case, digits, symbols)
  if (!masterPassword || typeof masterPassword !== 'string') {
    return { success: false, message: 'Master password is required.' };
  }
  if (masterPassword.length < 14 ||
      !/[A-Z]/.test(masterPassword) || !/[a-z]/.test(masterPassword) ||
      !/[0-9]/.test(masterPassword) || !/[^A-Za-z0-9]/.test(masterPassword)) {
    return { success: false, message: 'Master password must be at least 14 characters and include uppercase, lowercase, digits, and special characters.' };
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
  _domainIndex = new Map(); // P-05: empty index
  const plaintext = JSON.stringify(_entries);
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
    data: encryptedData
  };

  await writeVaultFile(vaultFile);
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
  const vaultFile = await readVaultFile();
  if (!vaultFile || vaultFile.version !== VAULT_VERSION) {
    return { success: false, message: 'Unsupported vault version.' };
  }

  // Derive key using stored KDF params
  try {
    _masterKey = await deriveKeyWithParams(masterPassword, vaultFile.kdf);
  } catch (err) {
    return { success: false, message: 'Key derivation failed: ' + err.message };
  }

  // Decrypt vault data — GCM auth tag provides integrity verification (L-01)
  try {
    const decrypted = decrypt(vaultFile.data, _masterKey, null, false);

    _entries = JSON.parse(decrypted);
    _vaultHeader = { version: vaultFile.version, kdf: vaultFile.kdf };
    _isUnlocked = true;

    // P-05: Build domain index for O(1) searchByDomain lookups
    _rebuildDomainIndex();

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

  // L-02: Enforce the same strict policy as the UI and createVault (14+ chars, mixed case, digits, symbols)
  if (!newPassword || typeof newPassword !== 'string') {
    return { success: false, message: 'New password is required.' };
  }
  if (newPassword.length < 14 ||
      !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    return { success: false, message: 'New password must be at least 14 characters and include uppercase, lowercase, digits, and special characters.' };
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

  await persistVault();
  return { success: true, message: 'Master password changed successfully.' };
}

// ─── Entry Validation Helpers ───────────────────────────────────────────────

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function _cleanEntryString(value, fieldName, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`VAULT: ${fieldName} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`VAULT: ${fieldName} exceeds the allowed length.`);
  }
  return value;
}

function _cleanEntryCategory(value) {
  if (value === undefined || value === null || value === '') return 'login';
  const category = String(value).toLowerCase();
  return VALID_CATEGORIES.has(category) ? category : 'login';
}

function _sanitizeEntryData(entryData, { partial = false } = {}) {
  if (!_isPlainObject(entryData)) {
    throw new Error('VAULT: Entry data must be a plain object.');
  }

  const clean = {};
  const stringFields = [
    ['title', ENTRY_LIMITS.title],
    ['username', ENTRY_LIMITS.username],
    ['password', ENTRY_LIMITS.password],
    ['url', ENTRY_LIMITS.url],
    ['notes', ENTRY_LIMITS.notes]
  ];

  for (const [field, maxLength] of stringFields) {
    if (partial && !_hasOwn(entryData, field)) continue;
    const value = field === 'title' && !_hasOwn(entryData, field) ? entryData.name : entryData[field];
    clean[field] = _cleanEntryString(value, field, maxLength);
  }

  if (!partial || _hasOwn(entryData, 'category')) {
    clean.category = _cleanEntryCategory(entryData.category);
  }

  if (!partial || _hasOwn(entryData, 'favorite')) {
    clean.favorite = Boolean(entryData.favorite);
  }

  // Renderer validation is useful for UX, but native messaging and imports can
  // reach the vault directly. Keeping the same rules here makes this the final
  // gate before encrypted data is written.
  return clean;
}

function _stripHostNoise(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

function _parseOriginLike(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  try {
    const parsed = new URL(explicitScheme ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = _stripHostNoise(parsed.hostname);
    if (!host) return null;
    return {
      scheme: parsed.protocol.slice(0, -1),
      host,
      explicitScheme
    };
  } catch {
    return null;
  }
}

function _isLocalHost(hostname) {
  const host = _stripHostNoise(hostname);
  return host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.');
}

function _isValidHostForMatching(hostname) {
  const host = _stripHostNoise(hostname);
  if (!host || host.length > 253) return false;
  if (_isLocalHost(host) || net.isIP(host)) return true;
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return false;
  return host.split('.').every(label =>
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

function _canBeParentDomain(hostname) {
  const host = _stripHostNoise(hostname);
  return _isLocalHost(host) || net.isIP(host) || host.includes('.');
}

function _schemesCompatible(queryInfo, entryInfo) {
  if (!queryInfo || !entryInfo) return false;
  if (!queryInfo.explicitScheme || !entryInfo.explicitScheme) return true;
  if (_isLocalHost(queryInfo.host) || _isLocalHost(entryInfo.host)) return true;
  return queryInfo.scheme === entryInfo.scheme;
}

function _entryMatchesOrigin(entry, origin) {
  const queryInfo = _parseOriginLike(origin);
  if (!queryInfo || !_isValidHostForMatching(queryInfo.host)) return false;

  // The extension filters entries before showing the dropdown, but the vault
  // repeats the origin check because this is the last stop before cleartext
  // passwords leave the encrypted store.
  return [entry && entry.url, entry && entry.domain]
    .map(_parseOriginLike)
    .filter(info => info && _isValidHostForMatching(info.host))
    .some(info => _matchHosts(info.host, queryInfo.host) && _schemesCompatible(queryInfo, info));
}

// ─── Entry CRUD ─────────────────────────────────────────────────────────────

/**
 * Returns all decrypted entries (vault must be unlocked).
 * @returns {Array} Array of entry objects
 */
function getEntries() {
  requireUnlocked();
  // P-02: structuredClone is 2-5× faster than JSON round-trip
  return structuredClone(_entries);
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
async function addEntry(entryData) {
  requireUnlocked();

  const cleanData = _sanitizeEntryData(entryData);
  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    title: cleanData.title,
    username: cleanData.username,
    password: cleanData.password,
    url: cleanData.url,
    notes: cleanData.notes,
    category: cleanData.category,
    favorite: cleanData.favorite,
    createdAt: now,
    updatedAt: now
  };

  _entries.push(entry);
  _indexEntry(entry); // P-05: update domain index
  await persistVault();

  return { success: true, entry: { ...entry } };
}

/**
 * Updates an existing entry.
 *
 * @param {string} id        - Entry UUID
 * @param {Object} updates   - Fields to update
 * @returns {{ success: boolean, entry?: Object, message?: string }}
 */
async function updateEntry(id, updates) {
  requireUnlocked();

  const idx = _entries.findIndex(e => e.id === id);
  if (idx === -1) {
    return { success: false, message: 'Entry not found.' };
  }

  // P-05: unindex old entry before mutation
  _unindexEntry(_entries[idx]);

  // Merge updates (exclude id and createdAt from being overwritten)
  const { id: _ignoreId, createdAt: _ignoreCreated, ...safeUpdates } = updates;
  const cleanUpdates = _sanitizeEntryData(safeUpdates, { partial: true });
  _entries[idx] = {
    ..._entries[idx],
    ...cleanUpdates,
    updatedAt: new Date().toISOString()
  };

  // P-05: re-index updated entry
  _indexEntry(_entries[idx]);

  await persistVault();
  return { success: true, entry: { ..._entries[idx] } };
}

/**
 * Deletes an entry by ID.
 *
 * @param {string} id - Entry UUID
 * @returns {{ success: boolean, message: string }}
 */
async function deleteEntry(id) {
  requireUnlocked();

  const idx = _entries.findIndex(e => e.id === id);
  if (idx === -1) {
    return { success: false, message: 'Entry not found.' };
  }

  _unindexEntry(_entries[idx]); // P-05: remove from domain index
  _entries.splice(idx, 1);
  await persistVault();

  return { success: true, message: 'Entry deleted.' };
}

/**
 * Searches entries by domain/URL match.
 * Used by the browser extension to find credentials for a website.
 *
 * @param {string} domainQuery - The domain to search for (e.g., "github.com")
 * @returns {Array} Matching entries (without passwords for dropdown display)
 */
/**
 * C-01: Debug logging removed entirely — it was writing cleartext
 * credentials to disk (the most critical vulnerability in the codebase).
 *
 * P-05: Uses the in-memory domain index for O(1) lookup instead of
 * scanning all entries on every search.
 *
 * L-2: The linear fallback now uses suffix-anchored matching (_matchHosts)
 * instead of bidirectional .includes(). This prevents a stored credential
 * for 'app.com' from being incorrectly offered on 'myapp.com', while
 * still correctly matching subdomains like 'login.app.com' → 'app.com'.
 */

/**
 * Extracts the hostname portion from a cleaned URL/domain string.
 * Strips any path segments and port numbers.
 * Example: 'github.com/login' → 'github.com', 'localhost:3000' → 'localhost'
 * @param {string} cleanStr - A URL/domain previously processed by _cleanDomain()
 * @returns {string} The bare hostname
 */
function extractHost(cleanStr) {
  const parsed = _parseOriginLike(cleanStr);
  return parsed ? parsed.host : '';
}

/**
 * Determines whether two hostnames are the same domain or have a
 * subdomain/parent relationship. Uses strict dot-boundary suffix matching.
 *
 * Examples:
 *   _matchHosts('login.github.com', 'github.com')  → true  (subdomain match)
 *   _matchHosts('github.com', 'github.com')        → true  (exact match)
 *   _matchHosts('myapp.com', 'app.com')             → false (no dot boundary)
 *   _matchHosts('evil-github.com', 'github.com')    → false (no dot boundary)
 *
 * @param {string} h1 - First hostname
 * @param {string} h2 - Second hostname
 * @returns {boolean} Whether the hosts match at a domain boundary
 */
function _matchHosts(h1, h2) {
  const left = _stripHostNoise(h1);
  const right = _stripHostNoise(h2);
  if (!left || !right) return false;
  if (left === right) return true;
  if (!_canBeParentDomain(left) || !_canBeParentDomain(right)) return false;
  return left.endsWith('.' + right) || right.endsWith('.' + left);
}

function searchByDomain(domainQuery) {
  requireUnlocked();

  if (!domainQuery || typeof domainQuery !== 'string') {
    return [];
  }

  const queryInfo = _parseOriginLike(domainQuery);
  if (!queryInfo || !_isValidHostForMatching(queryInfo.host)) return [];
  const cleanQuery = queryInfo.host;

  // P-05: O(1) index lookup
  const matchedEntries = _domainIndex
    ? (_domainIndex.get(cleanQuery) || []).filter(entry => _entryMatchesOrigin(entry, domainQuery))
    : [];

  // Also check for partial/subdomain matches via a linear fallback
  // (handles cases like "login.github.com" matching "github.com")
  const indexMatches = new Set(matchedEntries.map(e => e.id));
  for (const entry of _entries) {
    if (indexMatches.has(entry.id)) continue;
    if (_entryMatchesOrigin(entry, domainQuery)) {
      matchedEntries.push(entry);
    }
  }

  return matchedEntries.map(entry => ({
    id: entry.id,
    title: entry.title,
    username: entry.username,
    url: entry.url
    // NOTE: Password deliberately excluded for security
  }));
}

/**
 * Returns the full credential for a specific entry (including password).
 * Used by the browser extension after user selects from dropdown.
 *
 * @param {string} id - Entry UUID
 * @param {string} [origin] - Browser origin requesting the entry
 * @returns {Object|null} Full entry including password, or null
 */
function getCredential(id, origin = '') {
  requireUnlocked();
  const entry = _entries.find(e => e.id === id);
  if (entry && origin && !_entryMatchesOrigin(entry, origin)) {
    return null;
  }
  return entry ? { ...entry } : null;
}

/**
 * Adds multiple entries at once (used by import).
 * Prevents exact duplicates (same username, password, and domain).
 * @param {Array} entries - Array of entry data objects
 * @returns {{ success: boolean, imported: number }}
 */
async function addBulkEntries(entries) {
  requireUnlocked();

  if (!Array.isArray(entries)) {
    throw new Error('VAULT: Import data must be an array.');
  }

  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;
  const cappedEntries = entries.slice(0, MAX_BULK_IMPORT_ENTRIES);
  skipped += Math.max(0, entries.length - cappedEntries.length);

  // Helper: extract the bare hostname from a URL for deduplication comparison
  const getDomain = (url) => {
    return _cleanDomain(url);
  };

  for (const entryData of cappedEntries) {
    let cleanData;
    try {
      cleanData = _sanitizeEntryData(entryData);
    } catch {
      // Imports should be forgiving: a bad row is skipped, not allowed to abort
      // the entire batch or write oversized fields into the encrypted vault.
      skipped++;
      continue;
    }

    // Deduplication check: skip if an entry with the same username, password,
    // and domain already exists in the vault
    const isDuplicate = _entries.some(existing =>
      existing.username === cleanData.username &&
      existing.password === cleanData.password &&
      getDomain(existing.url) === getDomain(cleanData.url)
    );

    if (isDuplicate) {
      continue;
    }

    const entry = {
      id: randomUUID(),
      title: cleanData.title,
      username: cleanData.username,
      password: cleanData.password,
      url: cleanData.url,
      notes: cleanData.notes,
      category: cleanData.category,
      favorite: cleanData.favorite,
      createdAt: now,
      updatedAt: now
    };
    _entries.push(entry);
    _indexEntry(entry); // P-05: update domain index
    imported++;
  }

  await persistVault();
  return { success: true, imported, skipped };
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
 * P-08: Now async using fs.promises.
 */
async function persistVault() {
  requireUnlocked();

  const plaintext = JSON.stringify(_entries);
  const encryptedData = encrypt(plaintext, _masterKey);

  const vaultFile = {
    ..._vaultHeader,
    data: encryptedData
    // L-01: integrity field removed — GCM auth tag suffices
  };

  await writeVaultFile(vaultFile);
}

/**
 * Writes the vault object to disk atomically.
 * Uses write-then-rename to prevent corruption from crashes.
 * P-08: Now async using fs.promises.
 * @param {Object} vaultData - The complete vault object
 */
async function writeVaultFile(vaultData) {
  const vaultPath = getVaultPath();
  const dir = path.dirname(vaultPath);

  try { await fsp.access(dir); } catch {
    await fsp.mkdir(dir, { recursive: true });
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = vaultPath + '.tmp';
  await fsp.writeFile(tmpPath, JSON.stringify(vaultData), 'utf-8');
  await fsp.rename(tmpPath, vaultPath);
}

/**
 * Reads and parses the vault file from disk.
 * P-08: Now async using fs.promises.
 * @returns {Promise<Object|null>} Parsed vault object or null on failure
 */
async function readVaultFile() {
  try {
    const vaultPath = getVaultPath();
    const content = await fsp.readFile(vaultPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Zeroizes all sensitive state: master key, entries, domain index, unlock flag.
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
  _domainIndex = null; // P-05: clear domain index
  _isUnlocked = false;
}

// ─── P-05: Domain Index Helpers ─────────────────────────────────────────────

/**
 * Normalizes a URL/domain string for indexing and searching.
 * @param {string} str
 * @returns {string} Cleaned domain string
 */
function _cleanDomain(str) {
  const parsed = _parseOriginLike(str);
  return parsed && _isValidHostForMatching(parsed.host) ? parsed.host : '';
}

/**
 * Rebuilds the entire domain index from scratch.
 * Called once when vault is unlocked.
 */
function _rebuildDomainIndex() {
  _domainIndex = new Map();
  for (const entry of _entries) {
    _indexEntry(entry);
  }
}

/**
 * Adds a single entry to the domain index.
 * @param {Object} entry
 */
function _indexEntry(entry) {
  if (!_domainIndex) return;
  const keys = new Set();
  const cleanUrl = _cleanDomain(entry.url);
  const cleanDomain = _cleanDomain(entry.domain);
  if (cleanUrl) keys.add(cleanUrl);
  if (cleanDomain) keys.add(cleanDomain);
  for (const key of keys) {
    if (!_domainIndex.has(key)) _domainIndex.set(key, []);
    _domainIndex.get(key).push(entry);
  }
}

/**
 * Removes a single entry from the domain index.
 * @param {Object} entry
 */
function _unindexEntry(entry) {
  if (!_domainIndex) return;
  const keys = new Set();
  const cleanUrl = _cleanDomain(entry.url);
  const cleanDomain = _cleanDomain(entry.domain);
  if (cleanUrl) keys.add(cleanUrl);
  if (cleanDomain) keys.add(cleanDomain);
  for (const key of keys) {
    const arr = _domainIndex.get(key);
    if (arr) {
      const filtered = arr.filter(e => e.id !== entry.id);
      if (filtered.length === 0) _domainIndex.delete(key);
      else _domainIndex.set(key, filtered);
    }
  }
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
