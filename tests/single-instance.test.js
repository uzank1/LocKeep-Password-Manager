'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { wrap } = require('node:module');

const mainFile = path.join(__dirname, '../src/main/main.js');
const source = fs.readFileSync(mainFile, 'utf8');

// Run the actual CommonJS entry point with isolated dependencies. Discovery
// state represents only sample port/token files; no Electron app or vault opens.
function bootMain(hasLock, discovery = {}) {
  const app = new EventEmitter();
  const calls = { quits: 0, starts: 0, stops: 0, registry: 0, restores: 0, windows: 0, settings: 0 };
  const required = [];
  const ready = [];
  Object.assign(app, {
    isPackaged: true,
    requestSingleInstanceLock: () => hasLock,
    quit: () => { calls.quits++; },
    whenReady: () => ({ then: callback => { ready.push(callback); } }),
    getPath: () => 'test-app-data',
    getAppPath: () => 'test-app',
    disableHardwareAcceleration() {}
  });
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); calls.windows++;
      this.webContents = { on() {}, setWindowOpenHandler() {}, openDevTools() {} };
    }
    static getAllWindows() { return []; }
    setMenuBarVisibility() {}
    loadFile() {}
    show() {}
  }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { on() {} }, session: { defaultSession: {
    webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }
  } } };
  const noop = () => {};
  const modules = {
    electron, path,
    './ipc/handlers': { registerAllHandlers: noop },
    './security/autoLock': { initialize: noop, dispose: noop },
    './security/clipboardGuard': { dispose: noop, clearNow: noop },
    './vault/vaultManager': {
      initializeFromSettings: () => { calls.settings++; },
      loadSettings: () => ({ startWithWindows: false }),
      lockVault: noop
    },
    './system/startupManager': {},
    './system/updateManager': { initialize: noop, dispose: noop },
    './system/updateInstallGuard': { release: noop },
    './system/windowCloseManager': { createWindowCloseManager: () => ({
      attachWindow: noop, restoreWindow: () => { calls.restores++; }
    }) },
    './nativeMessaging/registrySetup': { install: () => { calls.registry++; } },
    './nativeMessaging/nativeHost': {
      startServer: () => {
        calls.starts++;
        discovery.port = hasLock ? 'primary-port' : 'secondary-port';
        discovery.token = hasLock ? 'sample-primary-token' : 'sample-secondary-token';
        return Promise.resolve();
      },
      stopServer: () => { calls.stops++; delete discovery.port; delete discovery.token; }
    }
  };
  const module = { exports: {} };
  const requireStub = name => {
    required.push(name);
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  };
  vm.runInNewContext(wrap(source), {
    console: { log: noop, warn: noop, error: noop },
    process: { platform: 'win32', resourcesPath: 'test-resources', argv: [] }
  }, { filename: mainFile })(module.exports, requireStub, module, mainFile, path.dirname(mainFile));
  return { app, calls, required, ready: async () => { for (const callback of ready) await callback(); } };
}

test('A second instance exits before importing desktop services or scheduling startup', async () => {
  const secondary = bootMain(false);
  await secondary.ready();
  assert.equal(secondary.calls.quits, 1);
  assert.deepEqual(secondary.required, ['electron']);
  assert.equal(secondary.app.listenerCount('before-quit'), 0);
  assert.equal(secondary.calls.starts, 0);
  assert.equal(secondary.calls.registry, 0);
  assert.equal(secondary.calls.windows, 0);
});

test('Secondary ready/quit ordering cannot replace or remove the running IPC discovery files', async () => {
  for (const quitFirst of [false, true]) {
    const discovery = {};
    const primary = bootMain(true, discovery);
    await primary.ready();
    const original = { ...discovery };
    const secondary = bootMain(false, discovery);
    if (quitFirst) secondary.app.emit('before-quit');
    await secondary.ready();
    if (!quitFirst) secondary.app.emit('before-quit');
    assert.deepEqual(discovery, original);
    assert.equal(secondary.calls.settings, 0);
    assert.equal(secondary.calls.starts, 0);
    assert.equal(secondary.calls.stops, 0);
    primary.app.emit('second-instance');
    assert.equal(primary.calls.restores, 1);
  }
});

test('The owning instance starts the bridge, restores its window and performs its normal quit cleanup', async () => {
  const discovery = {};
  const primary = bootMain(true, discovery);
  await primary.ready();
  assert.equal(primary.calls.registry, 1);
  assert.equal(primary.calls.starts, 1);
  assert.equal(primary.calls.windows, 1);
  assert.equal(primary.calls.settings, 1);
  assert.equal(discovery.port, 'primary-port');
  primary.app.emit('second-instance');
  assert.equal(primary.calls.restores, 1);
  primary.app.emit('before-quit');
  assert.equal(primary.calls.stops, 1);
  assert.deepEqual(discovery, {});
});
