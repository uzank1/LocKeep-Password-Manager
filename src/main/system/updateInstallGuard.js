'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const UPDATE_LOCK_FILENAME = '.update-in-progress';

function runExecFile(execFileFn, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileFn(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function createUpdateInstallGuard({
  platform = process.platform,
  appDataDir,
  executablePath = process.execPath,
  currentPid = process.pid,
  fsImpl = fs,
  execFileFn = execFile,
  logger = console
}) {
  if (!appDataDir) {
    throw new Error('An application data directory is required.');
  }

  const lockPath = path.join(appDataDir, UPDATE_LOCK_FILENAME);

  function createLock() {
    fsImpl.mkdirSync(appDataDir, { recursive: true });
    fsImpl.writeFileSync(lockPath, String(Date.now()), {
      encoding: 'utf8',
      mode: 0o600
    });
  }

  function release() {
    try {
      fsImpl.unlinkSync(lockPath);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logger.warn('[Updater] Could not remove the update lock:', error.message);
      }
    }
  }

  async function stopWindowsNativeHosts() {
    if (platform !== 'win32') return;

    const script = [
      '$targetPath = $env:LOCKEEP_EXECUTABLE_PATH;',
      '$currentPid = [int]$env:LOCKEEP_CURRENT_PID;',
      'Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue',
      '| Where-Object {',
      '$_.ProcessId -ne $currentPid',
      '-and $_.ExecutablePath -eq $targetPath',
      "-and ($_.CommandLine -match 'native-host[\\\\/]host\\.js'",
      "-or $_.CommandLine -match '--lockeep-native-host')",
      '}',
      '| ForEach-Object {',
      'Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue',
      '}'
    ].join(' ');

    await runExecFile(
      execFileFn,
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          LOCKEEP_EXECUTABLE_PATH: executablePath,
          LOCKEEP_CURRENT_PID: String(currentPid)
        }
      }
    );
  }

  async function prepare() {
    createLock();

    try {
      await stopWindowsNativeHosts();
    } catch (error) {
      // The installer repeats this cleanup before replacing files. Keeping this
      // best-effort avoids blocking an update when PowerShell is unavailable.
      logger.warn('[Updater] Native host cleanup will be retried by the installer:', error.message);
    }
  }

  return {
    lockPath,
    prepare,
    release
  };
}

let defaultGuard = null;

function getDefaultGuard() {
  if (!defaultGuard) {
    const { app } = require('electron');
    defaultGuard = createUpdateInstallGuard({
      appDataDir: path.join(app.getPath('appData'), 'LocKeepPasswordManager')
    });
  }
  return defaultGuard;
}

module.exports = {
  UPDATE_LOCK_FILENAME,
  createUpdateInstallGuard,
  prepare: () => getDefaultGuard().prepare(),
  release: () => getDefaultGuard().release()
};
