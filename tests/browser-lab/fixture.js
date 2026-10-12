(() => {
  'use strict';
  const config = window.LAB_CONFIG;
  const scenario = config.scenario;
  const root = document.getElementById('fixture');
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const attributes = values => Object.entries(values).map(([key, value]) => `${key}="${escape(value)}"`).join(' ');
  let serial = 0;
  const input = (label, role, attrs = {}) => {
    const id = attrs.id || `control-${++serial}`;
    return `<div class="field"><label for="${id}">${escape(label)}</label><input ${attributes({ id, type: 'text', 'data-lab': role, ...attrs })}></div>`;
  };
  const username = (attrs = {}) => input('E-posta veya kullanıcı adı', 'username', { type: 'email', name: 'username', autocomplete: 'username', ...attrs });
  const password = (attrs = {}) => input('Parola', 'password', { type: 'password', name: 'password', autocomplete: 'current-password', ...attrs });
  const newPassword = (attrs = {}) => password({ name: 'new-password', autocomplete: 'new-password', ...attrs });
  const confirm = (attrs = {}) => input('Parolayı tekrar yazın', 'confirm', { type: 'password', name: 'confirm-password', autocomplete: 'new-password', ...attrs });
  const unboundPassword = (label, role, name, value = '') => `<div class="field"><div class="input-wrapper"><input type="text" name="${name}" data-lab="${role}" value="${value}"></div><label>${label}</label><span dir="ltr">${label}</span></div>`;
  const signupArrow = (disabled = false) => `<button class="submit" data-action="signup-next" data-testid="btn-signup-submit" ${disabled ? 'disabled' : ''}><svg role="img" aria-label="forward" width="30" height="30" viewBox="0 0 32 32"><path d="M4 14h18l-8-8 2-2 12 12-12 12-2-2 8-8H4z"></path></svg></button>`;
  const submit = text => `<button class="submit" data-action="submit" type="submit">${text}</button>`;
  const form = (fields, signup = false, extra = '') => `<form id="${signup ? 'signup' : 'login'}-form" ${extra}>${fields}${submit(signup ? 'Kaydol' : 'Giriş yap')}</form>`;
  const login = () => form(username() + password());
  const signup = () => form(username() + newPassword() + confirm(), true);
  const action = (id, text) => `<button type="button" data-action="${id}" class="secondary">${text}</button>`;
  const heading = scenario.kind === 'login' ? 'Tekrar hoş geldin' : scenario.kind === 'change' ? 'Parolanı değiştir' : 'Yeni bir başlangıç';
  const foot = `<p class="demo-note">Örnek site · Gerçek hesap oluşturulmaz</p>`;
  const card = content => `<section class="auth-card"><div class="brand"><span class="brand-icon">N</span> Nimbus <span class="badge">TEST</span></div><h1>${heading}</h1><p class="subtitle">${escape(scenario.description)}</p>${content}${foot}</section>`;
  const controls = content => `<div class="case-controls">${content}</div>`;
  const baseSignup = ['signup', 'overlay', 'popover', 'dialog-signup', 'scroll-panel', 'transformed', 'responsive', 'rtl', 'hostile-css', 'removed-field', 'layout-shift', 'reveal-password', 'invalid-form', 'detach-on-submit'];
  let content = baseSignup.includes(scenario.id) ? signup() : login();
  switch (scenario.id) {
    case 'random-names': content = form(input('Üye numarası', 'username', { name: 'a81', type: 'text' }) + input('Gizli giriş kodu', 'password', { name: 'q17', type: 'password' })); break;
    case 'label-only': content = form(input('Kullanıcı adı', 'username', { name: 'a81' }) + input('Parola', 'password', { name: 'q17' }), true); break;
    case 'text-password': content = form(username() + newPassword({ type: 'text', name: 'q17', placeholder: 'Şifre', 'aria-label': 'Parola' }) + confirm({ type: 'text' }), true); break;
    case 'phone-login': content = form(input('Telefon numarası', 'username', { type: 'tel', name: 'memberRef', autocomplete: 'tel' }) + password()); break;
    case 'hidden-trap': content = form(input('Gizli e-posta', 'trap', { type: 'email', name: 'trackingEmail', style: 'display:none' }) + username({ type: 'text', name: 'memberRef' }) + password({ disabled: '', 'data-lab': 'trap', style: 'display:none' }) + password()); break;
    case 'distractors': content = form(input('Kupon', 'coupon', { name: 'discount', autocomplete: 'off' }) + input('Doğrulama kodu', 'otp', { name: 'code', autocomplete: 'one-time-code' }) + username({ type: 'text', name: 'memberRef' }) + password()); break;
    case 'formless': content = `<div class="formless">${username() + password()}<button type="button" class="submit" data-action="submit">Giriş yap</button></div>`; break;
    case 'external-form': content = username({ form: 'login-form' }) + password({ form: 'login-form' }) + form(''); break;
    case 'two-forms': content = `<div class="two-forms"><section><h2>Giriş</h2>${login()}</section><section><h2>Kayıt</h2>${signup()}</section></div>`; break;
    case 'change-password': content = form(password({ value: 'Demo-Old-Password!23', 'data-lab': 'old' }) + newPassword() + confirm(), true); break;
    case 'reset-password': content = form(newPassword(), true); break;
    case 'multistep-login': case 'multistep-signup': content = `<form id="${scenario.kind === 'signup' ? 'signup' : 'login'}-form">${username({ type: 'text', name: 'memberRef' })}${action('next', scenario.kind === 'signup' ? 'Kaydol ve devam et' : 'Devam et')}</form>`; break;
    case 'navigation-save': content = config.result ? '<div class="result-banner">Örnek işlem tamamlandı. Form artık bu sayfada bulunmuyor.</div>' : signup(); break;
    case 'late-form': content = '<div class="loading">Örnek form yükleniyor…</div>'; break;
    case 'custom-editable': content = form('<div class="field"><label>Üye adı</label><div contenteditable="true" role="textbox" data-lab="username" class="editable"></div></div>' + password()); break;
    case 'pending-save': content = '<div class="result-banner">Bir önceki sayfadan gelen kayıt önerisi için form bulunmayan sonuç sayfası.</div>'; break;
    case 'unbound-change-labels': content = `<div class="formless">${unboundPassword('CURRENT PASSWORD', 'old', 'q81', 'Demo-Old-Password!23')}${unboundPassword('NEW PASSWORD', 'password', 'q82')}${unboundPassword('CONFIRM NEW PASSWORD', 'confirm', 'q83')}<button class="submit" type="button" data-action="submit">SAVE CHANGES</button></div>`; break;
    case 'named-current-password': content = form(password({ name: 'current_password', autocomplete: 'off', 'data-lab': 'old', value: 'Demo-Old-Password!23' }) + password({ name: 'newPassword', autocomplete: 'off' }) + confirm({ name: 'confirmPassword', autocomplete: 'off' }), true); break;
    case 'icon-signup': content = `<div class="formless">${username({ type: 'text', name: 'riotUsername', autocomplete: 'off' })}${newPassword({ autocomplete: 'off' })}${confirm({ autocomplete: 'off' })}<button class="submit" data-action="submit" data-testid="btn-signup-submit"><svg role="img" aria-label="forward" viewBox="0 0 32 32" width="30" height="30"><path d="M4 14h18l-8-8 2-2 12 12-12 12-2-2 8-8H4z"></path></svg></button></div>`; break;
    case 'riot-five-step': content = `<div class="formless" id="registration-steps">${username({ type: 'text', name: 'email_address', 'data-lab': 'email', autocomplete: 'off' })}${signupArrow()}</div>`; break;
    case 'identity-captcha': case 'masked-identity':
      content = `<form id="loginForm"><input type="hidden" name="encTridField" data-lab="trap">${input('T.C. Kimlik No', 'username', { id: 'tridField', name: 'tridField', type: scenario.id === 'masked-identity' ? 'password' : 'number', autocomplete: 'off', inputmode: 'numeric', maxlength: '11', 'aria-label': 'T. C. Kimlik Numaranızı Girin' })}${action('mask-identity', 'Kimlik numarasını gizle / göster')}${input('e-Devlet Şifresi', 'password', { id: 'egpField', name: 'egpField', type: 'password', autocomplete: 'off', 'aria-label': 'e-Devlet Şifrenizi Girin' })}${input('Güvenlik Kodu', 'captcha', { id: 'captchaField', name: 'captchaField', maxlength: '5', value: 'ABCD' })}${submit('Giriş Yap')}</form>`; break;
    case 'captcha-without-username': content = form(password() + input('Güvenlik Kodu', 'captcha', { name: 'captchaField', value: 'ABCD' })); break;
  }
  root.innerHTML = card(content);
  document.body.dataset.theme = config.theme;
  const extraActions = {
    overlay: action('overlay', 'İletişim kutusunu aç') + action('overlay-edge', 'Alanın kenarını ört'), popover: action('popover', 'Menüyü aç'),
    'scroll-panel': action('scroll', 'Paneli aşağı kaydır') + action('scroll-back', 'Parola alanına dön'), 'replace-form': action('replace', 'Formu yeniden oluştur') + action('toggle-mode', 'Aynı alanlarla giriş / kayıt'),
    'reveal-password': action('reveal', 'Parolayı göster / gizle'), 'removed-field': action('remove', 'Formu kaldır'),
    'layout-shift': action('shift', 'Üste reklam alanı ekle'), 'passkey-annotation': action('restore-passkey', 'Geçiş anahtarı işaretini geri ekle'),
    'synthetic-events': action('synthetic', 'Sahte olay gönder')
  };
  if (extraActions[scenario.id]) root.insertAdjacentHTML('afterbegin', controls(extraActions[scenario.id]));
  if (scenario.id === 'distractors') root.insertAdjacentHTML('afterbegin', '<input type="search" aria-label="Sitede ara" placeholder="Sitede ara">');
  if (scenario.id === 'bottom-field') document.body.classList.add('bottom-field');
  if (scenario.id === 'responsive') document.body.classList.add('large-text');
  if (scenario.id === 'rtl') { document.documentElement.dir = 'rtl'; document.querySelector('h1').textContent = 'إنشاء حساب'; }
  if (scenario.id === 'hostile-css') document.head.insertAdjacentHTML('beforeend', '<style>div {line-height:3; letter-spacing:2px} button {font-size:28px;border-radius:0;padding:28px} div:not(.auth-card):not(.field):not(.brand):not(.brand-icon):not(.case-controls) {font-family:monospace} </style>');
  if (scenario.id === 'transformed') root.querySelector('.auth-card').style.transform = 'scale(.85) translate(20px, 16px)';
  if (scenario.id === 'passkey-annotation') document.querySelector('[data-lab="username"]').setAttribute('autocomplete', 'section-login username webauthn');
  if (scenario.id === 'scroll-panel') {
    const existing = root.querySelector('.auth-card');
    const panel = document.createElement('div'); panel.className = 'scroll-panel';
    existing.replaceWith(panel); panel.append(existing); existing.style.marginBottom = '420px';
  }
  if (scenario.id.startsWith('dialog-')) {
    const dialog = document.createElement('dialog'); dialog.className = 'native-dialog';
    dialog.append(root.querySelector('.auth-card')); root.append(dialog); dialog.showModal();
  }
  if (scenario.id === 'popover') {
    const menu = document.createElement('div'); menu.id = 'cover-popover'; menu.setAttribute('popover', 'manual');
    menu.innerHTML = '<h2>Site menüsü</h2><p>Bu menü alttaki formu örter.</p><button data-action="close-popover">Kapat</button>';
    document.body.append(menu);
  }
  if (['shadow-open', 'shadow-closed'].includes(scenario.id)) {
    const host = document.createElement('demo-auth');
    const shadow = host.attachShadow({ mode: scenario.id === 'shadow-open' ? 'open' : 'closed' });
    shadow.innerHTML = '<style>.field{margin:18px 0}label{display:block}input{padding:12px;width:220px}button{padding:10px}</style>' + signup();
    root.querySelector('form').replaceWith(host);
    // The fixture keeps its own closed root for test instrumentation only.
    // Production content scripts cannot access it through the host.
    window.labFixtureRoot = shadow;
  }
  if (['iframe-same', 'iframe-cross'].includes(scenario.id) && !config.child) {
    const frame = document.createElement('iframe'); frame.className = 'embedded-login'; frame.title = 'Gömülü giriş formu';
    const childURL = new URL(`/case/${scenario.id}`, location.href);
    if (scenario.id === 'iframe-cross') childURL.port = String(config.secondPort);
    childURL.searchParams.set('mode', !config.native && config.allFrames ? 'simulated' : 'native'); childURL.searchParams.set('child', '1');
    root.querySelector('form').replaceWith(frame); frame.src = childURL.href;
  }
  const events = {};
  const recordEvent = event => {
    const target = event.composedPath()[0];
    const role = target.dataset && target.dataset.lab;
    if (role) { events[role] ||= { input: 0, change: 0 }; events[role][event.type]++; }
  };
  for (const type of ['input', 'change']) {
    document.addEventListener(type, recordEvent, true);
    if (window.labFixtureRoot?.mode === 'closed') window.labFixtureRoot.addEventListener(type, recordEvent, true);
  }
  window.labFixtureEvents = events;
  let signupStep = 0;
  const signupFrameworkState = { password: '', confirm: '' };
  document.addEventListener('input', event => {
    if (scenario.id !== 'riot-five-step' || signupStep !== 3 || !event.isTrusted || !(event instanceof InputEvent)) return;
    if (!['insertText', 'deleteContentBackward', 'insertFromPaste'].includes(event.inputType)) return;
    const role = event.target.dataset.lab;
    if (role === 'password' || role === 'confirm') signupFrameworkState[role] = event.target.value;
    root.querySelector('[data-action="signup-next"]').disabled = signupFrameworkState.password.length < 12 || signupFrameworkState.password !== signupFrameworkState.confirm;
  });
  document.addEventListener('change', event => {
    if (scenario.id === 'riot-five-step' && signupStep === 4 && event.target.dataset.lab === 'terms') {
      root.querySelector('[data-action="signup-next"]').disabled = !event.target.checked;
    }
  });
  function setResult(message, good = true) {
    let result = root.querySelector('.site-result');
    if (!result) { result = document.createElement('div'); result.className = 'site-result'; root.append(result); }
    result.textContent = message; result.dataset.good = String(good);
    result.setAttribute('role', good ? 'status' : 'alert');
  }
  const onSubmit = event => {
    event.preventDefault();
    if (scenario.id === 'rejected-login') setResult('Örnek site girişi reddetti. Bilgiler hatalı.', false);
    else if (scenario.id === 'navigation-save') {
      const target = new URL(location.href); target.searchParams.set('result', '1');
      // Allow the extension's asynchronous pending-save message to settle.
      setTimeout(() => location.assign(target.href), 100);
    } else setResult('Örnek işlem tamamlandı. Gerçek bir sunucuya bilgi gönderilmedi.');
  };
  document.addEventListener('submit', onSubmit);
  if (window.labFixtureRoot) window.labFixtureRoot.addEventListener('submit', onSubmit);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    switch (button.dataset.action) {
      case 'signup-next': {
        if (button.disabled) break;
        const panel = root.querySelector('#registration-steps');
        signupStep++;
        if (signupStep === 1) panel.innerHTML = input('Doğum yılı', 'birth', { name: 'birth_year', autocomplete: 'bday-year' }) + signupArrow();
        if (signupStep === 2) panel.innerHTML = username({ type: 'text', name: 'username', autocomplete: 'off' }) + signupArrow();
        if (signupStep === 3) panel.innerHTML = password({ autocomplete: 'off' }) + confirm({ autocomplete: 'off' }) + signupArrow(true);
        if (signupStep === 4) panel.innerHTML = '<div class="field"><label><input type="checkbox" required data-lab="terms"> Örnek hizmet şartlarını kabul ediyorum</label></div><button type="button" class="submit" data-action="signup-next" data-testid="btn-accept-tos" disabled>KABUL ET</button>';
        if (signupStep === 5) { panel.innerHTML = '<div class="result-banner">Örnek hesap oluşturuldu.</div>'; setResult('Örnek kayıt tamamlandı.'); }
        break;
      }
      case 'next': {
        const formElement = button.closest('form');
        formElement.innerHTML = password({ name: 'q17', autocomplete: scenario.kind === 'signup' ? 'off' : 'current-password' }) + submit(scenario.kind === 'signup' ? 'Kaydol' : 'Giriş yap');
        formElement.id = 'step-panel';
        document.title = 'Nimbus · Devam et';
        history.replaceState(null, '', location.pathname + location.search + '#parola-adimi'); break;
      }
      case 'replace': root.querySelector('.auth-card').innerHTML = login(); break;
      case 'toggle-mode': {
        const formElement = root.querySelector('form');
        const field = formElement.querySelector('[data-lab="password"]');
        const registering = field.autocomplete !== 'new-password';
        field.autocomplete = registering ? 'new-password' : 'current-password';
        formElement.id = registering ? 'signup-form' : 'login-form';
        const submitButton = formElement.querySelector('[data-action="submit"]');
        submitButton.textContent = registering ? 'Kaydol' : 'Giriş yap';
        if (registering) submitButton.insertAdjacentHTML('beforebegin', confirm());
        else formElement.querySelector('[data-lab="confirm"]')?.closest('.field').remove();
        break;
      }
      case 'reveal': { const element = document.querySelector('[data-lab="password"]'); element.type = element.type === 'password' ? 'text' : 'password'; break; }
      case 'mask-identity': { const element = document.querySelector('[data-lab="username"]'); element.type = element.type === 'password' ? 'number' : 'password'; break; }
      case 'remove': root.querySelector('form').remove(); break;
      case 'shift': { const block = document.createElement('div'); block.className = 'advertisement'; block.textContent = 'Geç yüklenen örnek alan'; root.querySelector('.auth-card').before(block); break; }
      case 'scroll': document.querySelector('.scroll-panel').scrollTop = 700; break;
      case 'scroll-back': {
        const panel = document.querySelector('.scroll-panel');
        panel.scrollTop += document.querySelector('[data-lab="password"]').getBoundingClientRect().top - panel.getBoundingClientRect().top - 50;
        break;
      }
      case 'restore-passkey': document.querySelector('[data-lab="username"]').setAttribute('autocomplete', 'username webauthn'); break;
      case 'synthetic': {
        const field = document.querySelector('[data-lab="password"]'); field.focus();
        field.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.querySelector('.lockeep-dropdown-item')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); break;
      }
      case 'overlay': {
        const layer = document.createElement('section'); layer.className = 'contact-overlay';
        const formRect = document.querySelector('form').getBoundingClientRect();
        layer.style.top = `${formRect.top - 12}px`; layer.style.left = `${Math.max(0, formRect.left - 36)}px`;
        layer.style.width = `${formRect.width + 76}px`; layer.style.height = `${formRect.height + 24}px`;
        layer.innerHTML = '<h2>Nasıl yardımcı olabiliriz?</h2><p>Bu iletişim kutusu alttaki alanların üstünü örter.</p><button data-action="close-overlay">Kapat</button>';
        document.body.append(layer); break;
      }
      case 'overlay-edge': {
        const layer = document.createElement('section'); layer.className = 'contact-overlay';
        const rect = document.querySelector('[data-lab="password"]').getBoundingClientRect();
        layer.style.cssText = `top:${rect.top - 25}px;left:${rect.right - 4}px;width:140px;height:130px;padding:15px`;
        layer.innerHTML = '<p>Örnek yan panel</p><button data-action="close-overlay">Kapat</button>';
        document.body.append(layer); break;
      }
      case 'close-overlay': button.closest('.contact-overlay').remove(); break;
      case 'popover': document.getElementById('cover-popover').showPopover(); break;
      case 'close-popover': document.getElementById('cover-popover').hidePopover(); break;
      case 'submit':
        if (scenario.id === 'detach-on-submit') button.closest('form').remove();
        if (scenario.id === 'formless') setResult('JavaScript gönderimi tamamlandı.');
        break;
    }
  });
  if (scenario.id === 'late-form') setTimeout(() => { root.querySelector('.loading').outerHTML = signup(); }, 700);
  // Child injection follows the production manifest; native mode always relies
  // on the installed extension and never introduces a simulated bridge.
  window.labFixtureReady = true;
})();
