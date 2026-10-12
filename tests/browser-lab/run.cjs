'use strict';
// Runs the production content script in an isolated Chromium renderer with a
// fake bridge. No desktop app, native messaging host or real vault is loaded.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createLabServer } = require('./server.cjs');
const { cases } = require('./catalog');
const output = path.resolve(__dirname, '../../dist/browser-lab');
fs.mkdirSync(path.join(output, 'runtime'), { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const only = process.argv.find(argument => argument.startsWith('--case='))?.slice(7);
const selectedCases = only ? cases.filter(scenario => only.split(',').includes(scenario.id)) : cases;
if (!selectedCases.length) throw new Error('Unknown scenario.');
const report = { generatedAt: new Date().toISOString(), engine: `Chromium ${process.versions.chrome}`, mode: 'production content script + simulated bridge', scenarios: [], harnessErrors: [] };
let win;
let lab;
let fixtureFrame = null;
const js = code => (fixtureFrame || win.webContents).executeJavaScript(code);
const backgroundMemory = new Map();
ipcMain.on('lab-memory-read', (event, id) => { event.returnValue = backgroundMemory.get(id) || null; });
ipcMain.on('lab-memory-write', (event, id, value) => { backgroundMemory.set(id, value); event.returnValue = true; });
async function click(selector) {
  if ((selector.includes('data-action="submit"') || selector.includes('data-action="next"')) && await js('Boolean(document.querySelector(".lockeep-dropdown"))')) await click('h1');
  const point = await js(`(() => { const elements = [...document.querySelectorAll(${JSON.stringify(selector)}), ...window.labFixtureRoot?.querySelectorAll(${JSON.stringify(selector)}) || []]; const element = elements.find(item => { const rect=item.getBoundingClientRect(); const style=getComputedStyle(item); return !item.disabled && !item.hidden && rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; }); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
  if (point && fixtureFrame) {
    const offset = await win.webContents.executeJavaScript('(() => { const frame = document.querySelector("iframe"); const rect = frame.getBoundingClientRect(); return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop }; })()');
    point.x += offset.x; point.y += offset.y;
  }
  if (process.argv.includes('--lab-debug')) console.log(JSON.stringify({ selector, point, viewport: win.getContentSize(), rootHit: point ? await win.webContents.executeJavaScript(`document.elementFromPoint(${point.x},${point.y})?.tagName`) : null }));
  if (!point || point.x < 0 || point.y < 0 || point.x >= win.getContentSize()[0] || point.y >= win.getContentSize()[1]) return false;
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await delay(90);
  return true;
}
async function type(selector, text) {
  // The renderer input event is generated through Chromium, not dispatchEvent.
  if (await js('Boolean(document.querySelector(".lockeep-dropdown"))')) await click('h1');
  const clicked = await click(selector);
  if (!clicked) return false;
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await win.webContents.debugger.sendCommand('Input.insertText', { text });
  await delay(50);
  return true;
}
async function snapshot(name) {
  await delay(250);
  const filename = `${name}.png`;
  fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage()).toPNG());
  return filename;
}
function extra(result, label, pass, detail = '') { result.checks.push({ label, pass, detail }); }
async function runScenario(scenario) {
  win.setContentSize(scenario.id === 'responsive' ? 320 : 1100, 800);
  const url = new URL(scenario.path, lab.url);
  url.searchParams.set('session', `automated-${Date.now()}-${cases.indexOf(scenario)}`);
  const errors = [];
  const onError = details => { if (details.level === 'error') errors.push(details.message); };
  win.webContents.on('console-message', onError);
  try {
    await win.loadURL(url.href);
    if (scenario.id.startsWith('iframe-')) {
      await delay(300);
      fixtureFrame = win.webContents.mainFrame.frames[0];
      assert.ok(fixtureFrame, 'Embedded fixture did not load');
    }
    await delay(['late-form', 'slow-connection'].includes(scenario.id) ? 1250 : 220);
    assert.ok(await js('Boolean(window.LocKeepLab && window.labFixtureReady)'), 'Fixture or fake bridge did not load');
    const extras = [];
    const add = (label, pass, detail = '') => extras.push({ label, pass, detail });
    if (['identity-captcha', 'masked-identity'].includes(scenario.id)) {
      await click('[data-lab="username"]');
      add('Kimlik kutusuna gerçek tıklama hesap listesini açtı', await js('Boolean(document.querySelector(".lockeep-dropdown"))'));
      if (await js('Boolean(document.querySelector(".lockeep-dropdown"))')) await click('.lockeep-dropdown-item');
      add('Kimlik kutusundan seçim doğru iki alanı doldurdu', await js('document.querySelector("[data-lab=username]").value === "00000000001" && document.querySelector("[data-lab=password]").value === "Demo-Autofill!2026"'));
      add('Kimlik seçiminde güvenlik kodu değişmedi', await js('document.querySelector("[data-lab=captcha]").value === "ABCD"'));
      await click('h1');
      if (scenario.id === 'masked-identity') {
        await click('[data-action="mask-identity"]'); await delay(180);
        await click('[data-lab="username"]');
        add('Kimlik görünür sayıya dönüşünce liste çalıştı', await js('document.querySelector("[data-lab=username]").type === "number" && Boolean(document.querySelector(".lockeep-dropdown"))'));
        await click('h1'); await click('[data-action="mask-identity"]'); await delay(180);
        await click('[data-lab="username"]');
        add('Kimlik tekrar gizlenince liste çalıştı', await js('document.querySelector("[data-lab=username]").type === "password" && Boolean(document.querySelector(".lockeep-dropdown")) && !document.querySelector(".lockeep-generate-icon")'));
        await click('h1');
      }
    }
    if (scenario.id === 'riot-five-step') {
      const initialURL = await js('location.href');
      await type('[data-lab="email"]', 'mail.demo@example.test'); await click('[data-action="signup-next"]');
      await type('[data-lab="birth"]', '1996'); await click('[data-action="signup-next"]');
      await type('[data-lab="username"]', 'new.demo@example.test'); await click('[data-action="signup-next"]'); await delay(200);
      await click('.lockeep-generate-icon');
      add('Üretim sonrasında ok düğmesi elle düzeltme gerektirmeden açıldı', await js('!document.querySelector("[data-action=signup-next]").disabled'));
      // Type normally only to continue collecting the pre-fix submission gap.
      if (await js('document.querySelector("[data-action=signup-next]").disabled')) {
        await type('[data-lab="password"]', 'Demo-Generated!2026-1'); await type('[data-lab="confirm"]', 'Demo-Generated!2026-1');
      }
      await click('[data-action="signup-next"]'); await delay(200);
      add('Şartlar ekranına geçince parola kutuları kaldırıldı', await js('!document.querySelector("[data-lab=password]") && Boolean(document.querySelector("[data-lab=terms]"))'));
      add('Son onaydan önce kayıt önerisi açılmadı', await js('!document.querySelector(".lockeep-save-prompt")'));
      await click('[data-lab="terms"]'); await click('[data-action="signup-next"]'); await delay(250);
      add('Beş adımlı kayıt URL değiştirmeden tamamlandı', await js(`location.href === ${JSON.stringify(initialURL)} && Boolean(document.querySelector(".result-banner"))`));
      add('Son onaydan sonra kayıt önerisi açıldı', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
      add('E-posta/doğum yılı yerine kullanıcı adı ve doğru parola korundu', await js('(async () => { const res = await LocKeepLab.dispatch({type:"GET_PENDING_SAVE"}); return res.data?.username === "new.demo@example.test" && res.data?.password === "Demo-Generated!2026-1"; })()'));
    }
    if (scenario.id === 'multistep-login' || scenario.id === 'multistep-signup') {
      if (scenario.kind === 'login') {
        add('İlk adımda hesap listesi bağlı', await js('Boolean(document.querySelector("[data-lab=username]")._lockeepAutofillListener)'));
        await click('[data-lab="username"]'); await click('.lockeep-dropdown-item');
        add('İlk adımda kullanıcı adı parola istemeden doldu', await js('document.querySelector("[data-lab=username]").value === "demo.one@example.test" && LocKeepLab.getCounts().details === 0'));
      }
      await type('[data-lab="username"]', 'new.demo@example.test');
      await click('[data-action="next"]'); await delay(200);
    }
    if (scenario.id === 'replace-form') { await click('[data-action="replace"]'); await delay(200); }
    if (scenario.id === 'reveal-password') { await click('[data-action="reveal"]'); await delay(200); }
    if (scenario.id === 'passkey-annotation') { await click('[data-action="restore-passkey"]'); await delay(150); }
    if (scenario.id === 'layout-shift') { await delay(1700); await click('[data-action="shift"]'); await delay(200); }
    if (scenario.id === 'removed-field') { await click('[data-action="remove"]'); await delay(180); }
    if (scenario.id === 'overlay') { await click('[data-action="overlay"]'); await delay(100); }
    if (scenario.id === 'popover') { await click('[data-action="popover"]'); await delay(100); }
    if (scenario.id === 'scroll-panel') {
      await click('[data-action="scroll-back"]'); await delay(180);
      add('Kaydırmadan önce düğme var', await js('LocKeepLab.audit().observed.icons === 1'));
      await click('[data-action="scroll"]'); await delay(180);
    }
    if (scenario.id === 'synthetic-events') {
      await js(`(() => { const input = document.querySelector('[data-lab=password]'); input.dispatchEvent(new FocusEvent('focus', {bubbles:true})); input.dispatchEvent(new MouseEvent('click', {bubbles:true})); document.querySelector('.lockeep-dropdown-item')?.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); })()`);
      add('Sahte olay hesap listesini açmadı', await js('!document.querySelector(".lockeep-dropdown")'));
    } else if (scenario.id === 'recover-connection') {
      await js('LocKeepLab.setProfile("available")');
      const diagnostics = await js('LocKeepLab.requestDiagnostics()');
      add('Eski boş önbellek teşhis edildi', diagnostics.report.findings.includes('stale_empty_cache'));
      await click('[data-lab="password"]'); await delay(200);
      add('Bağlantı dönünce yenilemeden hesap listesi açıldı', await js('Boolean(document.querySelector(".lockeep-dropdown"))'));
      await click('.lockeep-dropdown-item');
    } else if (scenario.id === 'pending-save') {
      add('Form olmayan sayfada kayıt önerisi var', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
      await click('.lockeep-btn-primary');
      add('Bekleyen örnek hesap kaydedildi', await js('LocKeepLab.getCounts().saved === 1 && !LocKeepLab.getCounts().pending'));
    } else if (['invalid-form', 'rejected-login', 'detach-on-submit', 'navigation-save'].includes(scenario.id)) {
      await type('[data-lab="username"]', scenario.id === 'invalid-form' ? 'invalid-email' : 'new.demo@example.test');
      await type('[data-lab="password"]', 'Demo-Typed!2026');
      if (await js('Boolean(document.querySelector("[data-lab=confirm]"))')) await type('[data-lab="confirm"]', 'Demo-Typed!2026');
      await click('[data-action="submit"]');
      await delay(350);
      if (scenario.id === 'navigation-save') add('Kayıt önerisi yeni sayfada göründü', await js('location.search.includes("result=1") && Boolean(document.querySelector(".lockeep-save-prompt"))'));
      if (scenario.id === 'detach-on-submit') add('Alanlar kaldırılınca bilgiler kaybolmadı', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
    } else if (['signup', 'change', 'mixed'].includes(scenario.kind) && !['dialog-signup', 'removed-field', 'overlay', 'popover', 'scroll-panel', 'layout-shift', 'riot-five-step'].includes(scenario.id)) {
      if (scenario.id === 'two-forms') await js('document.querySelector("#login-form [data-lab=password]").value = "Demo-Existing!keep"');
      if (['signup', 'responsive'].includes(scenario.id)) await type('[data-lab="username"]', 'new.demo@example.test');
      await click('.lockeep-generate-icon');
      add('Gerçek tıklama parola üretti', await js('LocKeepLab.getCounts().generated === 1'));
    } else if (scenario.kind === 'login' && !['empty-vault', 'locked-vault', 'offline-app'].includes(scenario.id)) {
      await click('[data-lab="password"]');
      add('Gerçek tıklama hesap listesini açtı', await js('Boolean(document.querySelector(".lockeep-dropdown"))'));
      const openListChecks = await js('LocKeepLab.audit().checks.filter(check => check.label.startsWith("Hesap listesi") || check.label.startsWith("Tekrarlanan hesap") || check.label.startsWith("Hesap başlığı"))');
      extras.push(...openListChecks);
      if (scenario.id !== 'bottom-field' && scenario.id !== 'dialog-login') await click('.lockeep-dropdown-item');
    }
    let result = await js('LocKeepLab.audit()');
    result.checks.push(...extras);
    if (scenario.id === 'overlay') {
      await click('[data-action="close-overlay"]'); await delay(200);
      extra(result, 'Katman kapanınca düğme geri geldi', await js('LocKeepLab.audit().observed.icons === 1'));
      await click('.lockeep-generate-icon');
      extra(result, 'Geri gelen düğme parola üretti', await js('LocKeepLab.getCounts().generated === 1'));
      await click('[data-action="overlay-edge"]'); await delay(180);
      extra(result, 'Yalnız kenarı örtülen alanın düğmesi de gizlendi', await js('LocKeepLab.audit().observed.icons === 0'));
      await click('[data-action="close-overlay"]'); await delay(180);
      extra(result, 'Yan panel kapanınca düğme geri geldi', await js('LocKeepLab.audit().observed.icons === 1'));
      extra(result, 'Katman düğmeleri kayıt önerisi açmadı', await js('!document.querySelector(".lockeep-save-prompt") && !LocKeepLab.getCounts().pending'));
    }
    if (scenario.id === 'dialog-signup') {
      await click('.lockeep-generate-icon');
      extra(result, 'İletişim kutusundaki düğme parola üretti', await js('LocKeepLab.getCounts().generated === 1'));
    }
    if (scenario.id === 'scroll-panel') {
      await click('[data-action="scroll-back"]'); await delay(200);
      extra(result, 'Parola alanına dönünce düğme geri geldi', await js('LocKeepLab.audit().observed.icons === 1'));
    }
    if (scenario.id === 'replace-form') {
      await click('[data-action="toggle-mode"]'); await delay(200);
      extra(result, 'Aynı alanlar kayda dönüşünce eski hesap listesi kaldırıldı', await js('!document.querySelector("[data-lab=password]")._lockeepAutofillListener && LocKeepLab.audit().observed.icons === 1'));
      await click('[data-action="toggle-mode"]'); await delay(200);
      extra(result, 'Girişe dönünce oluşturma düğmesi kaldırılıp liste geri bağlandı', await js('Boolean(document.querySelector("[data-lab=password]")._lockeepAutofillListener) && LocKeepLab.audit().observed.icons === 0'));
    }
    const response = await js('LocKeepLab.requestDiagnostics()');
    result.diagnostics = response.report;
    if (['identity-captcha', 'masked-identity', 'captcha-without-username'].includes(scenario.id)) {
      extra(result, 'Güvenlik koduna hesap listesi bağlanmadı', await js('!document.querySelector("[data-lab=captcha]")._lockeepAutofillListener'));
      extra(result, 'Teşhis yalnız giriş parolasını saydı', response.report.page.passwordInputCount === 1);
      extra(result, 'Teşhis kimlik veya güvenlik kodunu içermiyor', !/0000000000[12]|ABCD/.test(JSON.stringify(response.report)));
    }
    if (!response.success) throw new Error('Diagnostic report failed');
    const serialized = JSON.stringify(response.report);
    extra(result, 'Teşhis raporu hesap bilgisi içermiyor', !/demo\.one|demo\.two|new\.demo|Demo-(Autofill|Generated|Typed|Pending)/.test(serialized));
    if (scenario.id === 'empty-vault') extra(result, 'Boş sonuç doğru bildirildi', response.report.findings.includes('no_matching_credentials'));
    if (scenario.id === 'locked-vault') extra(result, 'Kilitli kasa doğru bildirildi', response.report.findings.includes('vault_locked'));
    if (scenario.id === 'offline-app') extra(result, 'Bağlantı hatası doğru bildirildi', response.report.findings.includes('native_unavailable'));
    if (scenario.id === 'multistep-signup') {
      await click('[data-action="submit"]'); await delay(120);
      extra(result, 'Önceki adımın kullanıcı adı kayıt önerisinde korundu', await js('LocKeepLab.getCounts().pending'));
    }
    if (scenario.id.startsWith('shadow-')) {
      await type('[data-lab="username"]', 'new.demo@example.test');
      await click('[data-action="submit"]'); await delay(200);
      extra(result, 'Bileşen içindeki gönderim doğru kullanıcı adıyla yakalandı', await js('(async () => { const pending = await LocKeepLab.dispatch({type:"GET_PENDING_SAVE"}); return Boolean(pending.data?.username === "new.demo@example.test" && document.querySelector(".lockeep-save-prompt")); })()'));
    }
    if (scenario.id === 'signup') {
      await js('document.querySelector(".lockeep-generate-icon").dispatchEvent(new MouseEvent("click", {bubbles:true}))');
      extra(result, 'Sahte tıklama yeni parola istemedi', await js('LocKeepLab.getCounts().generated === 1'));
      await click('[data-action="submit"]');
      extra(result, 'Kayıt önerisi gösterildi', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
      await click('.lockeep-btn-secondary');
      extra(result, 'Şimdi Değil kayıt yapmadan öneriyi kapattı', await js('!document.querySelector(".lockeep-save-prompt") && LocKeepLab.getCounts().saved === 0 && !LocKeepLab.getCounts().pending'));
      await delay(1100); await click('[data-action="submit"]'); await click('.lockeep-btn-primary');
      extra(result, 'Kaydet örnek hesabı bir kez kaydetti', await js('LocKeepLab.getCounts().saved === 1 && !LocKeepLab.getCounts().pending'));
    }
    if (scenario.id === 'icon-signup') {
      await type('[data-lab="username"]', 'new.demo@example.test');
      await js('document.querySelector("[data-action=submit]").dispatchEvent(new MouseEvent("click", {bubbles:true}))');
      extra(result, 'Sahte simgeli gönderim kayıt adayı oluşturmadı', await js('!LocKeepLab.getCounts().pending'));
      await click('[data-action="submit"]'); await delay(200);
      extra(result, 'Form dışındaki ok düğmesi kayıt önerisini açtı', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
      extra(result, 'Simgeli gönderimde doğru kullanıcı adı ve üretilen parola korundu', await js('(async () => { const res = await LocKeepLab.dispatch({type:"GET_PENDING_SAVE"}); return res.data?.username === "new.demo@example.test" && res.data?.password === "Demo-Generated!2026-1"; })()'));
    }
    if (['external-form', 'formless'].includes(scenario.id)) {
      await type('[data-lab="username"]', 'new.demo@example.test');
      await type('[data-lab="password"]', 'Demo-Typed!2026');
      await click('[data-action="submit"]');
      extra(result, 'Yeni hesap gönderimi kayıt önerisini açtı', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
    }
    if (scenario.id === 'responsive') {
      await click('[data-action="submit"]');
      await delay(450);
      const promptChecks = await js('LocKeepLab.audit().checks.filter(check => check.label.startsWith("Kayıt önerisi"))');
      result.checks.push(...promptChecks);
      extra(result, 'Dar ekranda kayıt önerisi oluştu', await js('Boolean(document.querySelector(".lockeep-save-prompt"))'));
    }
    if (scenario.id === 'login') {
      await click('[data-action="submit"]');
      extra(result, 'Bilinen hesap için tekrar kayıt önerisi çıkmadı', await js('!document.querySelector(".lockeep-save-prompt")'));
    }
    if (['locked-vault', 'offline-app', 'login'].includes(scenario.id)) {
      await js(`(() => { const iframe = document.createElement('iframe'); iframe.id='popup-preview'; iframe.src='/popup.html'; iframe.style.cssText='position:fixed;right:0;top:0;width:340px;height:520px;border:0;z-index:2147483647'; document.body.append(iframe); })()`);
      await delay(200);
      const status = await js('document.querySelector("#popup-preview").contentDocument.querySelector("#status").className');
      extra(result, 'Uzantı paneli bağlantı durumunu doğru gösterdi', status === `status ${scenario.id === 'locked-vault' ? 'locked' : scenario.id === 'offline-app' ? 'disconnected' : 'connected'}`);
    }
    extra(result, 'Sayfa hatasız çalıştı', errors.length === 0, errors.join(' | '));
    const finalAudit = await js('LocKeepLab.audit()');
    result.finalObserved = finalAudit.observed; result.commands = finalAudit.commands;
    result.title = scenario.title;
    result.expected = scenario.expected;
    result.pass = result.checks.every(check => check.pass !== false);
    result.screenshot = await snapshot(scenario.id);
    report.scenarios.push(result);
    console.log(`${result.pass ? 'PASS' : 'GAP '} ${scenario.id}: ${result.checks.filter(check => check.pass === false).map(check => check.label).join('; ') || 'checked'}`);
  } finally { fixtureFrame = null; win.webContents.removeListener('console-message', onError); }
}
function writeReport() {
  report.summary = { total: report.scenarios.length, passed: report.scenarios.filter(item => item.pass).length,
    gaps: report.scenarios.filter(item => !item.pass).length, harnessErrors: report.harnessErrors.length };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  fs.writeFileSync(path.join(output, 'report.html'), `<!doctype html><html lang="tr"><meta charset="utf-8"><title>LocKeep Lab · Sonuçlar</title><style>body{font:14px system-ui;max-width:1100px;margin:40px auto;padding:0 25px;background:#f5f7f8;color:#273d49}h1{font-size:26px}section{background:white;border:1px solid #dbe4e8;border-radius:12px;margin:16px 0;padding:20px}summary{cursor:pointer;font-weight:600}.gap{color:#b04f49}.pass{color:#28846a}li{margin:8px 0}img{max-width:100%;border:1px solid #dde5e8;border-radius:8px}p{line-height:1.8;color:#738793}</style><h1>Tarayıcı test sonuçları</h1><p>${escape(report.generatedAt)} · ${escape(report.engine)}<br>${report.summary.total} senaryo: ${report.summary.passed} geçti, ${report.summary.gaps} geliştirme gerektiriyor, ${report.summary.harnessErrors} ortam hatası.<br>Bu sonuçlar gerçek uzantı sayfa kodunu örnek bir bağlantıyla test eder. Brave izinleri ve gerçek yerel bağlantı bu otomasyonun kapsamı dışındadır.</p>${report.harnessErrors.map(error => `<section class="gap">${escape(error)}</section>`).join('')}${report.scenarios.map(result => `<section><details ${result.pass ? '' : 'open'}><summary class="${result.pass ? 'pass' : 'gap'}">${result.pass ? '✓' : '×'} ${escape(result.title)}</summary><ul>${result.checks.map(check => `<li class="${check.pass === false ? 'gap' : 'pass'}">${check.pass === false ? '×' : check.pass === null ? '·' : '✓'} ${escape(check.label)}${check.detail ? ' — ' + escape(check.detail) : ''}</li>`).join('')}</ul><img loading="lazy" src="${escape(result.screenshot)}" alt="${escape(result.title)} ekran görüntüsü"></details></section>`).join('')}</html>`);
  console.log(JSON.stringify({ ...report.summary, report: path.join(output, 'report.html') }));
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  lab = await createLabServer({ port: Number(process.env.LOCKEEP_LAB_TEST_PORT || 4718) });
  win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true, preload: path.join(__dirname, 'preload.cjs') } });
  win.webContents.setFrameRate(60);
  win.webContents.debugger.attach('1.3');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const scenario of selectedCases) {
    try { await runScenario(scenario); }
    catch (error) { report.harnessErrors.push(`${scenario.id}: ${error.message}`); console.error(`HARNESS ${scenario.id}: ${error.message}`); }
  }
  if (!only) {
    win.setContentSize(1440, 1050); await win.loadURL(lab.url); await delay(450); await snapshot('dashboard');
  }
  writeReport(); win.destroy(); await lab.close();
  app.exit(report.summary.gaps || report.summary.harnessErrors ? 1 : 0);
}).catch(async error => { report.harnessErrors.push(error.message); writeReport(); if (win) win.destroy(); if (lab) await lab.close(); app.exit(1); });
