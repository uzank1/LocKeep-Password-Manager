/**
 * ============================================================================
 * LOCKEEP PASSWORD MANAGER — Main App Controller (Renderer)
 * ============================================================================
 * Orchestrates all UI views, event handling, and communication with the
 * main process via the preload bridge (window.vault).
 *
 * NOTE: No Node.js APIs available here — contextIsolation is enforced.
 *       All operations go through window.vault.* IPC methods.
 * ============================================================================
 */

'use strict';

// ─── Globals ────────────────────────────────────────────────────────────────

let currentView = 'passwords';
let allEntries = [];

// ─── DOM References ─────────────────────────────────────────────────────────

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const lockScreen      = $('#lock-screen');
const appContainer    = $('#app');
const lockForm        = $('#lock-form');
const masterPwInput   = $('#master-password');
const confirmPwGroup  = $('#confirm-pw-group');
const confirmPwInput  = $('#confirm-password');
const lockBtn         = $('#lock-btn');
const lockError       = $('#lock-error');
const searchInput     = $('#search-input');
const entryList       = $('#entry-list');
const emptyState      = $('#empty-state');
const entryCount      = $('#entry-count');
const modalContainer  = $('#modal-container');
const toastContainer  = $('#toast-container');
const pwRequirements  = $('#pw-requirements');
const zkWarning       = $('#zk-warning');
const lockLanguageSelect = $('#lock-language-select');

// ─── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize i18n — translations are embedded, so this is synchronous-safe
  await I18n.initialize();
  syncLanguageControls();

  const exists = await vault.exists();

  if (!exists) {
    // Show vault creation mode
    confirmPwGroup.classList.remove('hidden');
    pwRequirements.classList.remove('hidden');
    zkWarning.classList.remove('hidden');
    lockBtn.textContent = I18n.t('lock.create');
    lockBtn.setAttribute('data-mode', 'create');
  } else {
    lockBtn.setAttribute('data-mode', 'unlock');
  }

  // Check if already unlocked (e.g. hot reload in dev)
  if (await vault.isUnlocked()) {
    showApp();
  }

  setupEventListeners();
  setupActivityReporting();
  setupMainProcessListeners();
});

// ─── Event Listeners ────────────────────────────────────────────────────────

function syncLanguageControls() {
  const lang = I18n.getCurrentLanguage();
  // The first-run picker and the Settings picker represent the same stored
  // preference, so keep them visually in step whenever either one changes.
  [lockLanguageSelect, $('#language-select')].forEach(select => {
    if (select) select.value = lang;
  });
}

function handleLanguageChange(e) {
  I18n.setLanguage(e.target.value);
  syncLanguageControls();
}

function setupEventListeners() {
  // Lock form submit
  lockForm.addEventListener('submit', handleLockSubmit);

  // Real-time password validation during vault creation
  masterPwInput.addEventListener('input', validateMasterPassword);

  // Lock vault button
  $('#lock-vault-btn').addEventListener('click', handleLockVault);

  // Navigation
  $$('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Add entry buttons
  $('#add-entry-btn').addEventListener('click', () => showEntryModal());
  $('#empty-add-btn').addEventListener('click', () => showEntryModal());

  // Search
  searchInput.addEventListener('input', handleSearch);

  // Generator (simplified)
  $('#gen-generate-btn').addEventListener('click', handleGenerate);
  $('#gen-copy-btn').addEventListener('click', handleGenCopy);

  // Import / Export
  $('#import-btn').addEventListener('click', handleImport);
  $('#export-btn').addEventListener('click', handleExport);

  // Browser Integration Drag and Drop
  const dragBox = $('#extension-drag-box');
  if (dragBox) {
    dragBox.addEventListener('dragstart', (e) => {
      e.preventDefault();
      vault.startExtensionDrag();
    });
  }

  // Settings
  if (lockLanguageSelect) lockLanguageSelect.addEventListener('change', handleLanguageChange);
  $('#language-select').addEventListener('change', handleLanguageChange);
  $('#autolock-select').addEventListener('change', handleAutoLockChange);
  $('#start-with-windows-checkbox').addEventListener('change', handleStartWithWindowsChange);
  $('#change-vault-path-btn').addEventListener('click', handleChangeVaultPath);
  $('#reset-vault-path-btn').addEventListener('click', handleResetVaultPath);
  $('#change-pw-btn').addEventListener('click', handleChangeMasterPassword);
}

function setupActivityReporting() {
  // P-07: Use throttle (not debounce) at 30s with pointerdown (not mousemove)
  const report = () => { if (vault.reportActivity) vault.reportActivity(); };
  let _lastReport = 0;
  const throttledReport = () => {
    const now = Date.now();
    if (now - _lastReport >= 30000) {
      _lastReport = now;
      report();
    }
  };
  document.addEventListener('pointerdown', throttledReport, { passive: true });
  document.addEventListener('keydown', throttledReport, { passive: true });
}

function setupMainProcessListeners() {
  vault.onVaultLocked(() => {
    showLockScreen();
    showToast(I18n.t('nav.lock'), 'info');
  });

  if (vault.onVaultUpdated) {
    vault.onVaultUpdated(async () => {
      await loadEntries();
    });
  }

  vault.onClipboardCopied((data) => {
    showToast(I18n.t('clipboard.copied', { label: data.label }), 'success');
  });

  vault.onClipboardCleared(() => {
    showToast(I18n.t('clipboard.cleared'), 'info');
  });
}

// ─── Master Password Validation ─────────────────────────────────────────────

/**
 * Validates the master password in real-time during vault creation.
 * Updates the requirements checklist with pass/fail icons.
 */
function validateMasterPassword() {
  const mode = lockBtn.getAttribute('data-mode');
  if (mode !== 'create') return;

  const pw = masterPwInput.value;

  const checks = {
    'req-length':  pw.length >= 14,
    'req-upper':   /[A-Z]/.test(pw),
    'req-lower':   /[a-z]/.test(pw),
    'req-number':  /[0-9]/.test(pw),
    'req-special': /[^A-Za-z0-9]/.test(pw)
  };

  let passed = 0;
  for (const [id, met] of Object.entries(checks)) {
    const li = document.getElementById(id);
    if (!li) continue;
    const icon = li.querySelector('.req-icon');
    if (met) {
      li.classList.add('met');
      icon.textContent = '\u2705';
      passed++;
    } else {
      li.classList.remove('met');
      icon.textContent = '\u274C';
    }
  }

  // Update strength bar
  const bar = $('#pw-strength-bar');
  if (bar) {
    // Use CSS classes rather than inline styles so the lock screen keeps the
    // same strict CSP as the rest of the renderer.
    bar.className = 'strength-bar-fill';
    if (passed > 0) bar.classList.add(`strength-level-${passed}`);
  }

  return passed === 5;
}

/**
 * Returns true if the master password meets all strict requirements.
 */
function isPasswordValid(pw) {
  return pw.length >= 14 &&
         /[A-Z]/.test(pw) &&
         /[a-z]/.test(pw) &&
         /[0-9]/.test(pw) &&
         /[^A-Za-z0-9]/.test(pw);
}

// ─── Lock / Unlock ──────────────────────────────────────────────────────────

async function handleLockSubmit(e) {
  e.preventDefault();
  const mode = lockBtn.getAttribute('data-mode');
  const password = masterPwInput.value;

  lockError.classList.add('hidden');
  lockBtn.disabled = true;
  lockBtn.textContent = mode === 'create' ? I18n.t('lock.creating') : I18n.t('lock.unlocking');

  if (mode === 'create') {
    // Enforce strict password policy
    if (!isPasswordValid(password)) {
      showLockError(I18n.t('lock.minLength'));
      return;
    }
    if (password !== confirmPwInput.value) {
      showLockError(I18n.t('lock.passwordMismatch'));
      return;
    }
    // The language picker is available before the vault exists, so persist the
    // final choice right before creation in case the user changes it and clicks
    // Create immediately afterward.
    await vault.saveSettings({ language: I18n.getCurrentLanguage() });
    const result = await vault.create(password);
    if (result.success) {
      showToast(I18n.t('lock.vaultCreated'), 'success');
      showApp();
    } else {
      showLockError(result.message);
    }
  } else {
    const result = await vault.unlock(password);
    if (result.success) {
      showApp();
    } else {
      showLockError(I18n.t('lock.wrongPassword'));
    }
  }
}

function showLockError(msg) {
  lockError.textContent = msg;
  lockError.classList.remove('hidden');
  lockBtn.disabled = false;
  lockBtn.textContent = lockBtn.getAttribute('data-mode') === 'create'
    ? I18n.t('lock.create') : I18n.t('lock.unlock');
}

async function handleLockVault() {
  await vault.lock();
  showLockScreen();
}

function showLockScreen() {
  appContainer.classList.add('hidden');
  lockScreen.classList.remove('hidden');
  masterPwInput.value = '';
  confirmPwInput.value = '';
  lockBtn.disabled = false;
  lockBtn.textContent = I18n.t('lock.unlock');
  lockBtn.setAttribute('data-mode', 'unlock');
  confirmPwGroup.classList.add('hidden');
  pwRequirements.classList.add('hidden');
  zkWarning.classList.add('hidden');
  lockError.classList.add('hidden');
  allEntries = [];
  masterPwInput.focus();
}

async function showApp() {
  lockScreen.classList.add('hidden');
  appContainer.classList.remove('hidden');
  masterPwInput.value = '';
  confirmPwInput.value = '';
  await loadEntries();
  await loadSettings();
  await loadExportTargets();
}

// ─── Entry List ─────────────────────────────────────────────────────────────

async function loadEntries() {
  const result = await vault.getEntries();
  if (result.success) {
    allEntries = result.entries;
    renderEntries(allEntries);
  }
}

function renderEntries(entries) {
  entryList.innerHTML = '';

  if (entries.length === 0) {
    emptyState.classList.remove('hidden');
    entryCount.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  entryCount.classList.remove('hidden');
  entryCount.textContent = I18n.t('vault.totalEntries', { count: entries.length });

  // Sort: favorites first, then alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.favorite && !b.favorite) return -1;
    if (!a.favorite && b.favorite) return 1;
    return (a.title || '').localeCompare(b.title || '');
  });

  // P-06: Use DocumentFragment for batched DOM insertion
  const fragment = document.createDocumentFragment();

  for (const entry of sorted) {
    const card = document.createElement('div');
    card.className = 'entry-card';
    card.dataset.id = entry.id;

    const initial = (entry.title || entry.url || '?')[0].toUpperCase();
    // Imported vault data is still user-controlled, so the card is built with
    // textContent instead of an HTML template.
    const favicon = document.createElement('div');
    favicon.className = 'entry-favicon';
    favicon.textContent = initial;

    const info = document.createElement('div');
    info.className = 'entry-info';

    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entry.title || 'Untitled';

    const subtitle = document.createElement('div');
    subtitle.className = 'entry-subtitle';
    subtitle.textContent = entry.username || entry.url || '';

    info.append(title, subtitle);
    card.append(favicon, info);

    if (entry.favorite) {
      const favorite = document.createElement('span');
      favorite.className = 'entry-fav';
      favorite.textContent = '\u2605';
      card.appendChild(favorite);
    }

    card.addEventListener('click', () => showEntryDetail(entry.id));
    fragment.appendChild(card);
  }

  entryList.appendChild(fragment);
}

function handleSearch() {
  const query = searchInput.value.toLowerCase().trim();
  if (!query) {
    renderEntries(allEntries);
    return;
  }
  const filtered = allEntries.filter(e =>
    (e.title || '').toLowerCase().includes(query) ||
    (e.username || '').toLowerCase().includes(query) ||
    (e.url || '').toLowerCase().includes(query)
  );
  renderEntries(filtered);
}

// ─── Entry Detail Modal ─────────────────────────────────────────────────────

async function showEntryDetail(id) {
  const result = await vault.getEntry(id);
  if (!result.success) return;
  const entry = result.entry;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${escapeHtml(entry.title || 'Entry Details')}</h3>
        <button class="btn btn-icon btn-secondary" id="modal-close">\u2715</button>
      </div>
      <div class="modal-body">
        <div class="input-group">
          <label>${I18n.t('entry.username')}</label>
          <div class="flex-row-sm">
            <input type="text" value="${escapeAttr(entry.username)}" readonly class="flex-1">
            <button class="btn btn-secondary btn-sm" data-copy="username">${I18n.t('entry.copyUsername')}</button>
          </div>
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.password')} <small class="detail-pw-hint">(${I18n.t('entry.hoverToReveal')})</small></label>
          <div class="password-display">
            <span class="password-masked" id="pw-display" data-pw="${escapeAttr(entry.password)}">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</span>
            <button class="btn btn-secondary btn-sm" data-copy="password">${I18n.t('entry.copyPassword')}</button>
          </div>
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.url')}</label>
          <input type="text" value="${escapeAttr(entry.url)}" readonly>
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.notes')}</label>
          <textarea readonly>${escapeHtml(entry.notes || '')}</textarea>
        </div>
        <div class="text-meta">
          ${I18n.t('entry.createdAt')}: ${new Date(entry.createdAt).toLocaleString()}<br>
          ${I18n.t('entry.updatedAt')}: ${new Date(entry.updatedAt).toLocaleString()}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger btn-sm" id="modal-delete">${I18n.t('entry.delete')}</button>
        <button class="btn btn-secondary btn-sm" id="modal-edit">${I18n.t('entry.edit')}</button>
      </div>
    </div>
  `;

  modalContainer.appendChild(modal);

  // Password hover reveal
  const pwDisplay = modal.querySelector('#pw-display');
  pwDisplay.addEventListener('mouseenter', () => { pwDisplay.textContent = entry.password; });
  pwDisplay.addEventListener('mouseleave', () => { pwDisplay.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'; });

  // Copy buttons
  modal.querySelector('[data-copy="username"]').addEventListener('click', () => {
    vault.copyToClipboard(entry.username, I18n.t('entry.username'));
  });
  modal.querySelector('[data-copy="password"]').addEventListener('click', () => {
    vault.copyToClipboard(entry.password, I18n.t('entry.password'));
  });

  // Close
  modal.querySelector('#modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Delete
  modal.querySelector('#modal-delete').addEventListener('click', async () => {
    if (confirm(I18n.t('entry.deleteConfirm'))) {
      await vault.deleteEntry(id);
      modal.remove();
      await loadEntries();
      showToast(I18n.t('common.success'), 'success');
    }
  });

  // Edit
  modal.querySelector('#modal-edit').addEventListener('click', () => {
    modal.remove();
    showEntryModal(entry);
  });
}

// ─── Add / Edit Entry Modal ─────────────────────────────────────────────────

function showEntryModal(existingEntry = null) {
  const isEdit = !!existingEntry;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${isEdit ? I18n.t('entry.edit') : I18n.t('vault.addNew')}</h3>
        <button class="btn btn-icon btn-secondary" id="modal-close">\u2715</button>
      </div>
      <div class="modal-body">
        <div class="input-group">
          <label>${I18n.t('entry.title')}</label>
          <input type="text" id="edit-title" value="${escapeAttr(existingEntry?.title || '')}">
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.username')}</label>
          <input type="text" id="edit-username" value="${escapeAttr(existingEntry?.username || '')}">
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.password')}</label>
          <div class="flex-row-sm">
            <input type="password" id="edit-password" value="${escapeAttr(existingEntry?.password || '')}" class="flex-1">
            <button class="btn btn-secondary btn-sm" id="edit-gen-pw">\u26A1</button>
          </div>
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.url')}</label>
          <input type="url" id="edit-url" value="${escapeAttr(existingEntry?.url || '')}">
        </div>
        <div class="input-group">
          <label>${I18n.t('entry.notes')}</label>
          <textarea id="edit-notes">${escapeHtml(existingEntry?.notes || '')}</textarea>
        </div>
        <label class="favorite-label">
          <input type="checkbox" id="edit-favorite" ${existingEntry?.favorite ? 'checked' : ''}> ${I18n.t('entry.favorite')}
        </label>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modal-cancel">${I18n.t('entry.cancel')}</button>
        <button class="btn btn-primary" id="modal-save">${I18n.t('entry.save')}</button>
      </div>
    </div>
  `;

  modalContainer.appendChild(modal);

  // Generate password in edit modal (uses secure defaults)
  modal.querySelector('#edit-gen-pw').addEventListener('click', async () => {
    const result = await vault.generatePassword({ length: 20, uppercase: true, lowercase: true, digits: true, symbols: true });
    if (result && result.password) {
      modal.querySelector('#edit-password').value = result.password;
      modal.querySelector('#edit-password').type = 'text';
      setTimeout(() => { modal.querySelector('#edit-password').type = 'password'; }, 2000);
    }
  });

  // Save
  modal.querySelector('#modal-save').addEventListener('click', async () => {
    const data = {
      title:    modal.querySelector('#edit-title').value,
      username: modal.querySelector('#edit-username').value,
      password: modal.querySelector('#edit-password').value,
      url:      modal.querySelector('#edit-url').value,
      notes:    modal.querySelector('#edit-notes').value,
      favorite: modal.querySelector('#edit-favorite').checked
    };

    let result;
    if (isEdit) {
      result = await vault.updateEntry(existingEntry.id, data);
    } else {
      result = await vault.addEntry(data);
    }

    if (result.success) {
      modal.remove();
      await loadEntries();
      showToast(I18n.t('common.success'), 'success');
    } else {
      showToast(result.message || I18n.t('common.error'), 'error');
    }
  });

  modal.querySelector('#modal-cancel').addEventListener('click', () => modal.remove());
  modal.querySelector('#modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ─── Password Generator (Simplified) ────────────────────────────────────────

async function handleGenerate() {
  // Use hardcoded secure defaults: 20 chars, all charsets
  const result = await vault.generatePassword({
    length: 20,
    uppercase: true,
    lowercase: true,
    digits: true,
    symbols: true
  });

  if (result && result.password) {
    $('#gen-output').textContent = result.password;
    $('#gen-output').removeAttribute('data-i18n');
  }
}

function handleGenCopy() {
  const pw = $('#gen-output').textContent;
  const placeholder = I18n.t('generator.placeholder');
  if (pw && pw !== placeholder) {
    vault.copyToClipboard(pw, 'Password');
  }
}

// ─── Import / Export ────────────────────────────────────────────────────────

async function handleImport() {
  const result = await vault.importPasswords();
  if (result.success) {
    showToast(I18n.t('import.success', { count: result.imported }), 'success');
    await loadEntries();
  } else if (result.message !== 'Import cancelled.') {
    showToast(result.message || I18n.t('import.error'), 'error');
  }
}

async function loadExportTargets() {
  const targets = await vault.getExportTargets();
  const select = $('#export-format');
  select.innerHTML = '';
  for (const t of targets) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
}

async function handleExport() {
  const format = $('#export-format').value;
  const result = await vault.exportPasswords(format);
  if (result.success) {
    showToast(result.message || I18n.t('common.success'), 'success');
  } else if (result.message !== 'Export cancelled.') {
    showToast(result.message || I18n.t('export.error'), 'error');
  }
}

// ─── Settings ───────────────────────────────────────────────────────────────

async function loadSettings() {
  const settings = await vault.getSettings();
  if (settings.language) {
    if (settings.language !== I18n.getCurrentLanguage()) {
      I18n.setLanguage(settings.language);
    }
  }
  syncLanguageControls();
  if (settings.autoLockMinutes !== undefined) {
    $('#autolock-select').value = String(settings.autoLockMinutes);
  }
  $('#start-with-windows-checkbox').checked = settings.startWithWindows !== false;
  const vaultPath = settings.vaultPath || '%APPDATA%/LocKeepPasswordManager/vault.dat';
  $('#vault-path-display').textContent = vaultPath;
}

async function handleAutoLockChange(e) {
  const minutes = parseInt(e.target.value, 10);
  await vault.setAutoLockTimeout(minutes);
  showToast(I18n.t('common.success'), 'success');
}

async function handleStartWithWindowsChange(e) {
  const checkbox = e.target;
  const requestedState = checkbox.checked;
  checkbox.disabled = true;

  try {
    const result = await vault.setStartWithWindows(requestedState);
    if (!result || !result.success) {
      checkbox.checked = result && typeof result.enabled === 'boolean'
        ? result.enabled
        : !requestedState;
      showToast((result && result.message) || I18n.t('common.error'), 'error');
      return;
    }

    checkbox.checked = result.enabled;
    showToast(I18n.t('common.success'), 'success');
  } catch {
    checkbox.checked = !requestedState;
    showToast(I18n.t('common.error'), 'error');
  } finally {
    checkbox.disabled = false;
  }
}

async function handleChangeVaultPath() {
  const result = await vault.setVaultPath();
  if (result.success) {
    $('#vault-path-display').textContent = result.path;
    showToast(I18n.t('common.success'), 'success');
  }
}

async function handleResetVaultPath() {
  await vault.resetVaultPath();
  $('#vault-path-display').textContent = '%APPDATA%/LocKeepPasswordManager/vault.dat';
  showToast(I18n.t('common.success'), 'success');
}

async function handleChangeMasterPassword() {
  const current = $('#current-master-pw').value;
  const newPw = $('#new-master-pw').value;
  const confirmVal = $('#confirm-new-master-pw').value;

  if (!current || !newPw) return showToast(I18n.t('common.error'), 'error');
  if (newPw !== confirmVal) return showToast(I18n.t('lock.passwordMismatch'), 'error');
  if (!isPasswordValid(newPw)) return showToast(I18n.t('lock.minLength'), 'error');

  const result = await vault.changeMasterPassword(current, newPw);
  if (result.success) {
    showToast(I18n.t('common.success'), 'success');
    $('#current-master-pw').value = '';
    $('#new-master-pw').value = '';
    $('#confirm-new-master-pw').value = '';
  } else {
    showToast(result.message, 'error');
  }
}

// ─── View Navigation ────────────────────────────────────────────────────────

function switchView(view) {
  currentView = view;
  $$('.view-panel').forEach(p => p.classList.remove('active'));
  $(`#view-${view}`).classList.add('active');
  $$('.nav-item[data-view]').forEach(b => b.classList.remove('active'));
  $(`.nav-item[data-view="${view}"]`).classList.add('active');
}

// ─── Toast Notifications ────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
