/**
 * ============================================================================
 * LocKeep — Vault Lifecycle Tests
 * ============================================================================
 * Exercises the encrypted vault without touching the real user appData folder.
 * The Electron app object is stubbed before vaultManager is loaded, so every
 * settings/vault write stays inside a temporary test directory.
 * ============================================================================
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lockeep-vault-test-'));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => testRoot
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const vaultManager = require(path.join(__dirname, '..', 'src', 'main', 'vault', 'vaultManager'));
const importExport = require(path.join(__dirname, '..', 'src', 'main', 'vault', 'importExport'));

let passed = 0;
let failed = 0;

function check(condition, testName) {
  try {
    assert.ok(condition, testName);
    console.log(`  PASS: ${testName}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log('\nLocKeep — Vault Lifecycle Tests\n');

  const vaultPath = path.join(testRoot, 'vault.dat');
  const backupPath = path.join(testRoot, 'vault.backup.dat');
  const masterPassword = 'CorrectHorseBattery!2026';
  const newMasterPassword = 'BetterHorseBattery!2026';

  vaultManager.setVaultPath(vaultPath);

  vaultManager.saveSettings({
    language: 'tr',
    autoLockMinutes: 5,
    startWithWindows: true,
    closeAction: 'tray',
    lastRunVersion: '1.0.2',
    pendingUpdateVersion: '1.0.3',
    extensionReloadNoticeVersion: '1.0.2',
    injected: { shouldNotPersist: true }
  });
  const cleanSettings = vaultManager.loadSettings();
  check(
    cleanSettings.language === 'tr'
      && cleanSettings.autoLockMinutes === 5
      && cleanSettings.startWithWindows === true
      && cleanSettings.closeAction === 'tray'
      && cleanSettings.lastRunVersion === '1.0.2'
      && cleanSettings.pendingUpdateVersion === '1.0.3'
      && cleanSettings.extensionReloadNoticeVersion === '1.0.2'
      && cleanSettings.vaultPath === vaultPath
      && !Object.prototype.hasOwnProperty.call(cleanSettings, 'injected'),
    'Settings keep only the supported persisted fields'
  );

  vaultManager.saveSettings({
    language: 'fr',
    autoLockMinutes: 999,
    startWithWindows: 'yes',
    closeAction: 'minimize',
    lastRunVersion: 'invalid version!',
    pendingUpdateVersion: { version: '1.0.4' },
    extensionReloadNoticeVersion: '',
    injected: 'still blocked'
  });
  const ignoredSettings = vaultManager.loadSettings();
  check(
    ignoredSettings.language === 'tr'
      && ignoredSettings.autoLockMinutes === 5
      && ignoredSettings.startWithWindows === true
      && ignoredSettings.closeAction === 'tray'
      && ignoredSettings.lastRunVersion === '1.0.2'
      && ignoredSettings.pendingUpdateVersion === '1.0.3'
      && ignoredSettings.extensionReloadNoticeVersion === '1.0.2'
      && !Object.prototype.hasOwnProperty.call(ignoredSettings, 'injected'),
    'Invalid settings updates are ignored without clobbering valid values'
  );

  vaultManager.saveSettings({ startWithWindows: false });
  check(
    vaultManager.loadSettings().startWithWindows === false,
    'Windows startup preference can be disabled'
  );

  vaultManager.saveSettings({ pendingUpdateVersion: null });
  vaultManager.saveSettings({ closeAction: 'quit' });
  check(vaultManager.loadSettings().closeAction === 'quit', 'Close-to-tray can be turned off and stays saved');
  check(
    vaultManager.loadSettings().pendingUpdateVersion === null,
    'Pending update marker can be cleared after acknowledgement'
  );

  const weakResult = await vaultManager.createVault('weak');
  check(!weakResult.success, 'Weak master password is rejected');

  const createResult = await vaultManager.createVault(masterPassword);
  check(createResult.success && fs.existsSync(vaultPath), 'Vault is created and written to disk');
  check(vaultManager.isUnlocked(), 'Vault is unlocked after creation');

  const addResult = await vaultManager.addEntry({
    title: 'Example Login',
    username: 'alice@example.com',
    password: 'S3cure!Example',
    url: 'https://example.com/login',
    notes: 'Primary test account',
    category: 'login',
    favorite: true
  });
  check(addResult.success, 'Entry can be added');

  const matches = vaultManager.searchByDomain('https://login.example.com');
  check(matches.length === 1 && !Object.prototype.hasOwnProperty.call(matches[0], 'password'), 'Domain search returns metadata only');

  const allowedCredential = vaultManager.getCredential(addResult.entry.id, 'https://example.com');
  check(allowedCredential && allowedCredential.password === 'S3cure!Example', 'Credential is returned for matching HTTPS origin');

  const deniedCredential = vaultManager.getCredential(addResult.entry.id, 'http://example.com');
  check(deniedCredential === null, 'Credential is denied when HTTPS entry is requested from HTTP origin');

  fs.copyFileSync(vaultPath, backupPath);

  const bulkResult = await vaultManager.addBulkEntries([
    { title: 'Imported', username: 'bob', password: 'Import!123456789', url: 'https://import.example' },
    { title: 'Oversized', username: 'bad', password: 'x'.repeat(2048), url: 'https://bad.example' }
  ]);
  check(bulkResult.imported === 1 && bulkResult.skipped === 1, 'Bulk import skips oversized rows without aborting valid rows');

  vaultManager.lockVault();
  fs.copyFileSync(backupPath, vaultPath);
  const restoreResult = await vaultManager.unlockVault(masterPassword);
  check(restoreResult.success && vaultManager.getEntries().length === 1, 'Restored vault backup decrypts and removes later changes');

  const changeResult = await vaultManager.changeMasterPassword(masterPassword, newMasterPassword);
  check(changeResult.success, 'Master password can be changed');

  vaultManager.lockVault();
  const oldUnlock = await vaultManager.unlockVault(masterPassword);
  check(!oldUnlock.success, 'Old master password no longer unlocks after password change');

  const newUnlock = await vaultManager.unlockVault(newMasterPassword);
  check(newUnlock.success && vaultManager.getEntries().length === 1, 'New master password unlocks restored data');

  const csvPath = path.join(testRoot, 'import.csv');
  fs.writeFileSync(csvPath, 'name,url,username,password\nCSV Site,https://csv.example,csv-user,Csv!123456789\n', 'utf-8');
  const importResult = importExport.importFromFile(csvPath);
  check(importResult.success && importResult.entries.length === 1 && importResult.format === 'chrome', 'CSV import detects format and normalizes entries');

  vaultManager.lockVault();
  fs.rmSync(testRoot, { recursive: true, force: true });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* temp cleanup best effort */ }
  console.error('Vault test runner failed:', err);
  process.exit(1);
});
