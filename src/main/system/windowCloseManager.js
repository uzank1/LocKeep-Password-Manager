'use strict';

const translations = {
  en: require('../../renderer/js/i18n/en.json').settings,
  de: require('../../renderer/js/i18n/de.json').settings,
  tr: require('../../renderer/js/i18n/tr.json').settings
};

function createWindowCloseManager({ app, autoUpdater, Tray, Menu, loadSettings, iconPath, logger = console }) {
  let window = null;
  let tray = null;
  let quitting = false;

  function destroyTray() {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  }

  function restoreWindow() {
    if (quitting || !window || window.isDestroyed()) return;
    window.setSkipTaskbar(false);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    destroyTray();
  }

  function beginQuit() {
    quitting = true;
  }

  function ensureTray() {
    if (tray && !tray.isDestroyed()) return;
    const labels = translations[loadSettings().language] || translations.en;
    tray = new Tray(iconPath);
    tray.setToolTip('LocKeep');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: labels.trayOpen, click: restoreWindow },
      { type: 'separator' },
      { label: labels.trayQuit, click: () => { beginQuit(); app.quit(); } }
    ]));
    tray.on('click', restoreWindow);
  }

  function attachWindow(nextWindow) {
    window = nextWindow;
    nextWindow.on('close', event => {
      if (quitting || loadSettings().closeAction !== 'tray') return;
      try {
        // Keep the close action available if Windows cannot create a tray icon.
        ensureTray();
      } catch (error) {
        destroyTray();
        logger.warn('[Window] Could not minimize to the system tray:', error.message);
        return;
      }
      event.preventDefault();
      nextWindow.setSkipTaskbar(true);
      nextWindow.hide();
    });
    nextWindow.on('closed', () => {
      if (window === nextWindow) {
        window = null;
        destroyTray();
      }
    });
    // Windows session shutdown must not be intercepted by close-to-tray.
    nextWindow.on('query-session-end', beginQuit);
  }

  app.on('before-quit', beginQuit);
  // electron-updater emits this before closing windows during installation.
  autoUpdater.on('before-quit-for-update', beginQuit);
  app.on('will-quit', destroyTray);

  return { attachWindow, restoreWindow };
}

module.exports = { createWindowCloseManager };
