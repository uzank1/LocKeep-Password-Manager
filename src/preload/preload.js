/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Preload Bridge
 * ============================================================================
 * Exposes a minimal, secure API to the renderer process via contextBridge.
 * This is the ONLY interface between the renderer (untrusted UI) and the
 * main process (trusted crypto/vault operations).
 *
 * SECURITY:
 * - Each function maps to exactly ONE ipcRenderer.invoke call
 * - No raw ipcRenderer access exposed
 * - No Node.js APIs accessible from renderer
 * - All sensitive operations delegated to main process
 * ============================================================================
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  // ── Vault Lifecycle ─────────────────────────────────────────────────────
  exists:               ()                    => ipcRenderer.invoke('vault:exists'),
  isUnlocked:           ()                    => ipcRenderer.invoke('vault:isUnlocked'),
  create:               (masterPassword)      => ipcRenderer.invoke('vault:create', masterPassword),
  unlock:               (masterPassword)      => ipcRenderer.invoke('vault:unlock', masterPassword),
  lock:                 ()                    => ipcRenderer.invoke('vault:lock'),
  changeMasterPassword: (currentPw, newPw)    => ipcRenderer.invoke('vault:changeMasterPassword', currentPw, newPw),

  // ── Entry CRUD ──────────────────────────────────────────────────────────
  getEntries:   ()              => ipcRenderer.invoke('vault:getEntries'),
  getEntry:     (id)            => ipcRenderer.invoke('vault:getEntry', id),
  addEntry:     (entryData)     => ipcRenderer.invoke('vault:addEntry', entryData),
  updateEntry:  (id, updates)   => ipcRenderer.invoke('vault:updateEntry', id, updates),
  deleteEntry:  (id)            => ipcRenderer.invoke('vault:deleteEntry', id),

  // ── Search (used by extension via native host relay) ────────────────────
  searchDomain: (domain)        => ipcRenderer.invoke('vault:searchDomain', domain),
  getCredential:(id)            => ipcRenderer.invoke('vault:getCredential', id),

  // ── Import & Export ─────────────────────────────────────────────────────
  importPasswords:   ()                     => ipcRenderer.invoke('vault:import'),
  exportPasswords:   (format)               => ipcRenderer.invoke('vault:export', format),
  getExportTargets:  ()                     => ipcRenderer.invoke('vault:getExportTargets'),

  // ── Password Generation ─────────────────────────────────────────────────
  generatePassword:    (options)  => ipcRenderer.invoke('password:generate', options),
  generatePassphrase:  (options)  => ipcRenderer.invoke('password:generatePassphrase', options),
  analyzePassword:     (password) => ipcRenderer.invoke('password:analyze', password),
  getPasswordPresets:  ()         => ipcRenderer.invoke('password:getPresets'),

  // ── Clipboard ───────────────────────────────────────────────────────────
  copyToClipboard: (text, label)  => ipcRenderer.invoke('clipboard:copy', text, label),
  clearClipboard:  ()             => ipcRenderer.invoke('clipboard:clearNow'),

  // ── Activity Reporting (for auto-lock) ──────────────────────────────────
  reportActivity: ()              => ipcRenderer.invoke('activity:report'),

  // ── Auto-Lock Settings ──────────────────────────────────────────────────
  setAutoLockTimeout: (minutes)   => ipcRenderer.invoke('autolock:setTimeout', minutes),
  getAutoLockStatus:  ()          => ipcRenderer.invoke('autolock:getStatus'),

  // ── Settings ────────────────────────────────────────────────────────────
  getSettings:       ()           => ipcRenderer.invoke('settings:get'),
  saveSettings:      (settings)   => ipcRenderer.invoke('settings:save', settings),
  setVaultPath:      ()           => ipcRenderer.invoke('settings:setVaultPath'),
  resetVaultPath:    ()           => ipcRenderer.invoke('settings:resetVaultPath'),

  // ── Event Listeners (Main → Renderer) ───────────────────────────────────
  // These allow the renderer to listen for events pushed from main process.
  onVaultLocked:      (callback) => ipcRenderer.on('vault:locked', (_e) => callback()),
  onVaultUpdated:     (callback) => ipcRenderer.on('vault:updated', (_e) => callback()),
  onClipboardCopied:  (callback) => ipcRenderer.on('clipboard:copied', (_e, data) => callback(data)),
  onClipboardCountdown:(callback) => ipcRenderer.on('clipboard:countdown', (_e, data) => callback(data)),
  onClipboardCleared: (callback) => ipcRenderer.on('clipboard:cleared', (_e, data) => callback(data)),

  // ── Native Drag and Drop ────────────────────────────────────────────────
  startExtensionDrag: () => ipcRenderer.send('drag-extension')
});
