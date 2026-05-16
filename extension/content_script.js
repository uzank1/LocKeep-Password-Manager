/**
 * ============================================================================
 * LOCKEEP EXTENSION — Unified Content Script
 * ============================================================================
*/

'use strict';

class LocKeepContentScript {
  constructor() {
    this.domain = window.location.hostname;
    this.credentials = [];
    this.iconUrl = chrome.runtime.getURL('icons/icon128.png');
    this.smallIconUrl = chrome.runtime.getURL('icons/icon48.png');
    this.activeDropdown = null;
    this.activePrompt = null;
    this._credentialsFetched = false; // Guard: don't inject until credentials are ready
    // Çok adımlı formlar için verileri biriktireceğimiz alan
    this.authBuffer = {
      username: '',
      password: ''
    };
  }

  async init() {
    // 1. Fetch credentials for current domain from background
    try {
      const baseDomain = this.getBaseDomain(this.domain);
      console.log(`[DIAGNOSTIC - Content] 1. Requesting credentials for origin: "${window.location.origin}", baseDomain: "${baseDomain}"`); // INJECT
      const response = await this.sendMessageToBackground({
        type: 'SEARCH_DOMAIN',
        domain: window.location.origin,
        baseDomain: baseDomain
      });
      console.log(`[DIAGNOSTIC - Content] 2. Raw Response from Background:`, response); // INJECT
      if (response && response.success && response.data && Array.isArray(response.data.entries)) {
        console.log("LocKeep: Data received for UI:", response.data.entries);
        // Backend farklı format dönebilir (www.x.com vs x.com vs login.x.com)
        // Base domain üzerinden filtrele
        this.credentials = response.data.entries.filter(entry => {
          const entryDomain = entry.domain || entry.url || '';
          return this.getBaseDomain(entryDomain) === baseDomain;
        });
        // Eğer backend zaten filtreli döndürdüyse (filtre sıfırladıysa) tüm entries'i kullan
        if (this.credentials.length === 0) {
          this.credentials = response.data.entries;
        }
      } else {
        this.credentials = [];
      }
    } catch (e) {
      this.credentials = [];
    }

    // Mark credentials as fetched — MutationObserver can now safely inject
    this._credentialsFetched = true;

    // 2. Check for pending save
    try {
      const pendingRes = await this.sendMessageToBackground({ type: 'GET_PENDING_SAVE' });
      if (pendingRes && pendingRes.success && pendingRes.data) {
        const pending = pendingRes.data;
        // Base domain eşleşmesi — subdomain geçişlerinde de çalışır
        const pendingBase = pending.baseDomain || this.getBaseDomain(pending.domain || '');
        if (pendingBase && pendingBase === this.getBaseDomain(this.domain)) {
          this.showSavePrompt(pending.username, pending.password, pending.url);
        }
      }
    } catch (e) { }

    // 3. Analyze page (credentials are ready now)
    if (!Array.isArray(this.credentials)) {
      this.credentials = [];
    }
    this.analyzeAndInject();

    // 4. Setup form submission listeners for "Save Password"
    this.setupSubmissionListeners();

    // 5. Watch for dynamic inputs (React/Vue SPAs)
    // FIX: Only re-analyze if credentials are already fetched.
    // FIX: Reset the lockeepInjected flag on removed nodes so re-added nodes get re-processed.
    const observer = new MutationObserver((mutations) => {
      if (!this._credentialsFetched) return; // Don't inject before credentials are ready

      let shouldReanalyze = false;
      mutations.forEach(m => {
        // Track removed nodes — if an injected input was removed, clear its flag
        m.removedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const inputs = node.tagName === 'INPUT' ? [node] : Array.from(node.querySelectorAll('input'));
            inputs.forEach(inp => { delete inp.dataset.lockeepInjected; });
          }
        });

        m.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (
              (node.tagName === 'INPUT' && (node.type === 'password' || node.type === 'email' || node.type === 'text')) ||
              node.querySelector('input')
            ) {
              shouldReanalyze = true;
            }
          }
        });
      });
      if (shouldReanalyze) this.analyzeAndInject();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 5.5 Çok adımlı formlar için anlık (her harfte) kayıt sistemi
    document.addEventListener('input', (e) => {
      const target = e.target;
      if (target.tagName === 'INPUT') {
        const type = (target.type || '').toLowerCase();
        const name = (target.name || target.id || target.className || '').toLowerCase();

        // KESİN KORUMA: Adında, sınıfında veya tipinde 'password' kelimesi geçiyorsa ASLA alma!
        // Kutu 'text' kılığına girse bile isminden yakalarız.
        if (type === 'password' || name.includes('password')) {
          return; // Kaydetmeyi anında iptal et
        }

        // Sadece e-posta, kullanıcı adı veya sıradan metin kutularını hafızaya al
        if (name.includes('user') || name.includes('email') || name.includes('login') || type === 'text' || type === 'email') {
          const val = target.value.trim();
          if (val.length > 0) {
            chrome.storage.local.set({
              lockeep_last_username: val,
              lockeep_last_domain: this.getBaseDomain(this.domain),
              lockeep_last_time: Date.now()
            });
          }
        }
      }
    }, true);

    // 6. Click outside to close dropdown
    document.addEventListener('click', (e) => {
      if (this.activeDropdown && !this.activeDropdown.contains(e.target)) {
        this.activeDropdown.remove();
        this.activeDropdown = null;
      }
    });
  }

  // Hostname'den base domain çıkar: "login.riotgames.com" → "riotgames.com"
  getBaseDomain(hostname) {
    if (!hostname) return '';
    const h = hostname.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().split('?')[0];
    const parts = h.split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return h;
  }

  // Subdomain farklılıklarını tolere eden domain eşleşmesi
  // "login.riotgames.com" ve "account.riotgames.com" → eşleşir
  domainMatches(otherDomain) {
    if (!otherDomain) return false;
    return this.getBaseDomain(this.domain) === this.getBaseDomain(otherDomain);
  }

  sendMessageToBackground(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(response || null);
      });
    });
  }

  analyzeAndInject() {
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]'));
    console.log(`[DIAGNOSTIC - DOM] 1. Found Password Inputs:`, passwordInputs.length); // INJECT
    if (passwordInputs.length === 0) return;

    passwordInputs.forEach(passInput => {
      if (passInput.dataset.lockeepInjected) return;
      passInput.dataset.lockeepInjected = 'true';

      const form = passInput.closest('form') || document.body;
      const usernameInput = this.findUsernameInput(form);
      const isSignup = this.isSignupForm(form, passInput);
      console.log(`[DIAGNOSTIC - DOM] 2. Form Analysis:`, { usernameInputFound: !!usernameInput, isSignup, credsCount: this.credentials?.length }); // INJECT

      if (isSignup) {
        // Inject generate icon ONLY into sign-up fields
        this.injectGenerateIcon(passInput, usernameInput);
      } else {
        // Setup autofill dropdown on login fields
        if (usernameInput && Array.isArray(this.credentials) && this.credentials.length > 0) {
          this.setupAutofillDropdown(usernameInput, passInput);
        }
      }
    });
  }

  // FIX: Extracted to a shared helper to avoid inconsistent selector usage
  findUsernameInput(form, passwordInput = null) {
    const selectors = [
      'input[type="email"]:not([hidden])',
      'input[name="identifier"]:not([hidden])',
      'input[name*="user"]:not([hidden])',
      'input[name*="email"]:not([hidden])',
      'input[name*="login"]:not([hidden])',
      'input[type="text"]:not([hidden])',
    ];
    for (const sel of selectors) {
      const elements = form.querySelectorAll(sel);
      for (const el of elements) {
        if (passwordInput && el === passwordInput) continue;
        if (el.type === 'password') continue;

        return el;
      }
    }
    return null;
  }

  isSignupForm(form, passwordInput) {
    if (!form || form === document.body) {
      if (passwordInput) {
        const inputAttr = `${passwordInput.id || ''} ${passwordInput.name || ''}`.toLowerCase();
        if (/(new|signup|register)/i.test(inputAttr)) return true;
      }
      const allPass = document.querySelectorAll('input[type="password"]');
      if (allPass.length > 1) return true;
      return false;
    }

    const passwordInputs = form.querySelectorAll('input[type="password"]');
    if (passwordInputs.length > 1) return true;

    const formAttr = `${form.id || ''} ${form.name || ''} ${form.action || ''}`.toLowerCase();
    if (/(signup|register|join|create|new)/i.test(formAttr)) {
      if (!/(login|signin|sign-in|auth)/i.test(formAttr)) {
        return true;
      }
    }

    if (passwordInput) {
      const inputAttr = `${passwordInput.id || ''} ${passwordInput.name || ''}`.toLowerCase();
      if (/(new|signup|register)/i.test(inputAttr)) return true;
    }

    return false;
  }

  setupAutofillDropdown(usernameInput, passwordInput) {
    const showDropdown = (e) => {
      if (e) {
        e.stopPropagation();
      }

      // If dropdown is already active, just return to prevent flicker
      if (this.activeDropdown) {
        return;
      }

      const credentials = Array.isArray(this.credentials) ? this.credentials : [];
      if (credentials.length === 0) return;

      const rect = usernameInput.getBoundingClientRect();
      const dropdown = document.createElement('div');
      dropdown.className = 'lockeep-dropdown';
      // position:fixed → koordinatlar viewport'a göre, scroll offset yok
      dropdown.style.top = `${rect.bottom + 5}px`;
      dropdown.style.left = `${rect.left}px`;
      // FIX: Match dropdown width to the input for a polished look
      dropdown.style.minWidth = `${rect.width}px`;

      credentials.forEach(cred => {
        const item = document.createElement('div');
        item.className = 'lockeep-dropdown-item';

        const userSpan = document.createElement('span');
        userSpan.className = 'lockeep-dropdown-username';
        userSpan.textContent = cred.username;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'lockeep-dropdown-title';
        titleSpan.textContent = cred.title || 'LocKeep Vault';

        item.appendChild(userSpan);
        item.appendChild(titleSpan);

        item.addEventListener('mousedown', async (e) => {
          // FIX: Use mousedown + preventDefault to prevent the input losing focus
          // before the click registers, which previously caused the dropdown to
          // close via the document click listener before the item could be selected.
          e.preventDefault();
          e.stopPropagation();

          let passwordToFill = cred.password;
          if (!passwordToFill && cred.id) {
            const detailRes = await this.sendMessageToBackground({ type: 'GET_CREDENTIAL', id: cred.id });
            if (detailRes && detailRes.success) {
              const resData = detailRes.data || {};
              passwordToFill = (resData.entry && resData.entry.password) || resData.password || detailRes.password;
            }
          }

          // FIX: Fill username first, then password
          if (usernameInput) {
            usernameInput.value = cred.username;
            usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
            usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          if (passwordToFill && passwordInput) {
            passwordInput.value = passwordToFill;
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          dropdown.remove();
          this.activeDropdown = null;
        });

        dropdown.appendChild(item);
      });

      document.body.appendChild(dropdown);
      this.activeDropdown = dropdown;
    };

    // FIX: Listen to both 'focus' and 'click' — 'focus' alone misses the case
    // where the input is already focused when the page loads (e.g. autofocused inputs).
    usernameInput.addEventListener('focus', showDropdown);
    usernameInput.addEventListener('click', showDropdown);
  }

  injectGenerateIcon(passwordInput, usernameInput) {
    const getVisiblePassInputs = () => {
      return Array.from(document.querySelectorAll('input[type="password"]'))
        .filter(inp => inp.offsetParent !== null);
    };

    const allPassInputs = getVisiblePassInputs();
    const isConfirm = /(confirm|onayla|re|repeat|tekrar|again)/i.test(passwordInput.name || passwordInput.id || passwordInput.placeholder || '');

    if (isConfirm || allPassInputs.indexOf(passwordInput) > 0) return;

    const icon = document.createElement('div');
    icon.className = 'lockeep-generate-icon';
    icon.title = 'Güçlü şifre oluştur';
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
    `;

    const positionIcon = () => {
      // Sadece input'un kendisinin sınırlarını al
      const inputRect = passwordInput.getBoundingClientRect();

      // Kutu görünmüyorsa ikonu gizle
      if (inputRect.width === 0 || inputRect.top === 0) {
        icon.style.display = 'none';
        return;
      }

      icon.style.display = 'flex';

      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

      // Akıllı Yatay Hizalama: Riot Games gibi küçülen kutular için '.field' sınıfını ara.
      // Eğer yoksa (SignUp.com gibi), normal input'un genişliğini kullan.
      const wrapper = passwordInput.closest('.field');
      const widthRect = wrapper ? wrapper.getBoundingClientRect() : inputRect;

      // DİKEY (Top): Kesinlikle input'un kendi yüksekliğinin tam ortası
      icon.style.top = (scrollTop + inputRect.top + (inputRect.height / 2)) + 'px';

      // YATAY (Left): Riot'ta dış çerçeve, diğerlerinde input'un sağ kenarı
      icon.style.left = (scrollLeft + widthRect.left + widthRect.width + 4) + 'px';
    };

    // Varsa eski hayalet ikonu temizle
    if (passwordInput._lockeepIcon) {
      passwordInput._lockeepIcon.remove();
    }
    passwordInput._lockeepIcon = icon;

    // İkonu body'ye ekle
    document.body.appendChild(icon);
    positionIcon();

    // 1. GMAIL ÇÖZÜMÜ (Layout Shift Radar): Animasyon bitene kadar (ilk 1.5 saniye) takip et
    let ticks = 0;
    const settleInterval = setInterval(() => {
      positionIcon();
      ticks++;
      // 15 tur (1.5 saniye) sonra takibi bırakır, performansı yormaz
      if (ticks > 15) clearInterval(settleInterval);
    }, 100);

    // 2. Sadece şifre kutusunu değil, dış çerçeveyi de takip et (SignUp ve Gmail için)
    const observer = new ResizeObserver(() => positionIcon());
    observer.observe(passwordInput);
    const wrapper = passwordInput.closest('.field') || passwordInput.parentElement;
    if (wrapper) {
      observer.observe(wrapper);
    }

    // 3. Klasik Takipçiler
    window.addEventListener('resize', positionIcon);
    window.addEventListener('scroll', positionIcon, true);
    passwordInput.addEventListener('focus', () => {
      // Riot gibi odaklanınca animasyon yapan siteler için ufak bir gecikme
      setTimeout(positionIcon, 150);
      positionIcon();
    });

    // Şifre oluşturma tıklama olayı
    icon.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await this.sendMessageToBackground({ type: 'GENERATE_PASSWORD' });
      if (res && res.success && res.data && res.data.password) {
        const generatedPassword = res.data.password;
        const currentPassInputs = getVisiblePassInputs();
        currentPassInputs.forEach(inp => {
          inp.value = generatedPassword;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    });
  }

  setupSubmissionListeners() {
    const handleSubmit = async (formElement) => {
      if (!formElement) return;
      const passwordInput = formElement.querySelector('input[type="password"]');
      if (!passwordInput || !passwordInput.value) return;

      const usernameInput = this.findUsernameInput(formElement, passwordInput);
      let username = usernameInput ? usernameInput.value.trim() : '';
      const password = passwordInput.value;

      // Çifte Güvenlik: Şifre yanlışlıkla kullanıcı adı olarak alındıysa temizle
      if (username === password) {
        username = "";
      }

      // ANLIK HAFIZA OKUYUCU: Sayfada yoksa Brave'in anlık hafızasından çek
      if (!username) {
        const res = await chrome.storage.local.get(['lockeep_last_username', 'lockeep_last_domain', 'lockeep_last_time']);

        // Eğer kayıtlı bir isim varsa, domain uyuyorsa ve 15 dakikadan eskiyse
        if (
          res.lockeep_last_username &&
          this.getBaseDomain(res.lockeep_last_domain) === this.getBaseDomain(this.domain) &&
          Date.now() - res.lockeep_last_time < 15 * 60 * 1000
        ) {
          username = res.lockeep_last_username;
        }
      }

      const isKnown = Array.isArray(this.credentials) && this.credentials.some(c => c.username === username);

      if (!isKnown && password.length >= 4) {
        const loginUrl = window.location.origin;
        const loginDomain = this.domain;
        this.sendMessageToBackground({
          type: 'SET_PENDING_SAVE',
          entry: {
            domain: loginDomain,
            baseDomain: this.getBaseDomain(loginDomain),
            url: loginUrl,
            username,
            password
          }
        });
        this.showSavePrompt(username, password, loginUrl);
      }
    };

    // 1. Native form submissions
    document.addEventListener('submit', (e) => {
      handleSubmit(e.target);
    });

    // 2. JS-driven form submissions (listening to button clicks)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, input[type="submit"], input[type="button"]');
      if (!btn) return;
      if (btn.closest('.lockeep-save-prompt')) return;

      const text = (btn.textContent || btn.value || '').toLowerCase();
      const isSubmitType = btn.type === 'submit';
      const isLoginOrRegister = /(login|sign in|giriş yap|register|sign up|kaydol)/i.test(text);

      if (isSubmitType || isLoginOrRegister) {
        const form = btn.closest('form') || document.body;
        handleSubmit(form);
      }
    });
  }

  async showSavePrompt(username, password, loginUrl) {
    // Localization Dictionary
    const i18n = {
      en: {
        title: "Save to LocKeep?",
        body: (domain) => `Would you like to securely save this password for <strong>${domain}</strong> in your LocKeep vault?`,
        notNow: "Not Now",
        save: "Save Password",
        success: "Saved successfully!",
        error: "LocKeep: Failed to save password. Ensure your vault is unlocked."
      },
      tr: {
        title: "LocKeep'e Kaydet?",
        body: (domain) => `<strong>${domain}</strong> için bu parolayı LocKeep kasanıza güvenle kaydetmek ister misiniz?`,
        notNow: "Şimdi Değil",
        save: "Parolayı Kaydet",
        success: "Başarıyla kaydedildi!",
        error: "LocKeep: Parola kaydedilemedi. Kasanızın kilidinin açık olduğundan emin olun."
      },
      de: {
        title: "In LocKeep speichern?",
        body: (domain) => `Möchten Sie dieses Passwort für <strong>${domain}</strong> sicher in Ihrem LocKeep-Tresor speichern?`,
        notNow: "Jetzt nicht",
        save: "Passwort speichern",
        success: "Erfolgreich gespeichert!",
        error: "LocKeep: Passwort konnte nicht gespeichert werden. Stellen Sie sicher, dass Ihr Tresor entsperrt ist."
      }
    };

    // Get language preference
    let lang = 'en';
    try {
      const storage = await chrome.storage.local.get(['language']);
      if (storage.language && i18n[storage.language]) {
        lang = storage.language;
      } else {
        // Fallback to browser language
        const browserLang = chrome.i18n.getUILanguage().split('-')[0];
        if (i18n[browserLang]) lang = browserLang;
      }
    } catch (e) { }

    const t = i18n[lang];

    // loginUrl verilmemişse şu anki sayfa URL'sini kullan, her zaman sadece origin'i al
    let saveUrl = loginUrl || window.location.origin;
    try { saveUrl = new URL(saveUrl).origin; } catch (e) { }
    const saveDomain = (() => {
      try { return new URL(saveUrl).hostname; } catch { return this.domain; }
    })();

    if (this.activePrompt) this.activePrompt.remove();

    const prompt = document.createElement('div');
    prompt.className = 'lockeep-save-prompt';

    prompt.innerHTML = `
      <div class="lockeep-save-prompt-header">
        <img src="${this.iconUrl}" class="lockeep-save-prompt-logo" alt="LocKeep" />
        <h3 class="lockeep-save-prompt-title">${t.title}</h3>
      </div>
      <div class="lockeep-save-prompt-body">
        ${t.body(saveDomain)}
      </div>
      <div class="lockeep-save-prompt-actions">
        <button type="button" class="lockeep-btn lockeep-btn-secondary" id="lk-prompt-cancel">${t.notNow}</button>
        <button type="button" class="lockeep-btn lockeep-btn-primary" id="lk-prompt-save">${t.save}</button>
      </div>
    `;

    document.body.appendChild(prompt);
    this.activePrompt = prompt;

    document.getElementById('lk-prompt-cancel').addEventListener('click', (e) => {
      e.preventDefault();
      this.sendMessageToBackground({ type: 'CLEAR_PENDING_SAVE' });
      prompt.remove();
      this.activePrompt = null;
    });

    document.getElementById('lk-prompt-save').addEventListener('click', async (e) => {
      e.preventDefault();

      const newEntry = {
        title: document.title || saveDomain,
        url: window.location.origin,           // Login sayfasının URL'si — yeni sayfa değil
        domain: window.location.origin,
        username: username,
        password: password,
        category: 'Login',
        notes: 'Saved from browser extension'
      };

      const res = await this.sendMessageToBackground({
        type: 'ADD_ENTRY',
        entry: newEntry
      });

      if (res && res.success) {
        prompt.innerHTML = `
          <div class="lockeep-save-prompt-header">
            <img src="${this.iconUrl}" class="lockeep-save-prompt-logo" alt="LocKeep" />
            <h3 class="lockeep-save-prompt-title">${t.success}</h3>
          </div>
        `;
        setTimeout(() => {
          if (this.activePrompt === prompt) {
            prompt.remove();
            this.activePrompt = null;
          }
        }, 2000);
      } else {
        alert(t.error);
        prompt.remove();
        this.activePrompt = null;
      }
    });
  }
}

// Initialize script
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new LocKeepContentScript().init());
} else {
  new LocKeepContentScript().init();
}