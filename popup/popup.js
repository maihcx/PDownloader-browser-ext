document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const t = (key, ...values) => PD.I18n.t(key, values.map(String));
  const M = PD.PopupModel;
  const paths = {
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4',
    expand: 'M14 3h7v7m0-7-9 9M10 3H3v18h18v-7',
    refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
    files: 'M7 3h10l4 4v14H7zM17 3v5h4M3 7v14',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    video: 'M3 5h18v14H3zM10 9l5 3-5 3z',
    audio: 'M9 17V5l11-2v12M9 5v5l11-2M9 17a3 3 0 1 1-3-3h3M20 15a3 3 0 1 1-3-3h3',
    document: 'M5 3h9l5 5v13H5zM14 3v6h5M9 13h6M9 17h6',
    copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
    check: 'M4 12l5 5L20 6',
    close: 'M6 6l12 12M18 6 6 18'
  };
  function icon(type) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('icon');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[type] || paths.files); svg.append(path);
    return svg;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function iconButton(type, label, handler) {
    const button = element('button', 'icon-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    button.append(icon(type)); button.addEventListener('click', handler); return button;
  }
  document.documentElement.lang = PDWebExt.i18n.getUILanguage();
  PD.I18n.applyToDom(document);
  document.querySelectorAll('[data-i18n-aria-label]').forEach(node => node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel)));
  document.querySelectorAll('[data-icon]').forEach(node => {
    node.append(icon(node.dataset.icon));
    if (node.tagName === 'BUTTON') node.setAttribute('aria-label', node.title);
  });
  $('version').textContent = `v${PDWebExt.runtime.getManifest().version}`;
  let currentTab = { id: -1, url: '', title: '' };
  let candidates = [], playback = null, selected = new Set(), visible = [];
  let filterType = 'all', connected = false, loading = false, batchBusy = false, settingsBusy = false, settingsReady = false;
  let settings = {}, feedbackTimer, refreshTimer, disposed = false, requestGeneration = 0, listError = '';
  const sent = new Set(), pending = new Set(), errors = new Map();
  const params = new URLSearchParams(location.search);
  const expanded = params.get('view') === 'expanded';
  document.documentElement.classList.toggle('expanded', expanded);
  document.body.classList.toggle('expanded', expanded);
  $('expandButton').hidden = expanded;

  // Callback form works with Chromium and Firefox through the existing adapter.
  function message(payload, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('popupRequestTimeout'))), timeout);
      try {
        PDWebExt.runtime.sendMessage(payload, response => {
          clearTimeout(timer);
          const error = PDWebExt.runtime.lastError;
          if (error || response == null) reject(new Error(t('popupBackgroundError')));
          else resolve(response);
        });
      } catch { clearTimeout(timer); reject(new Error(t('popupBackgroundError'))); }
    });
  }
  function feedback(text, error = false) {
    clearTimeout(feedbackTimer);
    $('feedback').textContent = text; $('feedback').className = `feedback${error ? ' error' : ''}`; $('feedback').hidden = false;
    if (!error) feedbackTimer = setTimeout(() => { $('feedback').hidden = true; }, 5000);
  }
  function connection(ok) {
    connected = !!ok;
    $('statusCard').className = `connection ${connected ? 'ok' : 'err'}`;
    $('statusText').textContent = t(connected ? 'popupConnected' : 'popupDisconnected');
    $('connectionHelp').hidden = connected;
    updateSelection();
  }
  async function checkConnection() {
    $('retryConnection').disabled = true;
    try { connection((await message({ action: 'ping_app' })).connected); if (connected) $('feedback').hidden = true; }
    catch (error) { connection(false); feedback(error.message, true); }
    finally { $('retryConnection').disabled = false; }
  }
  function switchTab(id, focus = false) {
    for (const key of ['files', 'settings']) {
      const active = id === key;
      $(`${key}Tab`).setAttribute('aria-selected', String(active)); $(`${key}Tab`).tabIndex = active ? 0 : -1;
      $(`${key}Panel`).hidden = !active;
    }
    if (focus) $(`${id}Tab`).focus();
  }
  for (const id of ['files', 'settings']) {
    $(`${id}Tab`).addEventListener('click', () => switchTab(id));
    $(`${id}Tab`).addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); switchTab(event.key === 'Home' ? 'files' : event.key === 'End' ? 'settings' : id === 'files' ? 'settings' : 'files', true);
      }
    });
  }

  function updateSelection() {
    const eligible = visible.filter(item => !sent.has(item.id));
    const count = eligible.filter(item => selected.has(item.id)).length;
    $('selectAll').checked = eligible.length > 0 && count === eligible.length;
    $('selectAll').indeterminate = count > 0 && count < eligible.length;
    $('selectAll').disabled = !eligible.length || batchBusy;
    $('selectionCount').textContent = t('popupSelectionCount', selected.size);
    $('downloadSelected').disabled = !connected || !selected.size || batchBusy || pending.size > 0;
    $('rescanButton').disabled = loading || batchBusy || currentTab.id < 0 || pending.size > 0;
    document.querySelectorAll('.media-item').forEach(row => {
      const id = row.dataset.id;
      row.classList.toggle('is-selected', selected.has(id));
      const checkbox = row.querySelector('input'); checkbox.checked = selected.has(id); checkbox.disabled = sent.has(id) || batchBusy || pending.has(id);
      row.querySelector('.media-download').disabled = !connected || batchBusy || pending.has(id) || sent.has(id);
    });
  }
  function render() {
    const focused = document.activeElement;
    const focusedRow = focused?.closest('.media-item');
    const focusId = focusedRow?.dataset.id;
    const focusAction = focused?.dataset.action;
    visible = M.filter(candidates, { query: $('searchInput').value, type: filterType, sort: $('sortOrder').value, title: currentTab.title });
    $('mediaCount').textContent = candidates.length;
    $('resultCount').textContent = t('popupResultCount', visible.length, candidates.length);
    const list = $('mediaList'); list.replaceChildren(); list.setAttribute('aria-busy', String(loading));
    if (!visible.length) {
      const empty = element('div', 'media-empty');
      const titleKey = loading ? 'popupScanning' : listError ? 'popupScanFailed' : !M.domain(currentTab.url) ? 'popupUnsupportedPage' : candidates.length ? 'popupNoMatches' : 'popupNoFiles';
      empty.append(icon('files'), element('strong', '', t(titleKey)), element('p', '', listError || t(candidates.length ? 'popupNoMatchesHelp' : 'popupEmptyHelp')));
      list.append(empty);
    }
    for (const item of visible) {
      const row = element('div', 'media-item'); row.dataset.id = item.id;
      const name = M.name(item, currentTab.title), category = M.category(item);
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', t('popupSelectFile', name));
      checkbox.dataset.action = 'select';
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); updateSelection(); });
      const emblem = element('div', `media-icon ${category}`); emblem.append(icon(category));
      const main = element('div', 'media-main'), heading = element('div', 'media-name', name); heading.title = name;
      const meta = element('div', 'media-meta');
      const format = (item.kind === 'hls' || item.kind === 'dash' ? item.kind : item.extension || category).toUpperCase();
      meta.append(element('span', 'format-badge', format), element('span', '', M.bytes(item.size) || t('popupUnknownSize')));
      const host = M.domain(item.url); if (host) { const origin = element('span', '', `· ${host}`); origin.title = item.url; meta.append(origin); }
      main.append(heading, meta);
      if (sent.has(item.id) || pending.has(item.id) || errors.has(item.id)) main.append(element('div', `item-status${errors.has(item.id) ? ' error' : ''}`, errors.get(item.id) || t(sent.has(item.id) ? 'popupSent' : 'popupSending')));
      const actions = element('div', 'item-actions');
      const copy = iconButton('copy', t('popupCopyLink', name), async () => {
        try { await navigator.clipboard.writeText(item.url); feedback(t('popupCopied')); }
        catch { feedback(t('popupCopyFailed'), true); }
      });
      const download = iconButton(sent.has(item.id) ? 'check' : 'download', t('popupSendFile', name), () => void sendOne(item)); download.classList.add('media-download');
      copy.dataset.action = 'copy'; download.dataset.action = 'send';
      actions.append(copy, download); row.append(checkbox, emblem, main, actions); list.append(row);
    }
    updateSelection();
    if (focusId && focusAction) {
      const row = [...list.children].find(node => node.dataset.id === focusId);
      const target = row?.querySelector(`[data-action="${focusAction}"]`);
      if (target && !target.disabled) target.focus({ preventScroll: true });
    }
  }

  async function sendOne(item) {
    if (pending.has(item.id) || sent.has(item.id)) return false;
    pending.add(item.id); errors.delete(item.id); render();
    try {
      const response = await message({
        action: 'download_media_candidate', tabId: currentTab.id, candidateId: item.id,
        mediaType: item.mediaType === 'audio' || (['hls', 'dash'].includes(item.kind) && playback?.playingAudio && !playback?.playingVideo) ? 'audio' : undefined
      }, 260000); // Covers the existing 120s media request plus one auth retry.
      if (!response.success) throw new Error(response.error || t('connErrorGeneric'));
      sent.add(item.id); selected.delete(item.id);
      if (!batchBusy) feedback(t('popupSent'));
      return true;
    } catch (error) {
      errors.set(item.id, error.message); if (!batchBusy) feedback(error.message, true); return false;
    } finally { pending.delete(item.id); render(); }
  }
  $('downloadSelected').addEventListener('click', async () => {
    if (batchBusy || !connected) return;
    // Freeze the explicitly selected set; filters never silently expand a batch.
    const queue = candidates.filter(item => selected.has(item.id) && !sent.has(item.id));
    batchBusy = true; let successful = 0;
    updateSelection();
    for (const item of queue) { if (disposed) break; if (await sendOne(item)) successful++; }
    batchBusy = false; render();
    feedback(t('popupBatchResult', successful, queue.length), successful !== queue.length);
  });
  $('selectAll').addEventListener('change', () => {
    for (const item of visible) { if (sent.has(item.id)) continue; if ($('selectAll').checked) selected.add(item.id); else selected.delete(item.id); }
    updateSelection();
  });
  $('searchInput').addEventListener('input', render); $('sortOrder').addEventListener('change', render);
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    filterType = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(node => node.setAttribute('aria-pressed', String(node === button))); render();
  }));

  async function resolveSourceTab() {
    try {
      if (expanded) {
        const id = Number(params.get('tab'));
        currentTab = params.has('tab') && Number.isInteger(id) && id >= 0 ? await PDWebExt.tabs.get(id) : { id: -1 };
      } else { [currentTab] = await PDWebExt.tabs.query({ active: true, currentWindow: true }); }
    } catch { currentTab = null; }
    currentTab ||= { id: -1, url: '', title: '' };
    $('pageDomain').textContent = M.domain(currentTab.url) || t('popupUnsupportedPage');
    $('pageTitle').textContent = currentTab.title || t('popupSourceClosed'); $('pageTitle').title = currentTab.title || '';
  }
  async function refresh(rescan = false) {
    if (loading || batchBusy || pending.size) return;
    loading = true; listError = ''; const generation = ++requestGeneration; render();
    try {
      const oldUrl = currentTab.url; await resolveSourceTab();
      if (oldUrl && oldUrl !== currentTab.url) { selected.clear(); sent.clear(); errors.clear(); candidates = []; }
      if (currentTab.id < 0 || !M.domain(currentTab.url)) { candidates = []; selected.clear(); return; }
      if (rescan) {
        // A restricted page or a tab awaiting reload may have no content receiver.
        try { await PDWebExt.tabs.sendMessage(currentTab.id, { action: 'pd_rescan_media' }); }
        catch { feedback(t('popupRescanHelp'), true); }
      }
      const response = await message({ action: 'get_media_candidates', tabId: currentTab.id, minScore: 45 });
      if (disposed || generation !== requestGeneration) return;
      candidates = (response.candidates || []).filter(item => !item.likelySegment && item.id && item.url).map(item => ({ ...item, id: String(item.id) }));
      playback = response.playback || null;
      const available = new Set(candidates.map(item => item.id)); selected = new Set([...selected].filter(id => available.has(id) && !sent.has(id)));
      if (rescan) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh(), 400); }
    } catch (error) { listError = error.message; feedback(error.message, true); }
    finally { loading = false; render(); if (settingsReady) void refreshSite(); }
  }
  $('rescanButton').addEventListener('click', () => void refresh(true));
  $('retryConnection').addEventListener('click', () => void checkConnection());
  $('expandButton').addEventListener('click', async () => {
    try { await PDWebExt.tabs.create({ url: `${PDWebExt.runtime.getURL('popup/popup.html')}?view=expanded&tab=${currentTab.id}` }); }
    catch { feedback(t('popupBackgroundError'), true); }
  });

  function settingsLock(locked) {
    settingsBusy = locked;
    for (const id of ['autoIntercept', 'showNotifications', 'minSize', 'extensionsInput', 'restoreRules', 'saveRules', 'domainInput', 'addDomain']) $(id).disabled = locked || !settingsReady;
    $('autoInterceptSite').disabled = true;
    $('blList').querySelectorAll('button').forEach(button => { button.disabled = locked || !settingsReady; });
  }
  async function refreshSite() {
    try {
      const status = await message({ action: 'get_site_status', url: currentTab.url });
      const parent = (settings.blacklistedDomains || []).find(domain => M.domain(currentTab.url).endsWith(`.${domain}`));
      let key = 'popupToggleAutoInterceptSiteSubDomain', value = status.domain || '';
      let enabled = settingsReady && !settingsBusy && !!M.domain(currentTab.url) && status.autoIntercept && !status.incompatible && !parent;
      if (!M.domain(currentTab.url)) key = 'popupToggleAutoInterceptSiteSubInvalid';
      else if (!status.autoIntercept) key = 'popupToggleAutoInterceptSiteSubGlobalOff';
      else if (status.incompatible) key = 'popupToggleAutoInterceptSiteSubIncompatible';
      else if (parent) { key = 'popupInheritedBlock'; value = parent; }
      $('autoInterceptSite').checked = !status.blacklisted && !!M.domain(currentTab.url) && !status.incompatible;
      $('autoInterceptSite').disabled = !enabled; $('autoInterceptSiteRow').classList.toggle('is-disabled', !enabled);
      $('autoInterceptSiteSub').textContent = t(key, value);
    } catch { $('autoInterceptSite').disabled = true; $('autoInterceptSiteSub').textContent = t('popupBackgroundError'); }
  }
  function renderBlacklist() {
    $('blList').replaceChildren(); const domains = settings.blacklistedDomains || [];
    if (!domains.length) $('blList').append(element('div', 'bl-empty', t('popupBlacklistEmpty')));
    for (const domain of [...domains].sort()) {
      const row = element('div', 'bl-item'); row.append(element('span', '', domain));
      row.append(iconButton('close', t('popupRemoveDomain', domain), () => void mutateSettings({ action: 'remove_blacklist', domain })));
      $('blList').append(row);
    }
  }
  async function mutateSettings(payload) {
    if (settingsBusy || !settingsReady) return false;
    settingsLock(true);
    try {
      const response = await message(payload); if (!response.success) throw new Error(t('popupSaveFailed'));
      settings = await message({ action: 'get_settings' }); renderBlacklist();
      $('autoIntercept').checked = settings.autoIntercept !== false; $('showNotifications').checked = settings.showNotifications !== false;
      feedback(t('popupSaved')); return true;
    } catch (error) {
      $('autoIntercept').checked = settings.autoIntercept !== false; $('showNotifications').checked = settings.showNotifications !== false;
      feedback(error.message, true); return false;
    } finally { settingsLock(false); await refreshSite(); }
  }
  for (const key of ['autoIntercept', 'showNotifications']) $(key).addEventListener('change', () => void mutateSettings({ action: 'save_settings', settings: { [key]: $(key).checked } }));
  $('autoInterceptSite').addEventListener('change', () => void mutateSettings({ action: $('autoInterceptSite').checked ? 'remove_blacklist' : 'add_blacklist', domain: M.domain(currentTab.url) }));
  $('captureForm').addEventListener('submit', async event => {
    event.preventDefault();
    const extensions = M.extensions($('extensionsInput').value), minSize = Number($('minSize').value);
    if (!extensions || !Number.isFinite(minSize) || minSize < 0 || minSize > 1048576) { feedback(t('popupInvalidRules'), true); return; }
    if (await mutateSettings({ action: 'save_settings', settings: { extensions, minInterceptSizeMb: minSize } })) $('extensionsInput').value = extensions.join(', ');
  });
  $('restoreRules').addEventListener('click', () => { $('minSize').value = PD.Constants.DEFAULT_SETTINGS.minInterceptSizeMb; $('extensionsInput').value = [...new Set(PD.Constants.DEFAULT_EXTENSIONS)].join(', '); feedback(t('popupDefaultsDraft')); });
  $('blacklistForm').addEventListener('submit', async event => {
    event.preventDefault(); const domain = M.normalizeDomain($('domainInput').value);
    if (!domain) { feedback(t('popupInvalidDomain'), true); return; }
    if (await mutateSettings({ action: 'add_blacklist', domain })) $('domainInput').value = '';
  });
  function applyTheme(value) { const theme = ['light', 'dark'].includes(value) ? value : 'system'; document.documentElement.dataset.theme = theme; $('themeSelect').value = theme; }
  $('themeSelect').addEventListener('change', async () => {
    const previous = document.documentElement.dataset.theme; applyTheme($('themeSelect').value);
    try { await PDWebExt.storage.local.set({ popupTheme: $('themeSelect').value }); }
    catch { applyTheme(previous); feedback(t('popupSaveFailed'), true); }
  });
  window.addEventListener('pagehide', () => { disposed = true; clearTimeout(refreshTimer); clearTimeout(feedbackTimer); });

  async function init() {
    render();
    void PDWebExt.storage.local.get(['popupTheme']).then(data => applyTheme(data.popupTheme)).catch(() => {});
    // Media discovery does not wait for the desktop app to respond.
    void refresh();
    try {
      const response = await message({ action: 'get_popup_init' }); connection(response.connected);
      settings = response.settings || {}; settingsReady = true;
      $('badgeCount').textContent = t('popupRecentCaught', response.interceptCount || 0);
      // Acknowledge the badge only after its count has been read.
      void message({ action: 'reset_badge' }).catch(() => {});
      $('autoIntercept').checked = settings.autoIntercept !== false; $('showNotifications').checked = settings.showNotifications !== false;
      $('minSize').value = settings.minInterceptSizeMb ?? PD.Constants.DEFAULT_SETTINGS.minInterceptSizeMb;
      $('extensionsInput').value = (settings.extensions || [...new Set(PD.Constants.DEFAULT_EXTENSIONS)]).join(', ');
      renderBlacklist(); settingsLock(false); await refreshSite();
    } catch (error) { connection(false); feedback(error.message, true); }
  }
  void init();
});
