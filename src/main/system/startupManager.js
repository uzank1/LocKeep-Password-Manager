'use strict';

const LOGIN_ITEM_NAME = 'LocKeepPasswordManager';

function createStartupManager({
  electronApp,
  platform = process.platform,
  executablePath = process.execPath
}) {
  function isSupported() {
    return platform === 'win32';
  }

  function getQueryOptions() {
    return {
      path: executablePath,
      args: []
    };
  }

  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      return {
        success: false,
        enabled: false,
        message: 'Invalid startup setting.'
      };
    }

    if (!isSupported()) {
      return {
        success: false,
        enabled: false,
        message: 'Start with Windows is only available on Windows.'
      };
    }

    // Development runs must never register electron.exe as a login item.
    if (!electronApp.isPackaged) {
      return { success: true, enabled };
    }

    try {
      electronApp.setLoginItemSettings({
        openAtLogin: enabled,
        enabled,
        name: LOGIN_ITEM_NAME,
        ...getQueryOptions()
      });

      const actualEnabled = getEnabled(enabled);
      if (actualEnabled !== enabled) {
        return {
          success: false,
          enabled: actualEnabled,
          message: 'Windows startup setting could not be updated.'
        };
      }

      return { success: true, enabled: actualEnabled };
    } catch (error) {
      return {
        success: false,
        enabled: getEnabled(false),
        message: error && error.message
          ? error.message
          : 'Windows startup setting could not be updated.'
      };
    }
  }

  function getEnabled(fallback = true) {
    if (!isSupported() || !electronApp.isPackaged) {
      return Boolean(fallback);
    }

    try {
      const settings = electronApp.getLoginItemSettings(getQueryOptions());
      return Boolean(
        settings.openAtLogin
        && settings.executableWillLaunchAtLogin !== false
      );
    } catch {
      return Boolean(fallback);
    }
  }

  return {
    isSupported,
    setEnabled,
    getEnabled
  };
}

function getDefaultManager() {
  const { app } = require('electron');
  return createStartupManager({ electronApp: app });
}

module.exports = {
  createStartupManager,
  isSupported: () => getDefaultManager().isSupported(),
  setEnabled: enabled => getDefaultManager().setEnabled(enabled),
  getEnabled: fallback => getDefaultManager().getEnabled(fallback)
};
