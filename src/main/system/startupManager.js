'use strict';

const { spawnSync } = require('child_process');

const LOGIN_ITEM_NAME = 'LocKeepPasswordManager';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_APPROVED_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

function formatExecutableCommand(executablePath) {
  if (typeof executablePath !== 'string' || executablePath.length === 0 || executablePath.includes('"')) {
    return null;
  }
  return `"${executablePath}"`;
}

function createWindowsRunRegistry({
  runRegistry = args => spawnSync('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true
  })
} = {}) {
  function queryValue(key, name, type) {
    const result = runRegistry(['QUERY', key, '/v', name]);
    if (!result || result.status !== 0) return null;

    const output = typeof result.stdout === 'string' ? result.stdout : '';
    const match = output.match(new RegExp(`\\s${type}\\s+([^\\r\\n]+)`));
    return match ? match[1].trim() : null;
  }

  function deleteValue(key, name) {
    const result = runRegistry(['DELETE', key, '/v', name, '/f']);
    return Boolean(result && (result.status === 0 || result.status === 1));
  }

  function normalizeCommand(value) {
    return typeof value === 'string'
      ? value.trim().toLowerCase()
      : '';
  }

  function getEnabled(name, executablePath) {
    const command = formatExecutableCommand(executablePath);
    if (!command) return false;

    const registeredCommand = queryValue(RUN_KEY, name, 'REG_SZ');
    if (normalizeCommand(registeredCommand) !== normalizeCommand(command)) {
      return false;
    }

    const approval = queryValue(STARTUP_APPROVED_RUN_KEY, name, 'REG_BINARY');
    return !approval || !approval.replace(/\s/g, '').startsWith('03');
  }

  function setEnabled(name, executablePath, enabled) {
    const command = formatExecutableCommand(executablePath);
    if (!command || typeof enabled !== 'boolean') return false;

    if (enabled) {
      const result = runRegistry([
        'ADD',
        RUN_KEY,
        '/v',
        name,
        '/t',
        'REG_SZ',
        '/d',
        command,
        '/f'
      ]);
      if (!result || result.status !== 0) return false;

      // Removing a stale disabled approval entry lets Windows recreate it in
      // the enabled state for the newly registered Run value.
      deleteValue(STARTUP_APPROVED_RUN_KEY, name);
    } else {
      deleteValue(RUN_KEY, name);
      deleteValue(STARTUP_APPROVED_RUN_KEY, name);
    }

    return getEnabled(name, executablePath) === enabled;
  }

  return {
    getEnabled,
    setEnabled
  };
}

function createStartupManager({
  electronApp,
  platform = process.platform,
  executablePath = process.execPath,
  windowsRegistry = null
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
        messageKey: 'settings.startupUpdateFailed'
      };
    }

    if (!isSupported()) {
      return {
        success: false,
        enabled: false,
        messageKey: 'settings.startupUnsupported'
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

    } catch {
      // The registry fallback below handles systems where Electron cannot
      // update or immediately verify the login item.
    }

    let actualEnabled = getEnabled(!enabled);
    if (actualEnabled !== enabled && windowsRegistry) {
      windowsRegistry.setEnabled(LOGIN_ITEM_NAME, executablePath, enabled);
      actualEnabled = getEnabled(!enabled);
    }

    return actualEnabled === enabled
      ? { success: true, enabled: actualEnabled }
      : {
          success: false,
          enabled: actualEnabled,
          messageKey: 'settings.startupUpdateFailed'
        };
  }

  function getEnabled(fallback = true) {
    if (!isSupported() || !electronApp.isPackaged) {
      return Boolean(fallback);
    }

    let electronQuerySucceeded = false;
    try {
      const settings = electronApp.getLoginItemSettings(getQueryOptions());
      electronQuerySucceeded = true;
      const matchingLaunchItem = Array.isArray(settings.launchItems)
        ? settings.launchItems.find(item =>
            item
            && item.name === LOGIN_ITEM_NAME
            && typeof item.path === 'string'
            && item.path.toLowerCase() === executablePath.toLowerCase()
          )
        : null;

      if (matchingLaunchItem) {
        return matchingLaunchItem.enabled !== false;
      }

      if (settings.openAtLogin && settings.executableWillLaunchAtLogin !== false) {
        return true;
      }
    } catch {
      // Fall through to the direct registry query.
    }

    if (windowsRegistry) {
      return windowsRegistry.getEnabled(LOGIN_ITEM_NAME, executablePath);
    }

    return electronQuerySucceeded ? false : Boolean(fallback);
  }

  return {
    isSupported,
    setEnabled,
    getEnabled
  };
}

function getDefaultManager() {
  const { app } = require('electron');
  return createStartupManager({
    electronApp: app,
    windowsRegistry: createWindowsRunRegistry()
  });
}

module.exports = {
  createStartupManager,
  createWindowsRunRegistry,
  formatExecutableCommand,
  isSupported: () => getDefaultManager().isSupported(),
  setEnabled: enabled => getDefaultManager().setEnabled(enabled),
  getEnabled: fallback => getDefaultManager().getEnabled(fallback)
};
