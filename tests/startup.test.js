'use strict';

const assert = require('assert');
const path = require('path');

const {
  createStartupManager,
  createWindowsRunRegistry,
  formatExecutableCommand
} = require(path.join(
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

function createElectronAppStub({ isPackaged = true, ignoreWrites = false } = {}) {
  let startupEnabled = false;
  const calls = [];

  return {
    app: {
      isPackaged,
      setLoginItemSettings(options) {
        calls.push(options);
        if (!ignoreWrites) {
          startupEnabled = Boolean(options.openAtLogin && options.enabled);
        }
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

function createRegistryStub({ writeSucceeds = true } = {}) {
  let enabled = false;
  const calls = [];

  return {
    registry: {
      getEnabled() {
        return enabled;
      },
      setEnabled(name, executablePath, requestedState) {
        calls.push({ name, executablePath, enabled: requestedState });
        if (writeSucceeds) enabled = requestedState;
        return writeSucceeds;
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

check('Registry fallback handles Electron login item write failures', () => {
  const stub = createElectronAppStub({ ignoreWrites: true });
  const registryStub = createRegistryStub();
  const executablePath = 'C:\\Program Files\\LocKeep\\LocKeepPasswordManager.exe';
  const manager = createStartupManager({
    electronApp: stub.app,
    platform: 'win32',
    executablePath,
    windowsRegistry: registryStub.registry
  });

  const result = manager.setEnabled(true);

  assert.deepStrictEqual(result, { success: true, enabled: true });
  assert.deepStrictEqual(registryStub.calls, [{
    name: 'LocKeepPasswordManager',
    executablePath,
    enabled: true
  }]);
});

check('Startup errors return a localizable message key', () => {
  const stub = createElectronAppStub({ ignoreWrites: true });
  const registryStub = createRegistryStub({ writeSucceeds: false });
  const manager = createStartupManager({
    electronApp: stub.app,
    platform: 'win32',
    windowsRegistry: registryStub.registry
  });

  const result = manager.setEnabled(true);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.messageKey, 'settings.startupUpdateFailed');
});

check('Windows registry fallback writes a quoted executable command', () => {
  const values = new Map();
  const calls = [];
  const runRegistry = args => {
    calls.push(args);
    const operation = args[0];
    const key = args[1];
    const name = args[3];
    const valueKey = `${key}:${name}`;

    if (operation === 'ADD') {
      values.set(valueKey, { type: 'REG_SZ', value: args[7] });
      return { status: 0, stdout: '' };
    }
    if (operation === 'DELETE') {
      const existed = values.delete(valueKey);
      return { status: existed ? 0 : 1, stdout: '' };
    }
    if (operation === 'QUERY') {
      const entry = values.get(valueKey);
      return entry
        ? { status: 0, stdout: `    ${name}    ${entry.type}    ${entry.value}\r\n` }
        : { status: 1, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const executablePath = 'C:\\Program Files\\LocKeep\\LocKeepPasswordManager.exe';
  const registry = createWindowsRunRegistry({ runRegistry });

  assert.strictEqual(registry.setEnabled('LocKeepPasswordManager', executablePath, true), true);
  assert.strictEqual(registry.getEnabled('LocKeepPasswordManager', executablePath), true);
  assert.strictEqual(formatExecutableCommand(executablePath), `"${executablePath}"`);
  assert.ok(calls.some(args => args[0] === 'ADD' && args[7] === `"${executablePath}"`));
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
