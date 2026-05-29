/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — IPC Handlers
 * ============================================================================
 * Registers all IPC channels between Main and Renderer processes.
 * Each handler validates inputs and delegates to the appropriate module.
 *
 * SECURITY:
 * - All handlers use ipcMain.handle (invoke/handle pattern)
 * - Input validation on every handler
 * - No raw module access exposed to renderer
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const { ipcMain, dialog } = require('electron');
const vaultManager = require('../vault/vaultManager');
const importExport = require('../vault/importExport');
const passwordGenerator = require('../vault/passwordGenerator');
const clipboardGuard = require('../security/clipboardGuard');
const autoLock = require('../security/autoLock');

// GÜVENLİK YARDIMCISI: Sıkı Metin Doğrulama Filtresi
function isSafeString(input, maxLength) {
  // Veri var mı? Metin mi? Boşluklardan mı ibaret? Sınırı aşıyor mu?
  return typeof input === 'string' && input.trim().length > 0 && input.length <= maxLength;
}

// H-01: Rate limiting state for brute-force protection
const VALID_CATEGORIES = new Set(['login', 'note', 'card', 'identity', 'other']); // M-02
let _failedAttempts = 0;
let _lockoutUntil = 0;
const MAX_FAILURES = 10;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const BACKOFF_CAP_MS = 30 * 1000; // 30 seconds

/**
 * Registers all IPC handlers. Call once from main.js during app initialization.
 */
function registerAllHandlers() {

  // ── Vault Lifecycle ───────────────────────────────────────────────────

  ipcMain.handle('vault:exists', () => {
    return vaultManager.vaultExists();
  });

  ipcMain.handle('vault:isUnlocked', () => {
    return vaultManager.isUnlocked();
  });

  ipcMain.handle('vault:create', async (_event, masterPassword) => {
    if (!masterPassword || typeof masterPassword !== 'string') {
      return { success: false, message: 'Invalid master password.' };
    }
    const result = await vaultManager.createVault(masterPassword);
    if (result.success) autoLock.start();
    return result;
  });

  ipcMain.handle('vault:unlock', async (_event, masterPassword) => {
    if (!masterPassword || typeof masterPassword !== 'string') {
      return { success: false, message: 'Invalid master password.' };
    }

    // H-01: Check hard lockout
    const now = Date.now();
    if (_lockoutUntil > now) {
      const remainSec = Math.ceil((_lockoutUntil - now) / 1000);
      return { success: false, message: `Too many failed attempts. Try again in ${remainSec} seconds.` };
    }

    // H-01: Apply exponential backoff delay
    if (_failedAttempts > 0) {
      const delayMs = Math.min(1000 * Math.pow(2, _failedAttempts - 1), BACKOFF_CAP_MS);
      await new Promise(resolve => global.setTimeout(resolve, delayMs));
    }

    const result = await vaultManager.unlockVault(masterPassword);

    if (result.success) {
      _failedAttempts = 0; // H-01: Reset on success
      _lockoutUntil = 0;
      autoLock.start();
    } else {
      _failedAttempts++;
      // H-01: Hard lockout after MAX_FAILURES
      if (_failedAttempts >= MAX_FAILURES) {
        _lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
        _failedAttempts = 0;
        return { success: false, message: 'Too many failed attempts. Vault locked for 5 minutes.' };
      }
    }

    return result;
  });

  ipcMain.handle('vault:lock', () => {
    autoLock.stop();
    clipboardGuard.clearNow();
    return vaultManager.lockVault();
  });

  ipcMain.handle('vault:changeMasterPassword', async (_event, currentPw, newPw) => {
    if (!currentPw || !newPw) {
      return { success: false, message: 'Both passwords required.' };
    }
    return await vaultManager.changeMasterPassword(currentPw, newPw);
  });

  // ── Entry CRUD ────────────────────────────────────────────────────────

  ipcMain.handle('vault:getEntries', () => {
    try {
      return { success: true, entries: vaultManager.getEntries() };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:getEntry', (_event, id) => {
    try {
      const entry = vaultManager.getEntryById(id);
      return entry ? { success: true, entry } : { success: false, message: 'Not found.' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:addEntry', async (_event, entryData) => {
    // 🚨 1. AŞAMA: Tip Kontrolü (Obje olmalı, Array olmamalı)
    if (!entryData || typeof entryData !== 'object' || Array.isArray(entryData)) {
      console.error('[GÜVENLİK] Geçersiz entryData formatı reddedildi.');
      return { success: false, message: 'Güvenlik İhlali: Geçersiz veri formatı.' };
    }

    // 🚨 2. AŞAMA: RAM Şişirme / Kötü Kod Sınırları
    if (entryData.url && (typeof entryData.url !== 'string' || entryData.url.length > 2000)) {
      return { success: false, message: 'Güvenlik İhlali: URL çok uzun veya geçersiz.' };
    }
    if (entryData.username && (typeof entryData.username !== 'string' || entryData.username.length > 255)) {
      return { success: false, message: 'Güvenlik İhlali: Kullanıcı adı çok uzun veya geçersiz.' };
    }
    if (entryData.password && (typeof entryData.password !== 'string' || entryData.password.length > 1024)) {
      return { success: false, message: 'Güvenlik İhlali: Şifre çok uzun veya geçersiz.' };
    }
    // M-02: Validate title and notes length
    if (entryData.title && (typeof entryData.title !== 'string' || entryData.title.length > 500)) {
      return { success: false, message: 'Güvenlik İhlali: Başlık çok uzun veya geçersiz.' };
    }
    if (entryData.notes && (typeof entryData.notes !== 'string' || entryData.notes.length > 10000)) {
      return { success: false, message: 'Güvenlik İhlali: Notlar çok uzun veya geçersiz.' };
    }
    // M-02: Validate category against allowlist
    if (entryData.category && !VALID_CATEGORIES.has(String(entryData.category).toLowerCase())) {
      entryData.category = 'login'; // Fallback to default
    }

    try {
      return await vaultManager.addEntry(entryData);
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:updateEntry', async (_event, id, updates) => {
    // 🚨 ID Kontrolü (Max 50 karakterli bir metin olmalı)
    if (!isSafeString(id, 50)) {
      return { success: false, message: 'Güvenlik İhlali: Geçersiz ID formatı.' };
    }

    // 🚨 Updates Objesi Kontrolü
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return { success: false, message: 'Güvenlik İhlali: Geçersiz güncelleme formatı.' };
    }

    try {
      return await vaultManager.updateEntry(id, updates);
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:deleteEntry', async (_event, id) => {
    // 🚨 ID içine SQL/Dosya yolu kodu sızdırılmasını engelle
    if (!isSafeString(id, 50)) {
      console.error('[GÜVENLİK] Geçersiz ID ile silme girişimi engellendi:', id);
      return { success: false, message: 'Güvenlik İhlali: Geçersiz ID.' };
    }

    try {
      return await vaultManager.deleteEntry(id);
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:searchDomain', (_event, domain) => {
    // 🚨 Arama kutusuna devasa kodlar yazıp sistemi kilitlemelerini engelle
    if (domain && (typeof domain !== 'string' || domain.length > 2000)) {
      console.error('[GÜVENLİK] Çok uzun arama metni engellendi.');
      return { success: false, message: 'Güvenlik İhlali: Geçersiz arama metni.' };
    }

    try {
      return { success: true, entries: vaultManager.searchByDomain(domain || '') };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:getCredential', (_event, id) => {
    try {
      const cred = vaultManager.getCredential(id);
      return cred ? { success: true, credential: cred } : { success: false, message: 'Not found.' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // ── Import & Export ───────────────────────────────────────────────────

  ipcMain.handle('vault:getExportTargets', () => {
    return importExport.getExportTargets();
  });

  ipcMain.handle('vault:import', async (_event) => {
    // Open file dialog
    const result = await dialog.showOpenDialog({
      title: 'Import Passwords',
      filters: [
        { name: 'Supported Files', extensions: ['csv', 'json'] },
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'JSON Files', extensions: ['json'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'Import cancelled.' };
    }

    const importResult = importExport.importFromFile(result.filePaths[0]);
    if (!importResult.success) return importResult;

    // Add imported entries to vault
    try {
      const addResult = await vaultManager.addBulkEntries(importResult.entries);
      return {
        success: true,
        message: `Imported ${addResult.imported} entries from ${importResult.format} format.`,
        imported: addResult.imported,
        format: importResult.format
      };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('vault:export', async (_event, targetFormat) => {
    if (!targetFormat) {
      return { success: false, message: 'Export format required.' };
    }

    const targets = importExport.getExportTargets();
    const target = targets.find(t => t.id === targetFormat);
    if (!target) {
      return { success: false, message: 'Unknown export format.' };
    }

    // Show save dialog
    const result = await dialog.showSaveDialog({
      title: 'Export Passwords',
      defaultPath: `passwords_export${target.ext}`,
      filters: [{ name: target.name, extensions: [target.ext.slice(1)] }]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, message: 'Export cancelled.' };
    }

    try {
      const entries = vaultManager.getEntries();
      return importExport.exportToFile(entries, targetFormat, result.filePath);
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // ── Password Generation ───────────────────────────────────────────────

  ipcMain.handle('password:generate', (_event, options) => {
    return passwordGenerator.generate(options || {});
  });

  ipcMain.handle('password:generatePassphrase', (_event, options) => {
    return passwordGenerator.generatePassphrase(options || {});
  });

  ipcMain.handle('password:analyze', (_event, password) => {
    return passwordGenerator.analyzeStrength(password || '');
  });

  ipcMain.handle('password:getPresets', () => {
    return passwordGenerator.getPresets();
  });

  // ── Clipboard ─────────────────────────────────────────────────────────

  ipcMain.handle('clipboard:copy', (_event, text, label) => {
    clipboardGuard.copyWithAutoClear(text, label || 'credential');
    return { success: true };
  });

  ipcMain.handle('clipboard:clearNow', () => {
    clipboardGuard.clearNow();
    return { success: true };
  });

  // ── Activity & Auto-Lock ──────────────────────────────────────────────

  ipcMain.handle('activity:report', () => {
    autoLock.recordActivity();
    return true;
  });

  ipcMain.handle('autolock:setTimeout', (_event, minutes) => {
    autoLock.setLockTimeout(typeof minutes === 'number' ? minutes : 5);
    vaultManager.saveSettings({ autoLockMinutes: minutes });
    return { success: true };
  });

  ipcMain.handle('autolock:getStatus', () => {
    return autoLock.getStatus();
  });

  // ── Settings ──────────────────────────────────────────────────────────

  ipcMain.handle('settings:get', () => {
    return vaultManager.loadSettings();
  });

  ipcMain.handle('settings:save', (_event, settings) => {
    vaultManager.saveSettings(settings);
    return { success: true };
  });

  ipcMain.handle('settings:setVaultPath', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select Vault Location',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'Cancelled.' };
    }
    const newPath = require('path').join(result.filePaths[0], 'vault.dat');
    vaultManager.setVaultPath(newPath);
    return { success: true, path: newPath };
  });

  ipcMain.handle('settings:resetVaultPath', () => {
    vaultManager.resetVaultPath();
    return { success: true };
  });

}

module.exports = { registerAllHandlers };
