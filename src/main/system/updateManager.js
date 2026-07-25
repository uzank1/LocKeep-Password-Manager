'use strict';

const AUTO_CHECK_DELAY_MS = 10 * 1000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createUpdateManager({
  electronApp,
  updater,
  settingsStore,
  getWindows = () => [],
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  prepareForInstall = async () => {},
  cancelInstallPreparation = () => {}
}) {
  let initialized = false;
  let checkingPromise = null;
  let lastCheckWasManual = false;
  let installRequested = false;
  let installStarting = false;
  let initialCheckTimer = null;
  let periodicCheckTimer = null;

  let state = {
    status: 'idle',
    currentVersion: electronApp.getVersion(),
    availableVersion: null,
    progress: 0,
    error: null,
    extensionReloadRequired: false
  };

  function getState() {
    return { ...state };
  }

  function sendStateToWindows() {
    const snapshot = getState();
    for (const window of getWindows()) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('updates:state', snapshot);
      }
    }
  }

  function setState(patch) {
    state = { ...state, ...patch };
    sendStateToWindows();
    return getState();
  }

  function normalizeVersion(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(trimmed)
      ? trimmed
      : null;
  }

  function initializeExtensionReloadNotice() {
    const settings = settingsStore.loadSettings();
    const currentVersion = state.currentVersion;
    const previousVersion = normalizeVersion(settings.lastRunVersion);
    const pendingVersion = normalizeVersion(settings.pendingUpdateVersion);
    const noticeVersion = normalizeVersion(settings.extensionReloadNoticeVersion);
    const legacyUpgrade = !previousVersion && settingsStore.vaultExists();
    const versionChanged = Boolean(
      pendingVersion === currentVersion
      || (previousVersion && previousVersion !== currentVersion)
      || legacyUpgrade
    );

    state.extensionReloadRequired = versionChanged && noticeVersion !== currentVersion;
    settingsStore.saveSettings({ lastRunVersion: currentVersion });
  }

  function bindUpdaterEvents() {
    updater.on('checking-for-update', () => {
      setState({
        status: 'checking',
        progress: 0,
        error: null
      });
    });

    updater.on('update-available', info => {
      const version = normalizeVersion(info && info.version);
      setState({
        status: 'available',
        availableVersion: version,
        progress: 0,
        error: null
      });
    });

    updater.on('update-not-available', () => {
      setState({
        status: lastCheckWasManual ? 'up-to-date' : 'idle',
        availableVersion: null,
        progress: 0,
        error: null
      });
    });

    updater.on('download-progress', progress => {
      const percent = Number(progress && progress.percent);
      setState({
        status: 'downloading',
        progress: Number.isFinite(percent)
          ? Math.max(0, Math.min(100, Math.round(percent)))
          : 0,
        error: null
      });
    });

    updater.on('update-downloaded', info => {
      const version = normalizeVersion(info && info.version) || state.availableVersion;
      if (version) {
        settingsStore.saveSettings({ pendingUpdateVersion: version });
      }

      setState({
        status: 'downloaded',
        availableVersion: version,
        progress: 100,
        error: null
      });

      if (installRequested) {
        setTimeoutFn(() => {
          startDownloadedInstall().catch(() => {});
        }, 500);
      }
    });

    updater.on('error', error => {
      const message = error && error.message
        ? error.message
        : 'Update operation failed.';
      setState({
        status: lastCheckWasManual || installRequested ? 'error' : 'idle',
        progress: 0,
        error: lastCheckWasManual || installRequested ? message : null
      });
      installRequested = false;
      installStarting = false;
      Promise.resolve(cancelInstallPreparation()).catch(() => {});
    });
  }

  async function startDownloadedInstall() {
    if (!installRequested || installStarting) return;
    installStarting = true;

    try {
      await prepareForInstall();
      updater.quitAndInstall(true, true);
    } catch (error) {
      installRequested = false;
      installStarting = false;
      await Promise.resolve(cancelInstallPreparation()).catch(() => {});
      const message = error && error.message
        ? error.message
        : 'Update installation could not be started.';
      setState({
        status: 'error',
        progress: 0,
        error: message
      });
    }
  }

  function initialize({ automaticChecks = true } = {}) {
    if (initialized) return getState();
    initialized = true;

    initializeExtensionReloadNotice();

    if (!electronApp.isPackaged) {
      return setState({ status: 'unsupported' });
    }

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    bindUpdaterEvents();

    if (automaticChecks) {
      initialCheckTimer = setTimeoutFn(() => {
        checkForUpdates(false).catch(() => {});
      }, AUTO_CHECK_DELAY_MS);
      periodicCheckTimer = setIntervalFn(() => {
        checkForUpdates(false).catch(() => {});
      }, AUTO_CHECK_INTERVAL_MS);
    }

    sendStateToWindows();
    return getState();
  }

  async function checkForUpdates(manual = true) {
    if (!electronApp.isPackaged) {
      return {
        success: false,
        state: setState({ status: 'unsupported' }),
        message: 'Updates can only be checked in the installed application.'
      };
    }

    if (checkingPromise) {
      return { success: true, state: getState() };
    }

    lastCheckWasManual = Boolean(manual);
    installRequested = false;
    setState({ status: 'checking', progress: 0, error: null });

    checkingPromise = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then(() => ({ success: true, state: getState() }))
      .catch(error => {
        const message = error && error.message
          ? error.message
          : 'Update check failed.';
        const nextStatus = lastCheckWasManual ? 'error' : 'idle';
        const nextState = setState({
          status: nextStatus,
          error: lastCheckWasManual ? message : null
        });
        return { success: false, state: nextState, message };
      })
      .finally(() => {
        checkingPromise = null;
      });

    return checkingPromise;
  }

  async function downloadAndInstall() {
    if (state.status !== 'available') {
      return {
        success: false,
        state: getState(),
        message: 'No update is ready to download.'
      };
    }

    installRequested = true;
    installStarting = false;
    setState({ status: 'downloading', progress: 0, error: null });

    try {
      await updater.downloadUpdate();
      return { success: true, state: getState() };
    } catch (error) {
      installRequested = false;
      installStarting = false;
      const message = error && error.message
        ? error.message
        : 'Update download failed.';
      return {
        success: false,
        state: setState({ status: 'error', progress: 0, error: message }),
        message
      };
    }
  }

  function acknowledgeExtensionReloadNotice() {
    settingsStore.saveSettings({
      extensionReloadNoticeVersion: state.currentVersion,
      pendingUpdateVersion: null
    });
    return setState({ extensionReloadRequired: false });
  }

  function dispose() {
    if (initialCheckTimer) {
      clearTimeoutFn(initialCheckTimer);
      initialCheckTimer = null;
    }
    if (periodicCheckTimer) {
      clearIntervalFn(periodicCheckTimer);
      periodicCheckTimer = null;
    }
  }

  return {
    initialize,
    getState,
    checkForUpdates,
    downloadAndInstall,
    acknowledgeExtensionReloadNotice,
    dispose
  };
}

let defaultManager = null;

function getDefaultManager() {
  if (!defaultManager) {
    const { app, BrowserWindow } = require('electron');
    const { autoUpdater } = require('electron-updater');
    const vaultManager = require('../vault/vaultManager');
    const updateInstallGuard = require('./updateInstallGuard');
    defaultManager = createUpdateManager({
      electronApp: app,
      updater: autoUpdater,
      settingsStore: vaultManager,
      getWindows: () => BrowserWindow.getAllWindows(),
      prepareForInstall: () => updateInstallGuard.prepare(),
      cancelInstallPreparation: () => updateInstallGuard.release()
    });
  }
  return defaultManager;
}

module.exports = {
  createUpdateManager,
  initialize: options => getDefaultManager().initialize(options),
  getState: () => getDefaultManager().getState(),
  checkForUpdates: manual => getDefaultManager().checkForUpdates(manual),
  downloadAndInstall: () => getDefaultManager().downloadAndInstall(),
  acknowledgeExtensionReloadNotice: () => getDefaultManager().acknowledgeExtensionReloadNotice(),
  dispose: () => getDefaultManager().dispose()
};
