'use strict';

// ─── Popup i18n (Unicode Escaped) ───────────────────────────────────────────
const POPUP_STRINGS = {
  en: {
    connected: '\u2705 Connected & Unlocked',
    disconnected: '\u274C App Not Connected',
    locked: '\uD83D\uDD12 Vault is Locked',
    checking: 'Checking status\u2026',
    tagline: 'Strictly offline password manager',
    unlockMsg: 'Please unlock your vault from the LocKeep desktop app to use auto-fill and password generation features.'
  },
  de: {
    connected: '\u2705 Verbunden & Entsperrt',
    disconnected: '\u274C App Nicht Verbunden',
    locked: '\uD83D\uDD12 Tresor ist Gesperrt',
    checking: 'Status wird gepr\u00fcft\u2026',
    tagline: 'Strikt offline Passwort-Manager',
    unlockMsg: 'Bitte entsperren Sie Ihren Tresor in der LocKeep Desktop-App, um Auto-Fill und Passwortgenerierung zu nutzen.'
  },
  tr: {
    connected: '\u2705 Ba\u011fl\u0131 ve Kilit A\u00e7\u0131k',
    disconnected: '\u274C Masa\u00fcst\u00fc Uygulamas\u0131 Kapal\u0131',
    locked: '\uD83D\uDD12 Kasa Kilitli',
    checking: 'Durum kontrol ediliyor\u2026',
    tagline: 'Tamamen \u00e7evrimd\u0131\u015f\u0131 \u015fifre y\u00f6neticisi',
    unlockMsg: 'Otomatik doldurma ve \u015fifre olu\u015fturma \u00f6zelliklerini kullanmak i\u00e7in l\u00fctfen masa\u00fcst\u00fc uygulamas\u0131ndan kasan\u0131z\u0131n kilidini a\u00e7\u0131n.'
  }
};

let lang = 'en';

const statusEl = document.getElementById('status');
const taglineEl = document.getElementById('tagline');
const actionBoxEl = document.getElementById('actionBox');

(async function () {
  try {
    const langResp = await chrome.runtime.sendMessage({ type: 'GET_LANGUAGE' });
    if (langResp && langResp.language && POPUP_STRINGS[langResp.language]) {
      lang = langResp.language;
    }
  } catch { /* default en */ }

  const s = POPUP_STRINGS[lang];
  statusEl.textContent = s.checking;
  taglineEl.textContent = s.tagline;

  // Step 1: Check if the desktop application is running
  chrome.runtime.sendMessage({ type: 'PING' }, (pingResponse) => {
    if (chrome.runtime.lastError || !pingResponse || !pingResponse.success) {
      statusEl.textContent = s.disconnected;
      statusEl.className = 'status disconnected';
    } else {
      // Step 2: Check if the vault is locked
      chrome.runtime.sendMessage({ type: 'SEARCH_DOMAIN', domain: 'test.com' }, (searchResponse) => {
        if (searchResponse && searchResponse.error === 'Vault is locked.') {
          statusEl.textContent = s.locked;
          statusEl.className = 'status locked';
          actionBoxEl.textContent = s.unlockMsg;
          actionBoxEl.className = 'action-box visible';
        } else {
          statusEl.textContent = s.connected;
          statusEl.className = 'status connected';
        }
      });
    }
  });
})();