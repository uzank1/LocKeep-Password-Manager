(() => {
  'use strict';
  const config = window.LAB_CONFIG;
  let owner = window;
  try { if (parent !== window && parent.location.origin === location.origin) owner = parent; } catch { /* Separate origin: own fixture memory. */ }
  owner.__lockeepLabSessions ||= new Map();
  const sessions = owner.__lockeepLabSessions;
  const remembered = window.labMemory?.read(config.session);
  if (remembered) sessions.set(config.session, JSON.parse(JSON.stringify(remembered)));
  if (!sessions.has(config.session)) {
    sessions.set(config.session, { profile: config.profile, logs: [], saved: [],
      lastUsername: null, flow: null, pending: config.scenario.id === 'pending-save' ? {
        username: 'new.demo@example.test', password: 'Demo-Pending!2026', url: location.origin,
        domain: location.hostname, baseDomain: location.hostname.split('.').slice(-2).join('.')
      } : null, generationCount: 0, detailCount: 0, generatedPassword: '' });
  }
  const state = sessions.get(config.session);
  let listeners = [];
  const baseDomain = hostname => hostname.split('.').slice(-2).join('.');
  const sampleEntries = () => {
    let entries = [
      { id: 'lab-one', username: 'demo.one@example.test', title: 'Örnek kişisel hesap', url: location.origin },
      { id: 'lab-two', username: 'demo.two@example.test', title: 'Örnek iş hesabı', url: location.origin }
    ];
    if (['identity-captcha', 'masked-identity'].includes(config.scenario.id)) {
      entries = entries.map((entry, index) => ({ ...entry, username: index ? '00000000002' : '00000000001' }));
    }
    if (config.scenario.id === 'many-accounts') entries = Array.from({ length: 12 }, (_, index) => ({
      id: `lab-${index}`, username: `very.long.demo.account.number.${index}@example.test`,
      title: 'Uzun hesap açıklaması — farklı bölümler için örnek bir hesap '.repeat(3), url: location.origin
    }));
    if (config.scenario.id === 'duplicate-accounts') entries = [entries[0], entries[0], entries[1], entries[1]];
    if (config.scenario.id === 'special-account') entries[0].title = '<img src=x onerror="window.labInjected=true"> & Özel başlık';
    return entries;
  };
  async function dispatch(message) {
    let result = { success: true };
    const failure = state.profile === 'locked' ? 'VAULT: Operation requires an unlocked vault.' :
      state.profile === 'offline' ? 'Electron app is not running. Cannot read IPC port.' : null;
    if ((['SEARCH_DOMAIN', 'GET_CREDENTIAL', 'GENERATE_PASSWORD', 'ADD_ENTRY'].includes(message.type) ||
        message.type === 'PING' && state.profile === 'offline') && failure) {
      result = { success: false, error: failure };
    } else switch (message.type) {
      case 'GET_LANGUAGE': result.language = config.language; break;
      case 'SEARCH_DOMAIN':
        if (state.profile === 'slow') await new Promise(resolve => setTimeout(resolve, 900));
        result.data = { entries: state.profile === 'empty' ? [] : sampleEntries() }; break;
      case 'GET_CREDENTIAL': state.detailCount++; result.data = { entry: { password: 'Demo-Autofill!2026' } }; break;
      case 'GENERATE_PASSWORD':
        state.generationCount++; state.generatedPassword = `Demo-Generated!2026-${state.generationCount}`;
        result.data = { password: state.generatedPassword }; break;
      case 'GET_PENDING_SAVE': result.data = state.pending; break;
      case 'SET_PENDING_SAVE': state.pending = { ...message.entry }; break;
      case 'CLEAR_PENDING_SAVE': state.pending = null; state.lastUsername = null; break;
      case 'SET_LAST_USERNAME': state.lastUsername = { username: message.username, domain: baseDomain(location.hostname), time: Date.now() }; break;
      case 'GET_LAST_USERNAME': result = state.lastUsername ? { success: true, ...state.lastUsername } : { success: false, error: 'Expired or not set' }; break;
      case 'CLEAR_LAST_USERNAME': state.lastUsername = null; state.flow = null; break;
      case 'SET_AUTH_FLOW_MODE': state.flow = { mode: message.mode, domain: baseDomain(location.hostname), time: Date.now() }; break;
      case 'GET_AUTH_FLOW_MODE': result = state.flow ? { success: true, ...state.flow } : { success: false, error: 'Expired or not set' }; break;
      case 'ADD_ENTRY': state.saved.push({ ...message.entry }); state.pending = null; state.lastUsername = null; state.flow = null; break;
      case 'PING': break;
      default: result = { success: false, error: 'Unsupported simulation command' };
    }
    state.logs.push({ at: new Date().toISOString(), type: message.type, success: result.success });
    if (state.logs.length > 150) state.logs.shift();
    window.labMemory?.write(config.session, state);
    return result;
  }
  const runtime = {
    id: 'lockeep-local-lab', getURL: resource => location.origin + '/extension/' + resource,
    getManifest: () => ({ version: config.extensionVersion }),
    onMessage: { addListener: listener => listeners.push(listener) },
    sendMessage(message, callback) {
      const promise = dispatch(message);
      if (callback) { promise.then(callback); return; }
      return promise;
    }
  };
  window.chrome = { runtime, i18n: { getUILanguage: () => config.language },
    // The fake API returns only this fixture's root, using the public Chromium
    // API contract. Real API availability is checked with the installed extension.
    dom: { openOrClosedShadowRoot: element => element.shadowRoot || (window.labFixtureRoot?.host === element ? window.labFixtureRoot : null) },
    storage: { local: { remove: async () => {}, get: async () => ({ language: config.language }) } } };
  const visible = element => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return !element.hidden && !element.disabled && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const covered = element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !hit || !(hit === element || element.contains(hit));
  };
  function audit() {
    const checks = [];
    const check = (label, pass, detail = '') => checks.push({ label, pass, detail });
    const scope = window.labFixtureRoot || document;
    const passwords = [...scope.querySelectorAll('[data-lab="password"], [data-lab="confirm"]')].filter(visible);
    const username = [...scope.querySelectorAll('[data-lab="username"]')].find(visible);
    const icons = [...document.querySelectorAll('.lockeep-generate-icon')].filter(visible);
    const dropdown = document.querySelector('.lockeep-dropdown');
    const profileHasAccounts = ['available', 'slow'].includes(state.profile);
    const kind = config.scenario.kind;
    const coveredByFixture = Boolean(document.querySelector('.contact-overlay')) || Boolean(document.querySelector('#cover-popover:popover-open'));
    if (['iframe-same', 'iframe-cross', 'shadow-open', 'shadow-closed', 'custom-editable'].includes(config.scenario.id)) {
      check('Özel bağlamdaki form destekleniyor', config.scenario.id.startsWith('iframe-') ? Boolean(passwords[0]?._lockeepAutofillListener) : config.scenario.id === 'custom-editable' ? Boolean(username?._lockeepAutofillListener) : icons.length > 0 || Boolean(dropdown),
        'Bileşen/çerçeve erişimi ve gerçek alan etkileşimi ölçülür; bulunamayan alan başarılı sayılmaz.');
    } else if (['signup', 'change', 'mixed'].includes(kind) && passwords.length && !coveredByFixture &&
        !(config.scenario.id === 'scroll-panel' && document.querySelector('.scroll-panel').scrollTop > 0)) {
      check('Parola oluşturma düğmesi var', icons.length === 1, `${icons.length} görünür düğme`);
      if (icons[0]) {
        check('Düğme tıklanabilir', !covered(icons[0]));
        const rect = icons[0].getBoundingClientRect();
        check('Düğme ekran içinde', rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight);
        const target = passwords.find(field => field.getAttribute('autocomplete')?.includes('new-password')) || passwords[0];
        const fieldRect = target.getBoundingClientRect();
        check('Düğme doğru alanın hizasında', Math.abs(rect.top + rect.height / 2 - fieldRect.top - fieldRect.height / 2) < 10);
      }
    } else if (kind === 'login' && profileHasAccounts && passwords.length) {
      check('Parola alanına hesap listesi bağlı', Boolean(passwords[0]._lockeepAutofillListener));
      if (username) check('Kullanıcı adı alanına hesap listesi bağlı', Boolean(username._lockeepAutofillListener));
    }
    if (kind === 'login') check('Giriş formunda oluşturma düğmesi yok', icons.length === 0);
    if (dropdown) {
      const rect = dropdown.getBoundingClientRect();
      check('Hesap listesi tıklanabilir', !covered(dropdown));
      check('Hesap listesi ekran içinde', rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight);
      if (config.scenario.id === 'duplicate-accounts') check('Tekrarlanan hesaplar ayıklandı', dropdown.children.length === 2);
      if (config.scenario.id === 'special-account') check('Hesap başlığı kod olarak çalışmadı', !window.labInjected && !dropdown.querySelector('img'));
    }
    const savePrompt = document.querySelector('.lockeep-save-prompt');
    if (savePrompt) {
      const rect = savePrompt.getBoundingClientRect();
      check('Kayıt önerisi ekran içinde', rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight);
      check('Kayıt önerisi tıklanabilir', !covered(savePrompt));
    }
    if (state.generationCount && passwords.length) {
      const generatedFields = kind === 'mixed' ? passwords.filter(field => field.form?.id === 'signup-form') : passwords;
      check('Yeni parola alanları aynı değerle doldu', generatedFields.every(field => field.value === state.generatedPassword));
      const old = document.querySelector('[data-lab="old"]');
      if (old) check('Mevcut parola korundu', old.value === 'Demo-Old-Password!23');
      if (kind === 'mixed') check('Diğer formun parolası korunuyor', document.querySelector('#login-form [data-lab="password"]').value !== state.generatedPassword);
      check('Site oluşturulan değeri algıladı', Boolean(window.labFixtureEvents.password?.input && window.labFixtureEvents.password?.change));
    }
    if (state.detailCount && kind === 'login') {
      check('Seçilen hesabın parolası doldu', Boolean(passwords[0] && passwords[0].value === 'Demo-Autofill!2026'));
      if (username) check('Seçilen hesabın kullanıcı adı doğru alana doldu', (username.isContentEditable ? username.textContent : username.value) === sampleEntries()[0].username);
      const protectedFields = [...document.querySelectorAll('[data-lab="coupon"], [data-lab="otp"], [data-lab="trap"]')];
      check('İlgisiz ve gizli alanlar korunuyor', protectedFields.every(field => !field.value));
      const captcha = document.querySelector('[data-lab="captcha"]');
      if (captcha) check('Güvenlik kodu doldurma dışında kaldı', captcha.value === 'ABCD');
      check('Site doldurmayı algıladı', Boolean(window.labFixtureEvents.password?.input && window.labFixtureEvents.password?.change));
    }
    if (config.scenario.id === 'removed-field') check('Sahipsiz oluşturma düğmesi yok', !document.querySelector('.lockeep-generate-icon'));
    if (config.scenario.id === 'passkey-annotation') check('Geçiş anahtarı işareti kaldırıldı', !document.querySelector('[data-lab="username"]').autocomplete.includes('webauthn'));
    if (config.scenario.id === 'synthetic-events') check('Sahte olay parola istemedi', state.detailCount === 0);
    if (config.scenario.id === 'overlay' && document.querySelector('.contact-overlay')) {
      check('Örtülü formun düğmesi üstte görünmüyor', icons.length === 0 || icons.every(covered));
    }
    if (config.scenario.id === 'popover' && document.querySelector('#cover-popover:popover-open')) {
      check('Örtülü formun düğmesi menünün üstüne çıkmıyor', icons.length === 0 || icons.every(covered));
    }
    if (config.scenario.id === 'scroll-panel' && document.querySelector('.scroll-panel').scrollTop > 0) {
      const panel = document.querySelector('.scroll-panel').getBoundingClientRect();
      check('Panel dışında kalan düğme gizleniyor', icons.every(icon => { const rect = icon.getBoundingClientRect(); return rect.top >= panel.top && rect.bottom <= panel.bottom; }));
    }
    if (config.scenario.id === 'invalid-form' && !document.querySelector('form').checkValidity()) check('Geçersiz gönderim kayıt önerisi açmadı', !document.querySelector('.lockeep-save-prompt'));
    if (config.scenario.id === 'rejected-login' && document.querySelector('.site-result')) check('Reddedilen giriş kayıt önerisi açmadı', !document.querySelector('.lockeep-save-prompt'));
    if (!checks.length) check('Bu adım için kullanıcı etkileşimi gerekiyor', null);
    return { scenario: config.scenario.id, language: config.language, profile: state.profile, checks,
      observed: { icons: icons.length, accountRows: dropdown?.children.length || 0,
        generated: state.generationCount, credentialRequests: state.detailCount, saved: state.saved.length,
        savePrompt: Boolean(document.querySelector('.lockeep-save-prompt')) },
      events: { ...window.labFixtureEvents }, commands: state.logs.map(log => ({ ...log })) };
  }
  function requestDiagnostics() {
    const listener = listeners[0];
    if (!listener) return Promise.resolve({ success: false });
    return new Promise(resolve => {
      const accepted = listener({ type: 'GET_AUTOFILL_DIAGNOSTICS' },
        { id: runtime.id, url: runtime.getURL('popup/popup.html') }, resolve);
      if (!accepted) resolve({ success: false });
    });
  }
  window.LocKeepLab = { audit, dispatch, runtime, requestDiagnostics, pageURL: () => location.href,
    setProfile: profile => { if (['available', 'empty', 'locked', 'offline', 'slow'].includes(profile)) state.profile = profile; },
    getCounts: () => ({ generated: state.generationCount, details: state.detailCount, saved: state.saved.length, pending: Boolean(state.pending) }) };
})();
