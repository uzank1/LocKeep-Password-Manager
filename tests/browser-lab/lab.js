(() => {
  'use strict';
  const catalog = window.LAB_CATALOG;
  const element = id => document.getElementById(id);
  const frame = element('scenarioFrame');
  let selected = catalog.cases.find(item => item.id === new URLSearchParams(location.search).get('case')) || catalog.cases[0];
  let group = selected.group;
  let result = null;
  let diagnostic = null;
  let session = '';
  const defaultProfiles = { 'empty-vault': 'empty', 'locked-vault': 'locked', 'offline-app': 'offline',
    'slow-connection': 'slow', 'recover-connection': 'offline' };
  window.getActiveLab = () => { try { return frame.contentWindow.LocKeepLab; } catch { return null; } };
  element('scenarioCount').textContent = catalog.cases.length;
  function renderGroups() {
    element('groups').replaceChildren();
    for (const [id, title] of Object.entries(catalog.groups)) {
      const button = document.createElement('button'); button.className = 'group-button' + (id === group ? ' active' : '');
      button.textContent = title;
      const count = document.createElement('span'); count.textContent = catalog.cases.filter(item => item.group === id).length;
      button.append(count); button.onclick = () => { group = id; renderGroups(); renderList(); }; element('groups').append(button);
    }
  }
  function renderList() {
    element('scenarioList').replaceChildren();
    const query = element('search').value.trim().toLocaleLowerCase('tr');
    const visible = catalog.cases.filter(item => (query || item.group === group) && `${item.title} ${item.description}`.toLocaleLowerCase('tr').includes(query));
    for (const scenario of visible) {
      const button = document.createElement('button'); button.className = 'scenario-button' + (scenario.id === selected.id ? ' active' : '');
      button.textContent = scenario.title; button.onclick = () => { selected = scenario; group = scenario.group; element('profile').value = defaultProfiles[selected.id] || 'available'; renderGroups(); renderList(); load(); };
      element('scenarioList').append(button);
    }
    if (!visible.length) element('scenarioList').textContent = 'Bu arama için senaryo bulunamadı.';
  }
  function load() {
    session = `${Date.now()}-${catalog.cases.indexOf(selected)}`;
    result = null; diagnostic = null;
    element('checks').replaceChildren(); element('diagnosticReport').hidden = true; element('export').disabled = true;
    element('verdict').textContent = 'Alanlarla etkileşime gir, sonra kontrol et.';
    element('categoryLabel').textContent = catalog.groups[selected.group].toLocaleUpperCase('tr');
    element('scenarioTitle').textContent = selected.title; element('scenarioDescription').textContent = selected.description;
    element('expectations').replaceChildren(...selected.expected.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
    const target = new URL(selected.path, location.href);
    target.searchParams.set('session', session); target.searchParams.set('profile', element('profile').value);
    target.searchParams.set('lang', element('language').value); target.searchParams.set('theme', element('theme').value);
    frame.src = target.href;
    target.searchParams.set('mode', 'native'); element('nativeLink').href = target.href;
    history.replaceState(null, '', '/?case=' + selected.id);
    element('popupPane').hidden = true; element('popupFrame').removeAttribute('src');
    setWidth();
  }
  function setWidth() { frame.style.width = element('width').value === 'wide' ? '100%' : element('width').value + 'px'; frame.style.flexShrink = '0'; }
  element('search').oninput = renderList;
  for (const id of ['profile', 'language', 'theme']) element(id).onchange = load;
  element('width').onchange = setWidth; element('reload').onclick = load;
  element('popupButton').onclick = () => {
    if (!window.getActiveLab()) return;
    element('popupPane').hidden = !element('popupPane').hidden;
    if (!element('popupPane').hidden) element('popupFrame').src = '/popup.html';
  };
  element('recover').onclick = () => { window.getActiveLab()?.setProfile('available'); element('verdict').textContent = 'Bağlantı açık. Önbellek ile yeni sorguyu karşılaştırmak için teşhis raporunu aç.'; };
  element('audit').onclick = () => {
    const lab = window.getActiveLab(); if (!lab) { element('verdict').textContent = 'Örnek sayfa henüz hazır değil.'; return; }
    result = lab.audit(); element('checks').replaceChildren();
    for (const check of result.checks) {
      const li = document.createElement('li'); li.textContent = check.label + (check.detail ? ' · ' + check.detail : ''); li.dataset.pass = String(check.pass); element('checks').append(li);
    }
    const failures = result.checks.filter(check => check.pass === false).length;
    element('verdict').textContent = failures ? `${failures} kontrol geliştirme gerektiriyor.` : 'Kontrol edilen davranışlarda engel görülmedi. Etkileşim adımlarını da tamamla.';
    element('export').disabled = false;
  };
  element('diagnose').onclick = async () => {
    const response = await window.getActiveLab()?.requestDiagnostics();
    diagnostic = response?.report || { findings: ['simulation_not_ready'] };
    element('diagnosticReport').textContent = JSON.stringify(diagnostic, null, 2); element('diagnosticReport').hidden = false;
  };
  element('export').onclick = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), result, diagnostic }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `lockeep-lab-${selected.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  element('profile').value = defaultProfiles[selected.id] || 'available';
  renderGroups(); renderList(); load();
})();
