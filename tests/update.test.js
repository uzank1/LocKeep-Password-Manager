'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');

const { createUpdateManager } = require(path.join(
  __dirname,
  '..',
  'src',
  'main',
  'system',
  'updateManager'
));
const { createUpdateInstallGuard } = require(path.join(
  __dirname,
  '..',
  'src',
  'main',
  'system',
  'updateInstallGuard'
));

let passed = 0;
let failed = 0;

async function check(testName, testFn) {
  try {
    await testFn();
    console.log(`  PASS: ${testName}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL: ${testName}`);
    console.error(`        ${error.stack || error.message}`);
    failed++;
  }
}

function createHarness({
  currentVersion = '1.0.3',
  availableVersion = '1.0.4',
  updateAvailable = true,
  initialSettings = {},
  vaultExists = true,
  prepareForInstall = async () => {}
} = {}) {
  const updater = new EventEmitter();
  const quitCalls = [];
  let settings = { ...initialSettings };

  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    if (updateAvailable) {
      updater.emit('update-available', { version: availableVersion });
    } else {
      updater.emit('update-not-available', { version: currentVersion });
    }
  };
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 42.4 });
    updater.emit('update-downloaded', { version: availableVersion });
  };
  updater.quitAndInstall = (...args) => quitCalls.push(args);

  const settingsStore = {
    loadSettings: () => ({ ...settings }),
    saveSettings: patch => {
      settings = { ...settings, ...patch };
      return { ...settings };
    },
    vaultExists: () => vaultExists
  };

  const manager = createUpdateManager({
    electronApp: {
      isPackaged: true,
      getVersion: () => currentVersion
    },
    updater,
    settingsStore,
    setTimeoutFn: callback => {
      callback();
      return 1;
    },
    clearTimeoutFn: () => {},
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    prepareForInstall
  });

  return {
    manager,
    updater,
    quitCalls,
    getSettings: () => ({ ...settings })
  };
}

async function run() {
  console.log('\nLocKeep - Application Update Tests\n');

  await check('Stable updates are user-controlled', async () => {
    const harness = createHarness();
    harness.manager.initialize({ automaticChecks: false });

    assert.strictEqual(harness.updater.allowPrerelease, false);
    assert.strictEqual(harness.updater.allowDowngrade, false);
    assert.strictEqual(harness.updater.autoDownload, false);
    assert.strictEqual(harness.updater.autoInstallOnAppQuit, false);
    assert.strictEqual(harness.updater.autoRunAppAfterInstall, true);
  });

  await check('Manual checks report when LocKeep is up to date', async () => {
    const harness = createHarness({ updateAvailable: false, vaultExists: false });
    harness.manager.initialize({ automaticChecks: false });

    const result = await harness.manager.checkForUpdates(true);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.state.status, 'up-to-date');
    assert.strictEqual(result.state.availableVersion, null);
  });

  await check('Automatic checks stay quiet when no update exists', async () => {
    const harness = createHarness({ updateAvailable: false, vaultExists: false });
    harness.manager.initialize({ automaticChecks: false });

    const result = await harness.manager.checkForUpdates(false);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.state.status, 'idle');
  });

  await check('Update downloads, records the version, and restarts for installation', async () => {
    const harness = createHarness({ vaultExists: false });
    harness.manager.initialize({ automaticChecks: false });

    const checkResult = await harness.manager.checkForUpdates(true);
    assert.strictEqual(checkResult.state.status, 'available');
    assert.strictEqual(checkResult.state.availableVersion, '1.0.4');

    const installResult = await harness.manager.downloadAndInstall();
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(installResult.success, true);
    assert.strictEqual(installResult.state.status, 'downloaded');
    assert.strictEqual(harness.getSettings().pendingUpdateVersion, '1.0.4');
    assert.deepStrictEqual(harness.quitCalls, [[true, true]]);
  });

  await check('Native messaging is released before the silent installer starts', async () => {
    const order = [];
    const harness = createHarness({
      vaultExists: false,
      prepareForInstall: async () => {
        order.push('prepare');
      }
    });
    harness.updater.quitAndInstall = (...args) => {
      order.push('install');
      harness.quitCalls.push(args);
    };
    harness.manager.initialize({ automaticChecks: false });

    await harness.manager.checkForUpdates(true);
    await harness.manager.downloadAndInstall();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(order, ['prepare', 'install']);
    assert.deepStrictEqual(harness.quitCalls, [[true, true]]);
  });

  await check('Windows update guard blocks and stops native messaging hosts', async () => {
    const fsCalls = [];
    let powershellCall = null;
    const guard = createUpdateInstallGuard({
      platform: 'win32',
      appDataDir: 'C:\\Users\\Test\\AppData\\Roaming\\LocKeepPasswordManager',
      executablePath: 'C:\\Program Files\\LocKeep\\LocKeepPasswordManager.exe',
      currentPid: 321,
      fsImpl: {
        mkdirSync: (...args) => fsCalls.push(['mkdir', ...args]),
        writeFileSync: (...args) => fsCalls.push(['write', ...args]),
        unlinkSync: (...args) => fsCalls.push(['unlink', ...args])
      },
      execFileFn: (file, args, options, callback) => {
        powershellCall = { file, args, options };
        callback(null, '', '');
      },
      logger: { warn: () => {} }
    });

    await guard.prepare();
    guard.release();

    assert.strictEqual(fsCalls[0][0], 'mkdir');
    assert.strictEqual(fsCalls[1][0], 'write');
    assert.strictEqual(fsCalls[1][1], guard.lockPath);
    assert.strictEqual(fsCalls[2][0], 'unlink');
    assert.strictEqual(fsCalls[2][1], guard.lockPath);
    assert.strictEqual(powershellCall.file, 'powershell.exe');
    assert.strictEqual(
      powershellCall.options.env.LOCKEEP_EXECUTABLE_PATH,
      'C:\\Program Files\\LocKeep\\LocKeepPasswordManager.exe'
    );
    assert.strictEqual(powershellCall.options.env.LOCKEEP_CURRENT_PID, '321');
    assert.ok(powershellCall.args.join(' ').includes('--lockeep-native-host'));
  });

  await check('Extension reload notice is shown only once for each installed version', async () => {
    const harness = createHarness({
      initialSettings: {
        lastRunVersion: '1.0.2',
        pendingUpdateVersion: '1.0.3'
      }
    });
    const initialState = harness.manager.initialize({ automaticChecks: false });

    assert.strictEqual(initialState.extensionReloadRequired, true);

    const acknowledgedState = harness.manager.acknowledgeExtensionReloadNotice();
    assert.strictEqual(acknowledgedState.extensionReloadRequired, false);
    assert.strictEqual(harness.getSettings().extensionReloadNoticeVersion, '1.0.3');
    assert.strictEqual(harness.getSettings().pendingUpdateVersion, null);

    const nextRun = createHarness({ initialSettings: harness.getSettings() });
    const nextState = nextRun.manager.initialize({ automaticChecks: false });
    assert.strictEqual(nextState.extensionReloadRequired, false);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run();
