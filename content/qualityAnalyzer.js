(function (root) {
  const PD = root.PD || (root.PD = {});
  if (PD.QualityAnalyzer) return;

  const CACHE_TTL = 5 * 60 * 1000;
  const cache = new Map();
  const pending = new Map();

  // Use the same preference as the main popup. Scope it to extension-owned
  // roots, including portaled menus/toasts; never change the website's theme.
  const themeRoots = new Set();
  let themePreference = 'system', themeStarted = false, themeRevision = 0;
  function applyPreference(value) {
    themePreference = ['light', 'dark'].includes(value) ? value : 'system';
    for (const element of themeRoots) element.dataset.pdTheme = themePreference;
  }
  function trackTheme(element) {
    element.dataset.pdTheme = themePreference; themeRoots.add(element);
    if (!themeStarted) {
      themeStarted = true;
      const storage = PDWebExt.storage;
      const revision = themeRevision;
      try {
        storage?.onChanged?.addListener?.((changes, area) => {
          if (area === 'local' && Object.hasOwn(changes, 'popupTheme')) {
            themeRevision++; applyPreference(changes.popupTheme.newValue);
          }
        });
        Promise.resolve(storage?.local?.get?.(['popupTheme'])).then(data => {
          if (revision === themeRevision) applyPreference(data?.popupTheme);
        }).catch(() => {});
      } catch (_) { /* System preference remains usable when storage is unavailable. */ }
    }
    return element;
  }
  function untrackTheme(element) { themeRoots.delete(element); }

  function ensureTheme() {
    if (document.querySelector('link[data-pd-theme="1"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = PDWebExt.runtime.getURL('common/theme.css');
    link.dataset.pdTheme = '1';
    (document.head || document.documentElement).appendChild(link);
  }

  function ensureStyle() {
    if (document.getElementById('pd-quality-style')) return;
    const link = document.createElement('link');
    link.id = 'pd-quality-style'; link.rel = 'stylesheet';
    link.href = PDWebExt.runtime.getURL('common/videoControls.css');
    (document.head || document.documentElement).appendChild(link);
  }

  const ICONS = {
    download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
    close: 'M6 6l12 12M18 6 6 18',
    pip: 'M3 4h18v15H3zM12 11h7v6h-7z',
    more: 'M12 4v1m0 6v1m0 6v1',
    video: 'M3 5h18v14H3zM10 9l5 3-5 3z',
    image: 'M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M16 7h.01',
    audio: 'M9 17V5l11-2v12M9 17a3 3 0 1 1-3-3h3M20 15a3 3 0 1 1-3-3h3'
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('pd-quality-svg');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', ICONS[name] || ICONS.download); svg.append(path); return svg;
  }
  function node(tag, cls, text) {
    const item = document.createElement(tag); item.className = cls;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function layerHost(panel) {
    const fullscreen = document.fullscreenElement;
    if (fullscreen?.contains(panel)) return fullscreen;
    try { const overlay = panel.closest('dialog[open], :popover-open'); if (overlay) return overlay; } catch (_) {}
    return document.body || document.documentElement;
  }
  function placeLayer(layer, panel, alignment = 'left') {
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    const viewportHeight = innerHeight;
    const rect = panel.getBoundingClientRect();
    const width = Math.min(layer.offsetWidth || 360, viewportWidth - 16);
    const height = Math.min(layer.offsetHeight || 150, viewportHeight - 16);
    const preferredLeft = alignment === 'right' ? rect.right - width : rect.left;
    const left = Math.min(Math.max(8, preferredLeft), Math.max(8, viewportWidth - width - 8));
    const below = viewportHeight - rect.bottom - 16, above = rect.top - 16;
    const openAbove = below < Math.min(height, 180) && above > below;
    layer.style.maxHeight = Math.max(0, Math.min(440, openAbove ? above : below)) + 'px';
    layer.style.left = Math.round(left) + 'px';
    layer.style.top = Math.round(openAbove ? Math.max(8, rect.top - height - 8) : Math.max(8, rect.bottom + 8)) + 'px';
  }

  function sanitizeName(value, fallback = 'video') {
    return PD.MediaTitle?.sanitize(value, fallback, 100) || fallback;
  }

  function getCacheKey(context) {
    return String(context?.cacheKey || context?.url || '').trim();
  }

  async function analyze(context, force = false) {
    const url = String(context?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { success: false, error: PD.I18n.t('ytCannotAnalyze') };
    }

    const key = getCacheKey(context);
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
    if (!force && pending.has(key)) return pending.get(key);

    const request = (async () => {
      const urls = [...new Set([url, context?.mediaUrl].filter(value => /^https?:\/\//i.test(value || '')))];
      let result;
      for (const analysisUrl of urls) {
        try {
          result = await PDWebExt.runtime.sendMessage({
            action: 'analyze_media', url: analysisUrl,
            referer: context?.referer || location.href,
            headers: context?.headers || undefined
          });
        } catch (error) {
          // A failed page extractor must not prevent trying this element's
          // own HTTP source. Never substitute another player's candidate.
          result = { success: false, error: error?.message || PD.I18n.t('ytCannotAnalyze') };
        }
        if (result?.success && result.formats?.length) return { ...result, analysisUrl };
      }
      return result;
    })().then(data => {
      if (data?.success && pending.get(key) === request) cache.set(key, { time: Date.now(), data });
      return data;
    }).finally(() => { if (pending.get(key) === request) pending.delete(key); });

    pending.set(key, request);
    return request;
  }

  function candidateFromContext(context) {
    const directMediaUrl = String(context?.mediaUrl || '').trim();
    const rawUrl = /^https?:\/\//i.test(directMediaUrl)
      ? directMediaUrl
      : String(context?.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) return null;

    let extension = '';
    try {
      const pathname = new URL(rawUrl).pathname;
      extension = pathname.match(/\.([A-Za-z0-9]{2,8})$/)?.[1]?.toLowerCase() || '';
    } catch (_) { }

    const manifestKind = extension === 'm3u8' ? 'hls' : extension === 'mpd' ? 'dash' : '';
    const isDirectVideo = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'flv', 'wmv', 'mpeg', 'mpg', 'ogv']
      .includes(extension);
    const isCurrentMediaUrl = rawUrl === directMediaUrl;
    if (!manifestKind && !isDirectVideo && !isCurrentMediaUrl) return null;

    return {
      url: rawUrl,
      mediaType: manifestKind ? 'manifest' : 'video',
      kind: manifestKind || 'direct',
      extension,
      title: context?.title || '',
      referer: context?.referer || location.href,
      pageUrl: context?.referer || location.href,
      requestHeaders: { ...(context?.headers || {}) }
    };
  }

  async function downloadDirectFallback(context) {
    if (context?.allowDirectFallback !== true) return null;
    // Only the selected element's source is safe. A tab-wide "best candidate"
    // can belong to another video, an advertisement, or an earlier SPA route.
    const candidate = candidateFromContext(context);
    if (!candidate?.url) return null;
    try {
      return await PDWebExt.runtime.sendMessage({
        action: 'download_media_candidate',
        preferredUrl: candidate.url, candidate, mediaType: 'video'
      });
    } catch (error) { return { success: false, error: error?.message }; }
  }

  function showToast(panel, message, error = false) {
    const previous = panel._pdToast; previous?.remove(); untrackTheme(previous);
    const toast = node('div', 'pd-quality-toast' + (error ? ' err' : ''), message);
    toast.setAttribute('role', error ? 'alert' : 'status');
    trackTheme(toast); panel._pdToast = toast; layerHost(panel).append(toast); placeLayer(toast, panel);
    setTimeout(() => { toast.remove(); untrackTheme(toast); if (panel._pdToast === toast) panel._pdToast = null; }, 4500);
  }

  function getFormatKind(format) {
    // Use structured track metadata when provided by Core. null is unknown;
    // it must never become "audio only" or trigger an extra audio download.
    if (format && (Object.hasOwn(format, 'hasVideo') || Object.hasOwn(format, 'hasAudio'))) {
      if (format.hasVideo === false && format.hasAudio === false) return 'unknown';
      if (format.hasVideo === false) return 'audio';
      if (format.hasAudio === false) return 'videoNeedsAudio';
      if (format.hasVideo === true && format.hasAudio === true) return 'muxed';
      return 'unknown';
    }
    const note = String(format?.note || '').trim().toLowerCase();
    if (note === 'audio only') return 'audio';
    return note === 'unknown' ? 'unknown' : 'muxed';
  }

  function getFormatQuality(format, kind) {
    if (kind === 'audio') return PD.I18n.t('popupMediaAudio');
    if (Number(format.height) > 0) return format.height + 'p';
    return PD.I18n.t(kind === 'unknown' && format.hasVideo !== true ? 'qaMedia' : 'popupMediaVideo');
  }

  function getFormatKindText(kind) {
    return PD.I18n.t(kind === 'unknown' ? 'qaUnknownFormat'
      : kind === 'audio' ? 'ytFilterAudio'
      : 'ytFilterMuxed');
  }

  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.floor(seconds), hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const remainder = String(total % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
      : `${minutes}:${remainder}`;
  }

  function renderDropdown(dropdown, data, context, panel, control) {
    control.header();
    let filter = 'all', query = '', sending = false;
    const revision = control.revision();
    const search = node('input', 'pd-quality-search');
    search.type = 'search'; search.placeholder = PD.I18n.t('ytSearchPlaceholder');
    search.setAttribute('aria-label', PD.I18n.t('ytSearchPlaceholder'));
    search.addEventListener('input', () => { query = search.value.toLowerCase(); draw(); });
    dropdown.append(search);
    const filterBar = node('div', 'pd-quality-filters');
    filterBar.setAttribute('role', 'group'); filterBar.setAttribute('aria-label', PD.I18n.t('qaFilterFormats'));
    for (const [value, key] of [['all', 'ytFilterAll'], ['muxed', 'ytFilterMuxed'], ['audio', 'ytFilterAudio']]) {
      const button = node('button', 'pd-quality-filter-btn' + (value === 'all' ? ' active' : ''), PD.I18n.t(key));
      button.type = 'button'; button.dataset.filter = value; button.setAttribute('aria-pressed', String(value === 'all'));
      button.addEventListener('click', () => {
        if (sending) return; filter = value;
        filterBar.querySelectorAll('button').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); draw();
      });
      filterBar.append(button);
    }
    dropdown.append(filterBar);
    const list = node('div', 'pd-quality-list');
    dropdown.append(list);
    const duration = formatDuration(data.duration);
    if (duration) dropdown.append(node('div', 'pd-quality-footer', PD.I18n.t('qaDuration') + ': ' + duration));
    function draw() {
      list.replaceChildren();
      const formats = (data.formats || []).filter(format => {
        const kind = getFormatKind(format);
        if (filter === 'muxed' && kind !== 'muxed' && kind !== 'videoNeedsAudio') return false;
        if (filter === 'audio' && kind !== 'audio') return false;
        return [getFormatQuality(format, kind), getFormatKindText(kind), format.ext, format.note, format.size].join(' ').toLowerCase().includes(query);
      });
      if (!formats.length) list.append(node('div', 'pd-quality-empty', PD.I18n.t('ytNoFormats')));
      for (const format of formats) {
        const kind = getFormatKind(format), needsAudioMerge = kind === 'videoNeedsAudio';
        const quality = getFormatQuality(format, kind);
        const ext = (format.ext || 'mp4').toUpperCase();
        const kindText = getFormatKindText(kind);
        const item = node('button', 'pd-quality-item'); item.type = 'button';
        item.setAttribute('aria-label', quality + ' ' + ext + ' · ' + kindText);
        const mark = node('span', 'pd-quality-format-icon'); mark.append(icon(kind === 'audio' ? 'audio' : 'video'));
        const description = node('span', 'pd-quality-description');
        description.append(node('strong', '', quality), node('small', '', ext + ' · ' + kindText));
        const rawSize = String(format.size || '');
        const displayedSize = needsAudioMerge && rawSize && !rawSize.startsWith('≈') ? '≈ ' + rawSize : rawSize;
        item.append(mark, description, node('span', 'pd-quality-size', displayedSize || '—'), icon('download'));
        item.addEventListener('click', async () => {
          if (sending || revision !== control.revision()) return;
          sending = true; dropdown.querySelectorAll('.pd-quality-item, .pd-quality-filter-btn').forEach(button => { button.disabled = true; });
          search.disabled = true;
          const title = PD.MediaTitle?.resolve({
            isManifest: /\.(?:m3u8|mpd)(?:$|[?#])/i.test(context.url || ''),
            analyzedTitle: data.title, contextTitle: context.title, pageTitle: data.pageTitle,
            pageUrl: data.pageUrl, mediaUrl: context.url, fallback: 'video'
          }) || context.title || data.title || 'video';
          try {
            if (control.current && !await control.current(revision)) return;
            if (revision !== control.revision()) return;
            const response = await PDWebExt.runtime.sendMessage({
              action: 'download_media_format', url: data.analysisUrl || context.url, formatId: String(format.id) + (needsAudioMerge ? '+bestaudio' : ''),
              filename: sanitizeName(title) + '_' + quality + '.' + (format.ext || 'mp4'),
              title, filesize: needsAudioMerge ? 0 : (format.filesize || 0),
              referer: context.referer || location.href, headers: context.headers || undefined
            });
            if (revision !== control.revision()) return;
            if (!response?.success) throw new Error(response?.error || PD.I18n.t('ytDownloadError'));
            control.close(); showToast(panel, PD.I18n.t('ytAddedToQueue'));
          } catch (error) {
            if (revision === control.revision()) showToast(panel, error?.message || PD.I18n.t('ytDownloadError'), true);
          } finally {
            sending = false;
            if (revision === control.revision()) {
              search.disabled = false;
              dropdown.querySelectorAll('.pd-quality-item, .pd-quality-filter-btn').forEach(button => { button.disabled = false; });
            }
          }
        });
        list.append(item);
      }
      control.position();
    }
    draw();
  }

  function renderImageDropdown(dropdown, context, panel, control) {
    control.header();
    const revision = control.revision();
    let query = '', sending = false;
    const title = node('div', 'pd-quality-subtitle', context.title);
    title.title = context.title; dropdown.append(title);
    const search = node('input', 'pd-quality-search');
    search.type = 'search'; search.placeholder = PD.I18n.t('qaImageSearch');
    search.setAttribute('aria-label', search.placeholder);
    const list = node('div', 'pd-quality-list');
    const footer = node('div', 'pd-quality-footer', PD.I18n.t('qaImageHint'));
    dropdown.append(search, list, footer);
    search.addEventListener('input', () => { query = search.value.toLowerCase(); draw(); });
    function draw() {
      list.replaceChildren();
      for (const source of context.sources || []) {
        const label = PD.I18n.t(source.current ? 'qaImageCurrent' : source.linked ? 'qaImageLinked' : 'qaImageVariant');
        const dimension = source.width && source.height ? source.width + ' × ' + source.height : source.descriptor;
        const format = source.extension ? source.extension.toUpperCase() : PD.I18n.t('qaImage');
        const detail = [format, dimension, source.filename].filter(Boolean).join(' · ');
        if (!(label + ' ' + detail).toLowerCase().includes(query)) continue;
        const item = node('button', 'pd-quality-item'); item.type = 'button';
        item.setAttribute('aria-label', label + ' · ' + detail);
        const mark = node('span', 'pd-quality-format-icon'); mark.append(icon('image'));
        const description = node('span', 'pd-quality-description');
        description.append(node('strong', '', label), node('small', '', detail));
        item.append(mark, description, icon('download'));
        item.addEventListener('click', async () => {
          if (sending || revision !== control.revision()) return;
          sending = true; search.disabled = true;
          list.querySelectorAll('button').forEach(button => { button.disabled = true; });
          try {
            const current = await control.context();
            if (revision !== control.revision()) return;
            if (current?.mediaType !== 'image' || current.cacheKey !== context.cacheKey
                || !current.sources.some(item => item.url === source.url)) throw new Error(PD.I18n.t('qaImageChanged'));
            const local = source.url.startsWith('blob:');
            if (local) {
              await PD.BlobMedia.save(control.media(), context, () => revision === control.revision());
            } else {
              const result = await PDWebExt.runtime.sendMessage({
                action: 'download', url: source.url, filename: source.filename || null,
                referer: context.referer || location.href
              });
              if (!result?.success) throw new Error(result?.error || PD.I18n.t('ytDownloadError'));
            }
            if (revision !== control.revision()) return;
            control.close(); showToast(panel, PD.I18n.t(local ? 'qaBlobRequested' : 'ytAddedToQueue'));
          } catch (error) {
            if (revision === control.revision()) showToast(panel, error?.message || PD.I18n.t('ytDownloadError'), true);
          } finally {
            sending = false;
            if (revision === control.revision()) {
              search.disabled = false;
              list.querySelectorAll('button').forEach(button => { button.disabled = false; });
            }
          }
        });
        list.append(item);
      }
      if (!list.children.length) list.append(node('div', 'pd-quality-empty', PD.I18n.t('qaImageEmpty')));
      control.position();
    }
    draw();
  }

  let activeController = null;
  let nextPanelId = 0;
  function createPanel(options = {}) {
    ensureTheme(); ensureStyle();
    const panel = node('div', ['pd-quality-panel', options.fixed ? 'pd-quality-fixed' : '', options.className || ''].filter(Boolean).join(' '));
    panel.setAttribute('role', 'toolbar'); panel.setAttribute('aria-label', PD.I18n.t('qaToolbar'));
    let contextProvider = options.getContext || (() => null), contextRevision = 0, destroyed = false;
    let alignment = 'left', open = false, menuOpen = false, mediaType = 'video';
    const dropdown = node('div', 'pd-quality-dropdown'), menu = node('div', 'pd-quality-menu');
    [panel, dropdown, menu].forEach(trackTheme);
    let gestureActive = false, gestureTimer = 0;
    const hoveredRoots = new Set();
    function releaseGesture(event) {
      document.removeEventListener('pointerup', releaseGesture, true);
      document.removeEventListener('pointercancel', releaseGesture, true);
      window.removeEventListener('blur', releaseGesture);
      clearTimeout(gestureTimer);
      gestureTimer = setTimeout(() => { gestureActive = false; }, event?.type === 'pointerup' ? 200 : 0);
    }
    function holdGesture() {
      clearTimeout(gestureTimer); gestureActive = true;
      document.addEventListener('pointerup', releaseGesture, true);
      document.addEventListener('pointercancel', releaseGesture, true);
      window.addEventListener('blur', releaseGesture);
    }
    dropdown.id = 'pd-quality-picker-' + (++nextPanelId); dropdown.setAttribute('role', 'dialog');
    dropdown.setAttribute('aria-label', PD.I18n.t('qaChooseFile'));
    function tool(name, cls, label, handler) {
      const button = node('button', 'pd-quality-tool ' + cls); button.type = 'button';
      button.title = PD.I18n.t(label); button.setAttribute('aria-label', button.title);
      button.append(icon(name)); button.addEventListener('click', handler); return button;
    }
    const closeButton = tool('close', 'pd-quality-close', 'qaHideToolbar', () => { closeDropdown(); options.onClose?.(panel); });
    const mainButton = tool('download', 'pd-quality-main-btn', 'qaChooseFile', () => open ? closeDropdown(true) : void openPicker());
    const pipButton = tool('pip', 'pd-quality-pip', 'pipToggle', async () => {
      if (pipButton.disabled || mediaType === 'image') return;
      pipButton.disabled = true;
      try {
        // The source is resolved synchronously so native PiP keeps the click's activation.
        const media = options.getVideo?.();
        if (!PD.PictureInPicture) throw new Error(PD.I18n.t('pipUnsupported'));
        await PD.PictureInPicture.toggle(media);
      } catch (error) { if (!destroyed) showToast(panel, error?.message || PD.I18n.t('pipFailed'), true); }
      finally { pipButton.disabled = false; }
    });
    const moreButton = tool('more', 'pd-quality-more', 'qaMore', () => {
      const wasOpen = menuOpen; closeDropdown(); if (wasOpen) return;
      activate(); menuOpen = true; menu.classList.add('open'); moreButton.setAttribute('aria-expanded', 'true');
      layerHost(panel).append(menu); listen(); position(); menu.querySelector('button')?.focus();
    });
    mainButton.setAttribute('aria-haspopup', 'dialog'); mainButton.setAttribute('aria-controls', dropdown.id); mainButton.setAttribute('aria-expanded', 'false');
    moreButton.setAttribute('aria-expanded', 'false');
    for (const [key, action] of [['qaReanalyze', () => void openPicker(true)], ['qaHideToolbar', () => { closeDropdown(); options.onClose?.(panel); }]]) {
      const button = node('button', '', PD.I18n.t(key)); button.type = 'button'; button.addEventListener('click', action); menu.append(button);
    }
    panel.append(closeButton, mainButton, pipButton, moreButton);
    // Prevent player shortcuts and thumbnail navigation from receiving UI input.
    for (const target of [panel, dropdown, menu]) {
      // Track actual entry/exit, rather than relying exclusively on :hover
      // being recomputed while the website removes its hover preview.
      target.addEventListener('pointerenter', () => hoveredRoots.add(target));
      target.addEventListener('pointerleave', () => hoveredRoots.delete(target));
      target.addEventListener('pointerdown', holdGesture, true);
      for (const name of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup']) target.addEventListener(name, event => { event.stopPropagation(); if (name === 'click') event.preventDefault(); });
      target.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); closeDropdown(true); }
      });
      for (const name of ['keyup', 'keypress']) target.addEventListener(name, event => event.stopPropagation());
    }
    function contains(target) { return target instanceof Node && (panel.contains(target) || dropdown.contains(target) || menu.contains(target)); }
    function outside(event) { if (!contains(event.target)) closeDropdown(); }
    function position() {
      if (!panel.isConnected) { closeDropdown(); return; }
      const host = layerHost(panel);
      if (open && dropdown.parentElement !== host) host.append(dropdown);
      if (menuOpen && menu.parentElement !== host) host.append(menu);
      if (open) placeLayer(dropdown, panel, alignment);
      if (menuOpen) placeLayer(menu, panel, alignment);
    }
    function scrolled(event) { if (!dropdown.contains(event.target) && !menu.contains(event.target)) position(); }
    function fullscreenChanged() { if (open) layerHost(panel).append(dropdown); if (menuOpen) layerHost(panel).append(menu); position(); }
    function listen() {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('scroll', scrolled, true); window.addEventListener('resize', position);
      document.addEventListener('fullscreenchange', fullscreenChanged);
    }
    function unlisten() {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', position);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
    }
    function closeDropdown(focus = false) {
      contextRevision++; open = false; menuOpen = false; unlisten();
      dropdown.classList.remove('open'); menu.classList.remove('open'); dropdown.remove(); menu.remove();
      hoveredRoots.delete(dropdown); hoveredRoots.delete(menu);
      mainButton.setAttribute('aria-expanded', 'false'); moreButton.setAttribute('aria-expanded', 'false');
      mainButton.removeAttribute('aria-busy');
      if (activeController === controller) activeController = null;
      if (focus && panel.isConnected) mainButton.focus({ preventScroll: true });
    }
    function activate() { if (activeController && activeController !== controller) activeController.closeDropdown(); activeController = controller; }
    function setMediaType(value) {
      mediaType = value === 'image' ? 'image' : 'video';
      panel.dataset.mediaType = mediaType;
      pipButton.hidden = mediaType === 'image';
      const label = PD.I18n.t(mediaType === 'image' ? 'qaChooseImage' : 'qaChooseFile');
      mainButton.title = label; mainButton.setAttribute('aria-label', label);
      dropdown.setAttribute('aria-label', label);
      menu.firstElementChild.textContent = PD.I18n.t(mediaType === 'image' ? 'qaRefreshSources' : 'qaReanalyze');
    }
    function header() {
      dropdown.replaceChildren(); const heading = node('div', 'pd-quality-heading');
      const dismiss = tool('close', 'pd-quality-dismiss', 'ytClose', () => closeDropdown(true));
      heading.append(node('span', 'pd-quality-dot'), node('strong', '', PD.I18n.t(mediaType === 'image' ? 'qaChooseImage' : 'qaChooseFile')), dismiss); dropdown.append(heading);
    }
    function loading() {
      header(); const state = node('div', 'pd-quality-empty pd-quality-loading');
      state.setAttribute('role', 'status'); state.append(node('span', 'pd-quality-spinner'), node('span', '', PD.I18n.t(mediaType === 'image' ? 'qaImageLoading' : 'qaAnalyzing')));
      dropdown.append(state); position();
    }
    async function requireCurrentSelection(expected, revision) {
      const current = await contextProvider();
      if (revision !== contextRevision || destroyed) return null;
      // A DOM-identified item can load/replace its buffer during analysis.
      // Its validated permalink remains the identity, not that temporary src.
      const fields = expected?.preferItemAnalysis && current?.preferItemAnalysis
        ? ['url', 'pageUrl', 'frameUrl']
        : ['url', 'pageUrl', 'frameUrl', 'mediaUrl', 'blobUrl', 'mediaKey'];
      if (!current || fields.some(key => String(current[key] || '') !== String(expected?.[key] || ''))) {
        throw new Error(PD.I18n.t('qaSourceExpired'));
      }
      return current;
    }
    function sourceChoices(context, sources, ownerContext = context) {
      if (!sources.length && !context?.blobUrl) return;
      const revision = contextRevision;
      const list = node('div', 'pd-quality-sources');
      list.setAttribute('aria-label', PD.I18n.t('qaCapturedSources'));
      if (sources.length) list.append(node('div', 'pd-quality-source-hint', PD.I18n.t('qaCapturedSources')));
      for (const source of sources) {
        const row = node('div', 'pd-quality-source');
        let label;
        try { const u = new URL(source.url); label = u.host + u.pathname; } catch { continue; }
        const title = node('strong', '', (source.kind === 'hls' ? 'HLS' : source.kind === 'dash' ? 'DASH' : 'Video') + ' · ' + label);
        // Do not expose query tokens in labels/tooltips.
        title.title = title.textContent;
        const scopeLabel = PD.I18n.t(source.scope === 'exact' ? 'qaExactPlayerSource'
          : source.scope === 'frame' ? 'qaFrameSource' : 'qaOtherTabSource');
        const size = Number(source.size) > 0
          ? (Number(source.size) / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB' : '';
        const detail = [source.extension?.toUpperCase(), size, scopeLabel].filter(Boolean).join(' · ');
        row.append(title, node('small', '', detail));
        const actions = node('div', 'pd-quality-source-actions');
        const inspect = node('button', '', PD.I18n.t('qaAnalyzeSource')); inspect.type = 'button';
        inspect.addEventListener('click', async () => {
          if (inspect.disabled || revision !== contextRevision) return;
          inspect.disabled = true;
          try {
            if (await requireCurrentSelection(ownerContext, revision)) void openPicker(true, source);
          } catch (error) { if (revision === contextRevision) showToast(panel, error?.message, true); }
          finally { inspect.disabled = false; }
        });
        const download = node('button', 'pd-quality-source-download', PD.I18n.t('qaDownloadSource')); download.type = 'button';
        download.addEventListener('click', async () => {
          if (download.disabled || revision !== contextRevision) return;
          download.disabled = true;
          try {
            const current = await requireCurrentSelection(ownerContext, revision);
            if (!current) return;
            const result = await PDWebExt.runtime.sendMessage({ action: 'download_player_source',
              candidateId: source.id, context: { pageUrl: current.pageUrl, frameUrl: current.frameUrl, mediaUrl: current.mediaUrl }, title: current.title });
            if (revision !== contextRevision) return;
            if (!result?.success) throw new Error(result?.error || PD.I18n.t('ytDownloadError'));
            closeDropdown(true); showToast(panel, PD.I18n.t('ytAddedToQueue'));
          } catch (error) { if (revision === contextRevision) showToast(panel, error?.message, true); }
          finally { download.disabled = false; }
        });
        actions.append(download, inspect); row.append(actions); list.append(row);
      }
      if (context?.blobUrl && PD.BlobMedia) {
        const row = node('div', 'pd-quality-source');
        row.append(node('small', '', PD.I18n.t('qaBlobHint')));
        const button = node('button', 'pd-quality-blob-save', PD.I18n.t('qaSaveBlob')); button.type = 'button';
        button.addEventListener('click', async () => {
          if (button.disabled || revision !== contextRevision) return;
          button.disabled = true;
          try {
            await PD.BlobMedia.save(options.getVideo?.(), context, () => revision === contextRevision && !destroyed);
            if (revision !== contextRevision) return;
            showToast(panel, PD.I18n.t('qaBlobRequested'));
          } catch (error) { if (revision === contextRevision) showToast(panel, error?.message, true); }
          finally { button.disabled = false; }
        });
        row.append(button); list.append(row);
      }
      dropdown.append(list); position();
    }
    function showCapturedSources(context, sources) {
      header();
      const title = node('div', 'pd-quality-subtitle', context.title || '');
      title.title = title.textContent; dropdown.append(title);
      dropdown.append(node('div', 'pd-quality-footer', PD.I18n.t('qaCapturedDownloadHint')));
      sourceChoices(context, sources);
      const actions = node('div', 'pd-quality-source-actions pd-quality-footer');
      const refresh = node('button', 'pd-quality-retry', PD.I18n.t('qaRefreshSources'));
      refresh.type = 'button'; refresh.addEventListener('click', () => void openPicker(true));
      const analyzePage = node('button', 'pd-quality-retry', PD.I18n.t('qaAnalyzePage'));
      analyzePage.type = 'button'; analyzePage.addEventListener('click', () => void openPicker(true, null, true));
      actions.append(refresh, analyzePage); dropdown.append(actions); position();
    }
    function failure(context, text, sources = [], ownerContext = context) {
      header(); dropdown.append(node('div', 'pd-quality-empty', text || PD.I18n.t('ytCannotAnalyze')));
      const retry = node('button', 'pd-quality-retry', PD.I18n.t('qaRetry')); retry.type = 'button'; retry.addEventListener('click', () => void openPicker(true)); dropdown.append(retry);
      if (mediaType === 'image') { position(); return; }
      if (context?.allowDirectFallback) {
        const fallback = node('button', 'pd-quality-retry', PD.I18n.t('qaDirectDownload')); fallback.type = 'button';
        fallback.addEventListener('click', async () => {
          if (fallback.disabled) return; fallback.disabled = true; const revision = contextRevision;
          try {
            if (!await requireCurrentSelection(ownerContext, revision)) return;
            const result = await downloadDirectFallback(context);
            if (revision !== contextRevision) return;
            if (result?.success) { closeDropdown(true); showToast(panel, PD.I18n.t('ytAddedToQueue')); }
            else showToast(panel, result?.error || PD.I18n.t('ytDownloadError'), true);
          } catch (error) { if (revision === contextRevision) showToast(panel, error?.message, true); }
          finally { fallback.disabled = false; }
        });
        dropdown.append(fallback);
      }
      sourceChoices(context, sources, ownerContext); position();
    }
    async function openPicker(force = false, selectedSource = null, analyzePage = false) {
      if (destroyed) return;
      closeDropdown(); activate(); open = true;
      const revision = ++contextRevision;
      dropdown.classList.add('open'); layerHost(panel).append(dropdown);
      mainButton.setAttribute('aria-expanded', 'true'); mainButton.setAttribute('aria-busy', 'true');
      listen(); loading();
      let context, ownerContext, sources = [];
      try {
        context = await contextProvider();
        ownerContext = context;
        if (revision !== contextRevision || destroyed) return;
        if (!context?.url) throw new Error(PD.I18n.t(mediaType === 'image' ? 'qaImageUnavailable' : 'ytCannotAnalyze'));
        setMediaType(context.mediaType);
        if (context.mediaType === 'image') {
          // Same controller, portal and hover lifecycle as video. Image URLs
          // go straight to the normal file bridge, never to the video analyzer.
          renderImageDropdown(dropdown, context, panel, {
            header, revision: () => contextRevision, close: () => closeDropdown(true), position,
            context: () => contextProvider(), media: () => options.getVideo?.()
          });
          if (document.activeElement === mainButton) dropdown.querySelector('input')?.focus({ preventScroll: true });
          return;
        }
        if (context.pageUrl) {
          try {
            const found = await PDWebExt.runtime.sendMessage({ action: 'get_player_sources',
              context: { pageUrl: context.pageUrl, frameUrl: context.frameUrl, mediaUrl: context.mediaUrl } });
            sources = Array.isArray(found?.sources) ? found.sources : [];
          } catch (_) { /* Page analysis remains available when capture is offline. */ }
          if (revision !== contextRevision || destroyed) return;
        }
        if (!await requireCurrentSelection(ownerContext, revision)) return;
        if (selectedSource) {
          // Refresh registry metadata before analysis; stale rows cannot turn
          // into requests for an unrelated or expired source.
          const source = sources.find(item => item.id === selectedSource.id);
          if (!source) throw new Error(PD.I18n.t('qaSourceExpired'));
          context = { ...context, url: source.url, mediaUrl: source.url,
            referer: source.referer || context.referer, headers: source.requestHeaders,
            cacheKey: [context.cacheKey, source.id, source.url].join('|'), allowDirectFallback: false };
        } else if (!analyzePage && !context.preferItemAnalysis && (context.frameUrl || context.blobUrl)
            && sources.some(source => source.scope !== 'tab')) {
          // MSE/blob players also stream ordinary MP4/WebM over fetch/XHR.
          // Those captured URLs are usable without a page extractor, just as
          // HLS/DASH are. Keep page analysis available as an explicit action.
          showCapturedSources(context, sources); return;
        }
        const response = await analyze(context, force);
        if (revision !== contextRevision || destroyed) return;
        if (!await requireCurrentSelection(ownerContext, revision)) return;
        if (!response?.success || !response.formats?.length) throw new Error(response?.error || PD.I18n.t('ytCannotAnalyze'));
        renderDropdown(dropdown, response, context, panel, {
          header, revision: () => contextRevision, close: () => closeDropdown(true), position,
          current: currentRevision => requireCurrentSelection(ownerContext, currentRevision)
        });
        if (document.activeElement === mainButton) dropdown.querySelector('input')?.focus({ preventScroll: true });
      } catch (error) {
        if (revision === contextRevision && !destroyed) failure(context, error?.message, sources, ownerContext);
      } finally { if (revision === contextRevision) mainButton.removeAttribute('aria-busy'); }
    }
    const controller = {
      element: panel,
      setMediaType,
      setContextProvider(provider) { closeDropdown(); contextProvider = provider || (() => null); },
      setDropdownAlignment(value) { alignment = value === 'right' ? 'right' : 'left'; position(); },
      invalidateContext() {
        // A new pointer-selected card releases focus and the previous gesture
        // as well as closing its list; otherwise focus can pin the old owner.
        if (contains(document.activeElement)) document.activeElement.blur?.();
        closeDropdown(); hoveredRoots.clear();
        releaseGesture(); clearTimeout(gestureTimer); gestureActive = false;
      },
      closeDropdown,
      openPicker,
      isDropdownOpen() { return open || menuOpen; },
      isGestureActive() { return gestureActive; },
      isPointerInteractionActive() { return gestureActive || hoveredRoots.size > 0 || panel.matches?.(':hover'); },
      isInteractionActive() { return hoveredRoots.size > 0 || gestureActive || open || menuOpen || contains(document.activeElement) || panel.matches?.(':hover'); },
      containsTarget: contains,
      showToast(message, error = false) { showToast(panel, message, error); },
      destroy() {
        destroyed = true; releaseGesture(); clearTimeout(gestureTimer); gestureActive = false;
        hoveredRoots.clear();
        closeDropdown(); panel._pdToast?.remove();
        [panel, dropdown, menu, panel._pdToast].forEach(untrackTheme); panel.remove();
      }
    };
    return controller;
  }

  PD.QualityAnalyzer = {
    analyze, createPanel, sanitizeName,
    clearCache() { cache.clear(); }
  };
})(globalThis);
