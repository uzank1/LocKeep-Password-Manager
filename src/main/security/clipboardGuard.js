/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Clipboard Guard Module
 * ============================================================================
 * Automatically clears the clipboard 30 seconds after a credential copy.
 * Prevents clipboard snooping by ensuring passwords don't linger.
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const { clipboard, BrowserWindow } = require('electron');

// ─── State ──────────────────────────────────────────────────────────────────

/** Clipboard clear timer handle */
let _clearTimer = null;

/** Clear delay in milliseconds */
const CLEAR_DELAY_MS = 30 * 1000; // 30 seconds

/** Countdown interval for UI notification */
let _countdownInterval = null;

/** Remaining seconds for UI display */
let _remainingSeconds = 0;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Copies text to clipboard and starts the 30-second auto-clear timer.
 * If a previous timer is running, it is reset (the new copy takes priority).
 *
 * @param {string} text  - The text to copy (username or password)
 * @param {string} label - Label for UI display ('username' or 'password')
 */
function copyWithAutoClear(text, label = 'credential') {
  // Write to clipboard
  clipboard.writeText(text);

  // Cancel any existing timer
  cancelTimer();

  _remainingSeconds = Math.ceil(CLEAR_DELAY_MS / 1000);

  // Start countdown for UI updates
  _countdownInterval = setInterval(() => {
    _remainingSeconds--;
    notifyRenderer('clipboard:countdown', { remaining: _remainingSeconds, label });

    if (_remainingSeconds <= 0) {
      clearInterval(_countdownInterval);
      _countdownInterval = null;
    }
  }, 1000);

  // Set the actual clear timer
  _clearTimer = setTimeout(() => {
    clearClipboard();
    notifyRenderer('clipboard:cleared', { label });
    _clearTimer = null;
  }, CLEAR_DELAY_MS);

  // Notify renderer that clipboard copy started
  notifyRenderer('clipboard:copied', {
    label,
    clearInSeconds: Math.ceil(CLEAR_DELAY_MS / 1000)
  });
}

/**
 * Immediately clears the clipboard and cancels any pending timer.
 */
function clearNow() {
  cancelTimer();
  clearClipboard();
}

/**
 * Returns whether a clear timer is currently active.
 * @returns {{ active: boolean, remainingSeconds: number }}
 */
function getStatus() {
  return {
    active: _clearTimer !== null,
    remainingSeconds: _remainingSeconds
  };
}

/**
 * Disposes all timers (call on app quit).
 */
function dispose() {
  cancelTimer();
}

// ─── Internal ───────────────────────────────────────────────────────────────

function clearClipboard() {
  // Overwrite clipboard with empty string
  clipboard.writeText('');
}

function cancelTimer() {
  if (_clearTimer) {
    clearTimeout(_clearTimer);
    _clearTimer = null;
  }
  if (_countdownInterval) {
    clearInterval(_countdownInterval);
    _countdownInterval = null;
  }
  _remainingSeconds = 0;
}

/**
 * Sends an event to all renderer windows.
 * @param {string} channel - IPC channel name
 * @param {Object} data    - Event data
 */
function notifyRenderer(channel, data) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}

module.exports = {
  copyWithAutoClear,
  clearNow,
  getStatus,
  dispose
};
