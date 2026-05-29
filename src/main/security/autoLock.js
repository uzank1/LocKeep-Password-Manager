/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Auto-Lock Module
 * ============================================================================
 * Monitors user activity and locks the vault after configurable inactivity.
 * Default: 5 minutes. Configurable: 1, 5, 15 min, or never.
 *
 * IMPORTANT: Only invoke from Electron Main Process.
 * ============================================================================
 */

'use strict';

const { BrowserWindow } = require('electron');

// ─── State ──────────────────────────────────────────────────────────────────

/** Inactivity timer handle */
let _timer = null;

/** Timeout in milliseconds (default: 5 minutes) */
let _timeoutMs = 5 * 60 * 1000;

/** Callback invoked when auto-lock triggers */
let _onLock = null;

/** Whether auto-lock is enabled */
let _enabled = true;

/** Timestamp of last activity */
let _lastActivity = Date.now();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initializes the auto-lock system.
 * @param {Function} onLockCallback - Called when inactivity timeout is reached
 * @param {number}   [timeoutMinutes=5] - Timeout in minutes (0 = disabled)
 */
function initialize(onLockCallback, timeoutMinutes = 5) {
  _onLock = onLockCallback;
  setLockTimeout(timeoutMinutes);
}

/**
 * Sets the auto-lock timeout.
 * @param {number} minutes - Timeout in minutes (0 = never/disabled)
 */
function setLockTimeout(minutes) {
  if (minutes <= 0) {
    _enabled = false;
    _timeoutMs = 0;
    clearTimer();
    return;
  }

  _enabled = true;
  _timeoutMs = minutes * 60 * 1000;
  resetTimer();
}

/**
 * Records user activity — resets the inactivity timer.
 * Call this from IPC when the renderer reports mouse/keyboard events.
 */
function recordActivity() {
  _lastActivity = Date.now();
  if (_enabled) resetTimer();
}

/**
 * Starts the auto-lock timer. Call after vault unlock.
 */
function start() {
  if (_enabled) resetTimer();
}

/**
 * Stops the auto-lock timer. Call after vault lock.
 */
function stop() {
  clearTimer();
}

/**
 * Returns current auto-lock configuration.
 * @returns {{ enabled: boolean, timeoutMinutes: number, remainingMs: number }}
 */
function getStatus() {
  const elapsed = Date.now() - _lastActivity;
  return {
    enabled: _enabled,
    timeoutMinutes: _timeoutMs / 60000,
    remainingMs: _enabled ? Math.max(0, _timeoutMs - elapsed) : -1
  };
}

/**
 * Disposes all timers (call on app quit).
 */
function dispose() {
  clearTimer();
  _onLock = null;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function resetTimer() {
  clearTimer();
  _timer = global.setTimeout(() => {
    if (_onLock) {
      _onLock();
      // Notify all renderer windows
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('vault:locked');
        }
      });
    }
  }, _timeoutMs);
}

function clearTimer() {
  if (_timer) {
    global.clearTimeout(_timer);
    _timer = null;
  }
}

module.exports = {
  initialize,
  setLockTimeout,
  recordActivity,
  start,
  stop,
  getStatus,
  dispose
};
