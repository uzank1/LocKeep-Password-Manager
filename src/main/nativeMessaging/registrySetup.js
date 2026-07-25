/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Automated Registry Setup
 * ============================================================================
 * Automatically sets up the Native Messaging Host for all Chromium browsers
 * on app launch. This replaces the old manual install-native-host.js script.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.sifreyoneticisi.host';
const EXTENSION_ID = 'ekbnnplonjmlbmeobeeogidilhlingjj'; // Static ID from manifest.json 'key'

const BROWSER_REGISTRY_KEYS = {
  'Brave': `HKCU\\SOFTWARE\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  'Chrome': `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  'Edge': `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  'Vivaldi': `HKCU\\SOFTWARE\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}`,
  'Opera': `HKCU\\SOFTWARE\\Opera Software\\Opera Stable\\NativeMessagingHosts\\${HOST_NAME}`
};

function install() {
  if (process.platform !== 'win32') return;

  try {
    const appDataDir = path.join(app.getPath('appData'), 'LocKeepPasswordManager');
    if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

    // 1. Create batch wrapper
    const hostScript = path.join(app.getAppPath(), 'src', 'native-host', 'host.js');
    const batWrapper = path.join(appDataDir, 'native-host.bat');
    const nodePath = process.execPath;
    fs.writeFileSync(
      batWrapper,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodePath}" "${hostScript}" --lockeep-native-host %*\r\n`,
      'utf-8'
    );

    // 2. Write manifest JSON
    const manifestPath = path.join(appDataDir, `${HOST_NAME}.json`);
    const manifest = {
      name: 'com.sifreyoneticisi.host',
      description: 'LocKeep Password Manager - Native Messaging Host',
      path: batWrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // 3. Set registry keys
    for (const [browser, regKey] of Object.entries(BROWSER_REGISTRY_KEYS)) {
      try {
        execFileSync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore', windowsHide: true });
      } catch (err) {
        console.warn(`[Registry Setup] Failed to register for ${browser}:`, err.message);
      }
    }

    console.log('[Registry Setup] Native Messaging Host registered successfully.');
  } catch (err) {
    console.error('[Registry Setup] Failed:', err);
  }
}

module.exports = { install };
