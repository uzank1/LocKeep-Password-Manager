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

const DIAGNOSTIC_STRINGS = {
  en: {
    button: 'Check autofill', checking: 'Checking this page…', report: 'Technical report', copy: 'Copy report', copied: 'Copied',
    copyManually: 'Select and copy the report below.',
    hint: 'When the list is missing, click the login field first, then run this check. The report includes the site hostname and technical state; no usernames or passwords.',
    findings: {
      vault_locked: 'The vault is locked. Unlock it in the desktop app.',
      native_unavailable: 'The desktop app could not be reached. Check that LocKeep is running and browser integration is enabled.',
      request_timeout: 'The connection did not respond in time.', handshake_failed: 'The secure connection could not be established.',
      messaging_failed: 'The page could not communicate with the extension. Reload the extension and this page.',
      query_failed: 'The account search failed.', invalid_response: 'The account search returned an unexpected response.',
      stale_empty_cache: 'This page cached an empty result, but accounts are available now. Refreshing the page should retry the search.',
      credentials_not_fetched: 'Accounts are available, but this page has not fetched them yet.',
      no_matching_credentials: 'The current lookup found no accounts matching this login hostname.',
      no_password_field: 'No password field was detected in the main page. Username-only steps currently do not receive the account list.',
      signup_classification: 'The visible form was treated as account registration, which shows the password generator instead of the account list.',
      autofill_listener_missing: 'Accounts are cached, but the visible login field has no autofill listener.',
      form_classification_changed: 'The form changed between login and registration after it was analyzed.',
      password_field_in_frame: 'A password field is inside an embedded frame. Autofill currently runs only in the main page.',
      possible_frame_form: 'This page contains embedded frames. Some cannot be inspected; the login form may be inside one.',
      password_field_in_shadow_dom: 'A password field is inside a web component that the current form scan does not reach.',
      dropdown_detached: 'The page removed the account list, but the extension still considers it open.',
      dropdown_hidden: 'The account list exists but is hidden.', dropdown_outside_viewport: 'The account list is outside the visible area.',
      dropdown_covered: 'Another page element is covering the account list.',
      focus_without_user_action: 'The last focus event did not follow a user action. Click the login field to open the list.',
      initialization_pending: 'The page script is still starting.', initialization_failed: 'The page script failed to initialize.',
      no_blocker_detected: 'No clear blocker was found. Reproduce the missing list by clicking the login field and run this check again.',
      content_script_unavailable: 'The page script could not be reached. Reload the extension and page, and check site access permissions.',
      unsupported_page: 'This check works on regular HTTP/HTTPS websites.', diagnostics_failed: 'The report could not be collected. Try again.'
    }
  },
  tr: {
    button: 'Otomatik doldurmayı kontrol et', checking: 'Bu sayfa kontrol ediliyor…', report: 'Teknik rapor', copy: 'Raporu kopyala', copied: 'Kopyalandı',
    copyManually: 'Aşağıdaki raporu seçip kopyalayın.',
    hint: 'Liste görünmediğinde önce giriş alanına tıklayın, ardından bu kontrolü çalıştırın. Raporda sitenin alan adı ve teknik durum bulunur; kullanıcı adı ve parola bulunmaz.',
    findings: {
      vault_locked: 'Kasa kilitli. Masaüstü uygulamasından kasanın kilidini açın.',
      native_unavailable: 'Masaüstü uygulamasına ulaşılamadı. LocKeep’in çalıştığını ve tarayıcı entegrasyonunun etkin olduğunu kontrol edin.',
      request_timeout: 'Bağlantı zamanında yanıt vermedi.', handshake_failed: 'Güvenli bağlantı kurulamadı.',
      messaging_failed: 'Sayfa uzantıyla iletişim kuramadı. Uzantıyı ve sayfayı yeniden yükleyin.',
      query_failed: 'Hesap araması başarısız oldu.', invalid_response: 'Hesap aramasından beklenmeyen bir yanıt geldi.',
      stale_empty_cache: 'Sayfa boş sonucu tutmuş, ancak şu anda hesaplar bulunabiliyor. Sayfayı yenilemek aramayı tekrar başlatır.',
      credentials_not_fetched: 'Hesaplar bulunabiliyor, ancak bu sayfa henüz hesapları sorgulamamış.',
      no_matching_credentials: 'Yeni sorguda bu giriş alan adıyla eşleşen hesap bulunamadı.',
      no_password_field: 'Ana sayfada parola alanı algılanmadı. Yalnızca kullanıcı adı isteyen adımlarda hesap listesi şu anda eklenmiyor.',
      signup_classification: 'Görünen form hesap oluşturma olarak algılanmış. Bu durumda hesap listesi yerine parola oluşturucu gösteriliyor.',
      autofill_listener_missing: 'Hesaplar sayfada mevcut, ancak görünen giriş alanına otomatik doldurma bağlanmamış.',
      form_classification_changed: 'Form incelendikten sonra giriş/kayıt türü değişmiş.',
      password_field_in_frame: 'Parola alanı gömülü bir çerçevenin içinde. Otomatik doldurma şu anda yalnızca ana sayfada çalışıyor.',
      possible_frame_form: 'Sayfada gömülü çerçeveler var. Bazılarının içi incelenemiyor; giriş formu bunlardan birinde olabilir.',
      password_field_in_shadow_dom: 'Parola alanı mevcut form taramasının ulaşamadığı bir web bileşeninin içinde.',
      dropdown_detached: 'Sayfa hesap listesini kaldırmış, ancak uzantı hâlâ açık olduğunu düşünüyor.',
      dropdown_hidden: 'Hesap listesi oluşturulmuş, ancak gizlenmiş.', dropdown_outside_viewport: 'Hesap listesi görünür alanın dışında.',
      dropdown_covered: 'Başka bir sayfa öğesi hesap listesinin üzerini kapatıyor.',
      focus_without_user_action: 'Son odaklanma bir kullanıcı hareketini takip etmemiş. Listeyi açmak için giriş alanına tıklayın.',
      initialization_pending: 'Sayfa betiği henüz başlatılıyor.', initialization_failed: 'Sayfa betiği başlatılamadı.',
      no_blocker_detected: 'Belirgin bir engel bulunamadı. Giriş alanına tıklayarak sorunu tekrar oluşturup kontrolü yeniden çalıştırın.',
      content_script_unavailable: 'Sayfa betiğine ulaşılamadı. Uzantıyı ve sayfayı yeniden yükleyin; uzantının site erişim iznini kontrol edin.',
      unsupported_page: 'Bu kontrol normal HTTP/HTTPS web sitelerinde çalışır.', diagnostics_failed: 'Rapor alınamadı. Tekrar deneyin.'
    }
  },
  de: {
    button: 'Autofill prüfen', checking: 'Diese Seite wird geprüft…', report: 'Technischer Bericht', copy: 'Bericht kopieren', copied: 'Kopiert',
    copyManually: 'Den folgenden Bericht auswählen und kopieren.',
    hint: 'Wenn die Liste fehlt, zuerst das Anmeldefeld anklicken und dann prüfen. Der Bericht enthält den Hostnamen und technische Zustände; keine Benutzernamen oder Passwörter.',
    findings: {
      vault_locked: 'Der Tresor ist gesperrt. In der Desktop-App entsperren.',
      native_unavailable: 'Die Desktop-App ist nicht erreichbar. Prüfen, ob LocKeep läuft und die Browser-Integration aktiviert ist.',
      request_timeout: 'Die Verbindung hat nicht rechtzeitig geantwortet.', handshake_failed: 'Die sichere Verbindung konnte nicht aufgebaut werden.',
      messaging_failed: 'Die Seite konnte die Erweiterung nicht erreichen. Erweiterung und Seite neu laden.',
      query_failed: 'Die Kontosuche ist fehlgeschlagen.', invalid_response: 'Die Kontosuche hat eine unerwartete Antwort geliefert.',
      stale_empty_cache: 'Die Seite hat ein leeres Ergebnis gespeichert, aber jetzt sind Konten verfügbar. Die Seite neu laden, um erneut zu suchen.',
      credentials_not_fetched: 'Konten sind verfügbar, wurden von dieser Seite aber noch nicht abgefragt.',
      no_matching_credentials: 'Die aktuelle Suche hat keine Konten für diesen Anmelde-Hostnamen gefunden.',
      no_password_field: 'Kein Passwortfeld auf der Hauptseite erkannt. Schritte, die nur einen Benutzernamen abfragen, erhalten derzeit keine Kontoliste.',
      signup_classification: 'Das sichtbare Formular wurde als Registrierung erkannt. Dabei erscheint der Passwortgenerator statt der Kontoliste.',
      autofill_listener_missing: 'Konten sind gespeichert, aber dem sichtbaren Anmeldefeld fehlt der Autofill-Listener.',
      form_classification_changed: 'Der Formulartyp hat sich nach der Analyse zwischen Anmeldung und Registrierung geändert.',
      password_field_in_frame: 'Ein Passwortfeld befindet sich in einem eingebetteten Frame. Autofill läuft derzeit nur auf der Hauptseite.',
      possible_frame_form: 'Diese Seite enthält eingebettete Frames. Einige können nicht geprüft werden; das Formular könnte darin liegen.',
      password_field_in_shadow_dom: 'Ein Passwortfeld liegt in einer Webkomponente, die die aktuelle Formularsuche nicht erreicht.',
      dropdown_detached: 'Die Seite hat die Kontoliste entfernt, aber die Erweiterung betrachtet sie noch als geöffnet.',
      dropdown_hidden: 'Die Kontoliste existiert, ist aber verborgen.', dropdown_outside_viewport: 'Die Kontoliste liegt außerhalb des sichtbaren Bereichs.',
      dropdown_covered: 'Ein anderes Seitenelement verdeckt die Kontoliste.',
      focus_without_user_action: 'Der letzte Fokus folgte keiner Benutzeraktion. Das Anmeldefeld anklicken.',
      initialization_pending: 'Das Seitenskript startet noch.', initialization_failed: 'Das Seitenskript konnte nicht starten.',
      no_blocker_detected: 'Kein eindeutiges Hindernis gefunden. Das Anmeldefeld anklicken, den Fehler reproduzieren und erneut prüfen.',
      content_script_unavailable: 'Das Seitenskript ist nicht erreichbar. Erweiterung und Seite neu laden und die Website-Berechtigung prüfen.',
      unsupported_page: 'Diese Prüfung funktioniert auf normalen HTTP/HTTPS-Websites.', diagnostics_failed: 'Der Bericht konnte nicht erstellt werden. Erneut versuchen.'
    }
  }
};

const diagnoseButton = document.getElementById('diagnoseButton');
const hintEl = document.getElementById('diagnosticsHint');
const resultEl = document.getElementById('diagnosticsResult');
const findingsEl = document.getElementById('diagnosticsFindings');
const reportEl = document.getElementById('diagnosticsReport');
const copyButton = document.getElementById('copyReportButton');

function updateDiagnosticLanguage() {
  const strings = DIAGNOSTIC_STRINGS[lang];
  diagnoseButton.textContent = strings.button;
  hintEl.textContent = strings.hint;
  document.getElementById('reportLabel').textContent = strings.report;
  copyButton.textContent = strings.copy;
}

function showReport(report) {
  findingsEl.replaceChildren();
  const strings = DIAGNOSTIC_STRINGS[lang];
  report.findings.forEach(code => {
    const item = document.createElement('li');
    item.textContent = strings.findings[code] || strings.findings.diagnostics_failed;
    findingsEl.appendChild(item);
  });
  reportEl.value = JSON.stringify(report, null, 2);
  document.getElementById('reportDetails').hidden = false;
}

function minimalReport(code, site = '') {
  return { schemaVersion: 1, extensionVersion: chrome.runtime.getManifest().version,
    site, capturedAt: new Date().toISOString(), findings: [code] };
}

async function requestPageReport(tabId) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'GET_AUTOFILL_DIAGNOSTICS' }, { frameId: 0 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic timeout')), 20000); })
    ]);
  } finally { clearTimeout(timer); }
}

diagnoseButton.addEventListener('click', async () => {
  diagnoseButton.disabled = true;
  diagnoseButton.textContent = DIAGNOSTIC_STRINGS[lang].checking;
  resultEl.hidden = false;
  findingsEl.replaceChildren();
  document.getElementById('reportDetails').hidden = true;
  let site = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !Number.isInteger(tab.id) || !/^https?:\/\//i.test(tab.url || '')) {
      showReport(minimalReport('unsupported_page'));
      return;
    }
    site = new URL(tab.url).hostname;
    let response;
    try { response = await requestPageReport(tab.id); }
    catch { showReport(minimalReport('content_script_unavailable', site)); return; }
    showReport(response && response.success && response.report
      ? response.report : minimalReport('diagnostics_failed', site));
  } catch { showReport(minimalReport('diagnostics_failed', site)); }
  finally {
    diagnoseButton.disabled = false;
    diagnoseButton.textContent = DIAGNOSTIC_STRINGS[lang].button;
    copyButton.textContent = DIAGNOSTIC_STRINGS[lang].copy;
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportEl.value);
    copyButton.textContent = DIAGNOSTIC_STRINGS[lang].copied;
  } catch {
    document.getElementById('reportDetails').open = true;
    reportEl.focus();
    reportEl.select();
    copyButton.textContent = DIAGNOSTIC_STRINGS[lang].copyManually;
  }
});

updateDiagnosticLanguage();

(async function () {
  try {
    const langResp = await chrome.runtime.sendMessage({ type: 'GET_LANGUAGE' });
    if (langResp && langResp.language && POPUP_STRINGS[langResp.language]) {
      lang = langResp.language;
    }
  } catch { /* default en */ }

  const s = POPUP_STRINGS[lang];
  updateDiagnosticLanguage();
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
        if (chrome.runtime.lastError || !searchResponse || !searchResponse.success) {
          if (LocKeepAutofillDiagnostics.lookupStatus(searchResponse) !== 'vault_locked') {
            statusEl.textContent = s.disconnected;
            statusEl.className = 'status disconnected';
            return;
          }
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
