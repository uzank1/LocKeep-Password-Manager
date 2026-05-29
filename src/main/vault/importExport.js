/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Import & Export Module
 * ============================================================================
 * Imports from: Bitwarden CSV, 1Password CSV, Chrome CSV, Generic CSV/JSON
 * Exports to:   Bitwarden CSV, 1Password CSV, Chrome CSV, KeePass CSV
 *
 * SECURITY: Imported data is immediately encrypted into the vault.
 *           Export files are plaintext — user is warned before export.
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CSV Parser (no external deps — minimizes attack surface) ───────────────

/**
 * Parses a CSV string into an array of objects using the header row as keys.
 * Handles quoted fields, embedded commas, and newlines within quotes.
 *
 * @param {string} csvText - Raw CSV content
 * @returns {Array<Object>} Array of row objects keyed by header names
 */
function parseCSV(csvText) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  // Split into logical lines (respecting quoted newlines)
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (ch === '"') {
      // SADECE inQuotes durumunu değiştir, ama TIRNAĞI SİLME (current += ch)
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current.trim()) lines.push(current);
      current = '';
      // Skip \r\n pairs
      if (ch === '\r' && i + 1 < csvText.length && csvText[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return []; // Need header + at least one data row

  // Parse header
  const headers = splitCSVLine(lines[0]).map(h => h.trim().toLowerCase());

  // Parse data rows
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = idx < values.length ? values[idx].trim() : '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Splits a single CSV line into fields, handling quoted values.
 * @param {string} line - A single CSV line
 * @returns {string[]} Array of field values
 */
function splitCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Generates a CSV string from an array of objects.
 * @param {string[]} headers - Column headers
 * @param {Array<Object>} rows - Data rows
 * @returns {string} CSV content
 */
function generateCSV(headers, rows) {
  const escapeField = (val) => {
    const str = String(val || '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeField(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ─── Format Detectors ───────────────────────────────────────────────────────

/** Header signatures for auto-detecting source format */
const FORMAT_SIGNATURES = {
  bitwarden: ['folder', 'favorite', 'type', 'name', 'login_uri', 'login_username', 'login_password'],
  chrome: ['name', 'url', 'username', 'password'],
  onepassword: ['title', 'website', 'username', 'password'],
  // Firefox uses same format as Chrome
  firefox: ['url', 'username', 'password']
};

/**
 * Auto-detects the source format from CSV headers.
 * @param {string[]} headers - Lowercase header names
 * @returns {string} Detected format name or 'generic'
 */
function detectFormat(headers) {
  const headerSet = new Set(headers.map(h => h.toLowerCase().trim()));

  for (const [format, signature] of Object.entries(FORMAT_SIGNATURES)) {
    const matchCount = signature.filter(s => headerSet.has(s)).length;
    // Require at least 70% of signature headers to match
    if (matchCount / signature.length >= 0.7) return format;
  }
  return 'generic';
}

// ─── Import Functions ───────────────────────────────────────────────────────

/**
 * Imports credentials from a file (CSV or JSON).
 * Auto-detects format, normalizes entries, returns them ready for vault storage.
 *
 * @param {string} filePath - Absolute path to the import file
 * @returns {{ success: boolean, entries?: Array, format?: string, count?: number, message?: string }}
 */
function importFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: 'File not found.' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  let rawEntries;
  let detectedFormat;

  if (ext === '.json') {
    // JSON import
    try {
      const parsed = JSON.parse(content);
      // Bitwarden JSON export has { encrypted: false, items: [...] }
      if (parsed.items && Array.isArray(parsed.items)) {
        rawEntries = parsed.items.map(normalizeBitwardenJSON);
        detectedFormat = 'bitwarden_json';
      } else if (Array.isArray(parsed)) {
        rawEntries = parsed.map(normalizeGenericJSON);
        detectedFormat = 'generic_json';
      } else {
        return { success: false, message: 'Unrecognized JSON structure.' };
      }
    } catch {
      return { success: false, message: 'Invalid JSON file.' };
    }
  } else if (ext === '.csv') {
    // CSV import
    const rows = parseCSV(content);
    if (rows.length === 0) {
      return { success: false, message: 'CSV file is empty or has no data rows.' };
    }

    const headers = Object.keys(rows[0]);
    detectedFormat = detectFormat(headers);

    switch (detectedFormat) {
      case 'bitwarden':
        rawEntries = rows.map(normalizeBitwardenCSV);
        break;
      case 'chrome':
      case 'firefox':
        rawEntries = rows.map(normalizeChromeCSV);
        break;
      case 'onepassword':
        rawEntries = rows.map(normalize1PasswordCSV);
        break;
      default:
        rawEntries = rows.map(normalizeGenericCSV);
        break;
    }
  } else {
    return { success: false, message: `Unsupported file format: ${ext}. Use .csv or .json` };
  }

  // Sadece boş olan kayıtları eler, kopyaları engelleme işini artık vaultManager yapıyor
  const validEntries = rawEntries.filter(e => e && (e.username || e.password || e.url));

  return {
    success: true,
    entries: validEntries,
    format: detectedFormat,
    count: validEntries.length
  };
}

// ─── Normalization Functions (per format) ────────────────────────────────────

function normalizeBitwardenCSV(row) {
  return {
    title: row['name'] || '',
    username: row['login_username'] || '',
    password: row['login_password'] || '',
    url: row['login_uri'] || '',
    notes: row['notes'] || '',
    category: row['type'] === 'note' ? 'note' : 'login',
    favorite: row['favorite'] === '1'
  };
}

function normalizeChromeCSV(row) {
  return {
    title: row['name'] || extractDomain(row['url'] || ''),
    username: row['username'] || '',
    password: row['password'] || '',
    url: row['url'] || '',
    notes: row['note'] || row['notes'] || '',
    category: 'login',
    favorite: false
  };
}

function normalize1PasswordCSV(row) {
  return {
    title: row['title'] || '',
    username: row['username'] || '',
    password: row['password'] || '',
    url: row['website'] || row['url'] || '',
    notes: row['notes'] || '',
    category: (row['type'] || 'login').toLowerCase(),
    favorite: false
  };
}

function normalizeGenericCSV(row) {
  // Try to match common column names regardless of exact header
  return {
    title: row['title'] || row['name'] || row['site'] || '',
    username: row['username'] || row['email'] || row['user'] || row['login'] || '',
    password: row['password'] || row['pass'] || row['pwd'] || '',
    url: row['url'] || row['website'] || row['uri'] || row['site'] || '',
    notes: row['notes'] || row['note'] || row['comments'] || '',
    category: 'login',
    favorite: false
  };
}

function normalizeBitwardenJSON(item) {
  const login = item.login || {};
  const uris = login.uris || [];
  return {
    title: item.name || '',
    username: login.username || '',
    password: login.password || '',
    url: uris.length > 0 ? uris[0].uri : '',
    notes: item.notes || '',
    category: item.type === 2 ? 'note' : 'login',
    favorite: item.favorite || false
  };
}

function normalizeGenericJSON(item) {
  return normalizeGenericCSV(item); // Same field-guessing logic works
}

// ─── Export Functions ───────────────────────────────────────────────────────

/**
 * Returns the list of supported export targets for the UI.
 * @returns {Array<{ id: string, name: string, ext: string }>}
 */
function getExportTargets() {
  return [
    { id: 'bitwarden', name: 'Bitwarden (CSV)', ext: '.csv' },
    { id: 'onepassword', name: '1Password (CSV)', ext: '.csv' },
    { id: 'chrome', name: 'Chrome (CSV)', ext: '.csv' },
    { id: 'keepass', name: 'KeePass (CSV)', ext: '.csv' },
    { id: 'json', name: 'Generic JSON', ext: '.json' }
  ];
}

/**
 * Exports vault entries to a file in the specified format.
 *
 * @param {Array}  entries    - Decrypted vault entries
 * @param {string} targetFormat - Export target ID (bitwarden, onepassword, chrome, keepass, json)
 * @param {string} outputPath   - Absolute path to write the export file
 * @returns {{ success: boolean, message: string, path?: string }}
 */
function exportToFile(entries, targetFormat, outputPath) {
  if (!entries || entries.length === 0) {
    return { success: false, message: 'No entries to export.' };
  }

  let content;

  switch (targetFormat) {
    case 'bitwarden':
      content = exportBitwardenCSV(entries);
      break;
    case 'onepassword':
      content = export1PasswordCSV(entries);
      break;
    case 'chrome':
      content = exportChromeCSV(entries);
      break;
    case 'keepass':
      content = exportKeePassCSV(entries);
      break;
    case 'json':
      content = exportGenericJSON(entries);
      break;
    default:
      return { success: false, message: `Unknown export format: ${targetFormat}` };
  }

  try {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');

    // H-04: Restrict file permissions — exported passwords are plaintext
    try {
      if (process.platform === 'win32') {
        const { execFileSync } = require('child_process');
        // Remove inherited permissions, grant full control only to current user
        execFileSync('icacls', [outputPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore', windowsHide: true });
      } else {
        fs.chmodSync(outputPath, 0o600); // Owner read/write only
      }
    } catch { /* Best-effort — don't fail the export if permissions fail */ }

    return { success: true, message: `Exported ${entries.length} entries.`, path: outputPath };
  } catch (err) {
    return { success: false, message: 'Failed to write file: ' + err.message };
  }
}

function exportBitwardenCSV(entries) {
  const headers = ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp'];
  const rows = entries.map(e => ({
    folder: '', favorite: e.favorite ? '1' : '', type: 'login',
    name: e.title, notes: e.notes, fields: '', reprompt: '0',
    login_uri: e.url, login_username: e.username,
    login_password: e.password, login_totp: ''
  }));
  return generateCSV(headers, rows);
}

function export1PasswordCSV(entries) {
  const headers = ['Title', 'Website', 'Username', 'Password', 'Notes', 'Type'];
  const rows = entries.map(e => ({
    Title: e.title, Website: e.url, Username: e.username,
    Password: e.password, Notes: e.notes, Type: 'Login'
  }));
  return generateCSV(headers, rows);
}

function exportChromeCSV(entries) {
  const headers = ['name', 'url', 'username', 'password', 'note'];
  const rows = entries.map(e => ({
    name: e.title, url: e.url, username: e.username,
    password: e.password, note: e.notes
  }));
  return generateCSV(headers, rows);
}

function exportKeePassCSV(entries) {
  const headers = ['Title', 'Username', 'Password', 'URL', 'Notes'];
  const rows = entries.map(e => ({
    Title: e.title, Username: e.username,
    Password: e.password, URL: e.url, Notes: e.notes
  }));
  return generateCSV(headers, rows);
}

function exportGenericJSON(entries) {
  const safe = entries.map(e => ({
    title: e.title, username: e.username, password: e.password,
    url: e.url, notes: e.notes, category: e.category
  }));
  return JSON.stringify(safe, null, 2);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Extracts a readable domain name from a URL.
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

module.exports = {
  importFromFile,
  exportToFile,
  getExportTargets,
  // Exposed for testing
  parseCSV,
  generateCSV,
  detectFormat
};
