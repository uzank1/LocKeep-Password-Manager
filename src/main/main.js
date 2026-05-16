/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Main Process Entry Point
 * ============================================================================
 * Electron main process: creates the window, enforces security policies,
 * blocks all network traffic, registers IPC handlers, and manages lifecycle.
 *
 * SECURITY HARDENING:
 * - contextIsolation: true (renderer cannot access Node.js)
 * - nodeIntegration: false (no require() in renderer)
 * - Strict CSP: no inline scripts, no eval, no external resources
 * - All outbound network requests blocked
 * - Single instance lock (prevent multiple instances)
 * - Sandbox enabled
 * ============================================================================
 */

'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const { registerAllHandlers } = require('./ipc/handlers');
const autoLock = require('./security/autoLock');
const clipboardGuard = require('./security/clipboardGuard');
const vaultManager = require('./vault/vaultManager');
const { startServer: startIPCServer, stopServer: stopIPCServer } = require('./nativeMessaging/nativeHost');

// ─── Single Instance Lock ───────────────────────────────────────────────────
// Prevent multiple instances of the app from running simultaneously.
// A second instance could cause vault file corruption.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window when user tries to open a second instance
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });
}

// ─── Main Window ────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'LocKeep Password Manager',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icons', 'icon.ico'),
    backgroundColor: '#0a0a0f',
    show: false, // Show after ready-to-show to prevent flash

    webPreferences: {
      // ── CRITICAL SECURITY SETTINGS ──
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,      // Renderer JS cannot access preload context
      nodeIntegration: false,     // No require(), no process, no Buffer in renderer
      sandbox: true,      // Additional OS-level sandboxing
      webSecurity: true,      // Enforce same-origin policy
      allowRunningInsecureContent: false,
      experimentalFeatures: false,

      // Disable unnecessary features to minimize attack surface
      webgl: false,
      plugins: false,
      spellcheck: false
    }
  });

  // Show window gracefully after content loads
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Remove the default menu bar (cleaner UI + removes dev tools access in prod)
  mainWindow.setMenuBarVisibility(false);

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open DevTools in development mode only
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Security: Block ALL Network Requests ───────────────────────────────────
// This password manager is STRICTLY OFFLINE. No requests should ever leave
// the machine. We intercept and block every outbound request at the session
// level as a defense-in-depth measure.

function enforceNetworkBlock() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;

    // Allow loading local files (file:// protocol) and devtools
    if (url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('chrome-extension://')) {
      callback({ cancel: false });
      return;
    }

    // Block everything else (http, https, ws, wss, ftp, etc.)
    console.warn(`[SECURITY] Blocked outbound request: ${url}`);
    callback({ cancel: true });
  });
}

// ─── Security: Enforce Content Security Policy ──────────────────────────────
// Even though we block network requests, CSP provides defense-in-depth
// against XSS and code injection attacks.

function enforceCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +   // Allow inline styles for dynamic UI
          "font-src 'self'; " +
          "img-src 'self' data:; " +
          "connect-src 'none'; " +                   // Block all network connections
          "object-src 'none'; " +
          "base-uri 'none'; " +
          "form-action 'none'; " +
          "frame-ancestors 'none'"
        ]
      }
    });
  });
}

// ─── Security: Prevent Navigation ───────────────────────────────────────────
// Prevent the renderer from navigating to any URL. The app is a single-page
// application that should never navigate away from index.html.

function preventNavigation() {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => {
      event.preventDefault();
      console.warn('[SECURITY] Blocked navigation attempt.');
    });

    // Block new window creation (popups, target="_blank", etc.)
    contents.setWindowOpenHandler(() => {
      console.warn('[SECURITY] Blocked window.open attempt.');
      return { action: 'deny' };
    });
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Initialize security measures BEFORE creating the window
  enforceNetworkBlock();
  enforceCSP();
  preventNavigation();

  // Initialize vault settings (load custom vault path if set)
  vaultManager.initializeFromSettings();

  // Register all IPC handlers
  registerAllHandlers();

  // Native Drag and Drop for Browser Extension
  const { ipcMain } = require('electron');
  ipcMain.on('drag-extension', (event) => {
    const isPackaged = app.isPackaged;
    const extensionPath = isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'extension')
      : path.join(app.getAppPath(), 'extension');
    
    // We can still use the standard path for icon if it's accessible via Electron, 
    // but NativeImage or unpacked icon is safer. Since it's inside app.asar and Electron's native drag uses it,
    // let's create a NativeImage to be absolutely safe across all platforms.
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, '..', 'renderer', 'assets', 'icons', 'icon.ico');
    const iconImage = nativeImage.createFromPath(iconPath);

    event.sender.startDrag({
      file: extensionPath,
      icon: iconImage
    });
  });

  // Run automated registry setup for native messaging
  const registrySetup = require('./nativeMessaging/registrySetup');
  registrySetup.install();

  // Start IPC server for native messaging host communication
  startIPCServer().catch(err => {
    console.error('[IPC Server] Failed to start:', err.message);
  });

  // Initialize auto-lock with vault lock callback
  const settings = vaultManager.loadSettings();
  autoLock.initialize(() => {
    vaultManager.lockVault();
    clipboardGuard.clearNow();
  }, settings.autoLockMinutes || 5);

  // Create the main window
  createWindow();
});

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up on app quit
app.on('before-quit', () => {
  // Lock vault and zeroize all sensitive data
  vaultManager.lockVault();
  clipboardGuard.dispose();
  autoLock.dispose();
  stopIPCServer();
});

// ─── Security: Disable Hardware Acceleration ────────────────────────────────
// Reduces GPU attack surface. Password managers don't need hardware acceleration.
app.disableHardwareAcceleration();
