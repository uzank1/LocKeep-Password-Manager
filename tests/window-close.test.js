'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createWindowCloseManager } = require('../src/main/system/windowCloseManager');

function harness(initialSettings = {}, failTray = false) {
  const app = new EventEmitter();
  const autoUpdater = new EventEmitter();
  const settings = { ...initialSettings };
  const trays = [];
  const win = new EventEmitter();
  Object.assign(win, {
    visible: true, destroyed: false, skipped: false, minimized: false,
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    restore: () => { win.minimized = false; },
    show: () => { win.visible = true; },
    hide: () => { win.visible = false; },
    focus: () => { win.focused = true; },
    setSkipTaskbar: value => { win.skipped = value; },
    close: () => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      win.emit('close', event);
      if (!event.prevented) {
        win.destroyed = true;
        win.visible = false;
        win.emit('closed');
      }
    }
  });
  app.quit = () => {
    app.emit('before-quit');
    win.close();
    if (win.destroyed) app.emit('will-quit');
  };
  class TestTray extends EventEmitter {
    constructor() {
      super();
      if (failTray) throw new Error('No tray available');
      this.destroyed = false;
      trays.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
  }
  const manager = createWindowCloseManager({
    app, autoUpdater, Tray: TestTray,
    Menu: { buildFromTemplate: value => value },
    loadSettings: () => ({ ...settings }), iconPath: 'test.ico', logger: { warn() {} }
  });
  manager.attachWindow(win);
  return { app, autoUpdater, win, trays, settings, manager };
}

test('Existing users and invalid preferences keep the normal close behavior', () => {
  for (const settings of [{}, { closeAction: 'quit' }, { closeAction: 'invalid' }]) {
    const h = harness(settings);
    h.win.close();
    assert.equal(h.win.destroyed, true);
    assert.equal(h.trays.length, 0);
  }
});

test('Close-to-tray hides the window and taskbar entry without destroying the window', () => {
  const h = harness({ closeAction: 'tray' });
  h.win.close();
  h.win.close();
  assert.equal(h.win.visible, false);
  assert.equal(h.win.skipped, true);
  assert.equal(h.win.destroyed, false);
  assert.equal(h.trays.length, 1);
  assert.equal(h.trays[0].destroyed, false);
});

test('Clicking the tray icon restores and focuses the same minimized window', () => {
  const h = harness({ closeAction: 'tray' });
  h.win.minimized = true;
  h.win.close();
  h.trays[0].emit('click');
  assert.equal(h.win.minimized, false);
  assert.equal(h.win.visible, true);
  assert.equal(h.win.skipped, false);
  assert.equal(h.win.focused, true);
  assert.equal(h.win.destroyed, false);
  assert.equal(h.trays[0].destroyed, true);
});

test('Opening a second instance restores a hidden window', () => {
  const h = harness({ closeAction: 'tray' });
  h.win.close();
  h.manager.restoreWindow();
  assert.equal(h.win.visible, true);
  assert.equal(h.win.skipped, false);
  assert.equal(h.trays[0].destroyed, true);
});

test('Changing the setting takes effect on the next close', () => {
  const h = harness({ closeAction: 'quit' });
  h.settings.closeAction = 'tray';
  h.win.close();
  h.trays[0].menu[0].click();
  assert.equal(h.win.visible, true);
  h.settings.closeAction = 'quit';
  h.win.close();
  assert.equal(h.win.destroyed, true);
});

test('Tray menus use the saved language and allow an explicit exit', () => {
  for (const language of ['en', 'de', 'tr']) {
    const h = harness({ closeAction: 'tray', language });
    const labels = require(`../src/renderer/js/i18n/${language}.json`).settings;
    h.win.close();
    assert.equal(h.trays[0].menu[0].label, labels.trayOpen);
    assert.equal(h.trays[0].menu[2].label, labels.trayQuit);
    h.trays[0].menu[2].click();
    assert.equal(h.win.destroyed, true);
    assert.equal(h.trays[0].destroyed, true);
  }
});

test('Application quit, update installation and Windows shutdown bypass close-to-tray', () => {
  for (const trigger of ['quit', 'update', 'shutdown']) {
    const h = harness({ closeAction: 'tray' });
    h.win.close();
    if (trigger === 'quit') h.app.quit();
    if (trigger === 'update') {
      h.autoUpdater.emit('before-quit-for-update');
      h.win.close();
    }
    if (trigger === 'shutdown') {
      h.win.emit('query-session-end');
      h.win.close();
    }
    assert.equal(h.win.destroyed, true, trigger);
    assert.equal(h.trays[0].destroyed, true, trigger);
  }
});

test('A tray creation failure never leaves an inaccessible hidden application', () => {
  const h = harness({ closeAction: 'tray' }, true);
  h.win.close();
  assert.equal(h.win.destroyed, true);
  assert.equal(h.win.skipped, false);
});
