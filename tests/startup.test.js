'use strict';

const assert = require('assert');
const path = require('path');

const { createStartupManager } = require(path.join(
  __dirname,
  '..',
  'src',
  'main',
  'system',
  'startupManager'
));

let passed = 0;
let failed = 0;

function check(testName, testFn) {
  try {
    testFn();
    console.log(`  PASS: ${testName}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL: ${testName}`);
    console.error(`        ${error.message}`);
    failed++;
  }
}

function createElectronAppStub({ isPackaged = true } = {}) {
  let startupEnabled = false;
  const calls = [];

  return {
    app: {
      isPackaged,
      setLoginItemSettings(options) {
        calls.push(options);
        startupEnabled = Boolean(options.openAtLogin && options.enabled);
      },
      getLoginItemSettings() {
        return {
          openAtLogin: startupEnabled,
          executableWillLaunchAtLogin: startupEnabled
        };
      }
    },
    calls
  };
}

console.log('\nLocKeep - Windows Startup Tests\n');

check('Enabling startup registers the packaged executable', () => {
  const stub = createElectronAppStub();
  const manager = createStartupManager({
    electronApp: stub.app,
    platform: 'win32',
    executablePath: 'C:\\Program Files\\LocKeep\\LocKeepPasswordManager.exe'
  });

  const result = manager.setEnabled(true);

  assert.deepStrictEqual(result, { success: true, enabled: true });
  assert.strictEqual(stub.calls.length, 1);
  assert.strictEqual(stub.calls[0].openAtLogin, true);
  assert.strictEqual(stub.calls[0].enabled, true);
  assert.strictEqual(stub.calls[0].name, 'LocKeepPasswordManager');
  assert.deepStrictEqual(stub.calls[0].args, []);
});

check('Disabling startup removes the login item', () => {
  const stub = createElectronAppStub();
  const manager = createStartupManager({
    electronApp: stub.app,
    platform: 'win32',
    executablePath: 'C:\\Program Files\\LocKeep\\LocKeepPasswordManager.exe'
  });

  manager.setEnabled(true);
  const result = manager.setEnabled(false);

  assert.deepStrictEqual(result, { success: true, enabled: false });
  assert.strictEqual(stub.calls.at(-1).openAtLogin, false);
});

check('Invalid startup values are rejected', () => {
  const stub = createElectronAppStub();
  const manager = createStartupManager({
    electronApp: stub.app,
    platform: 'win32'
  });

  const result = manager.setEnabled('yes');

  assert.strictEqual(result.success, false);
  assert.strictEqual(stub.calls.length, 0);
});

check('Development mode never registers electron.exe', () => {
  const stub = createElectronAppStub({ isPackaged: false });
  const manager = createStartupManager({
    electronApp: stub.app,
    platform: 'win32'
  });

  const result = manager.setEnabled(true);

  assert.deepStrictEqual(result, { success: true, enabled: true });
  assert.strictEqual(stub.calls.length, 0);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
