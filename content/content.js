const VIDEO_CONTEXT_SELECTOR = [
  '[data-video-id]',
  '[aria-label="Video player"]',
  '[data-e2e="recommend-list-item-container"]',
  '[data-e2e="browse-video"]',
  '[data-e2e="feed-video"]',
  '[data-testid*="video"]',
  'article',
  '[role="article"]'
].join(',');

// Keep the CSS selector intentionally simple and provider-agnostic. Provider
// recognition happens in JavaScript so a malformed/concatenated selector can
// never break the whole scanner (for example `closest('video,${...}')`).
const MEDIA_ELEMENT_SELECTOR = 'video,iframe';
const MEDIA_CONTEXT_SELECTOR = [
  '[data-video-id]',
  '[aria-label="Video player"]',
  '[data-testid*="video"]',
  '[data-testid*="player"]',
  '[data-e2e*="video"]',
  '[data-e2e*="player"]',
  '[class*="video"]',
  '[class*="player"]',
  '[id*="video"]',
  '[id*="player"]',
  'article',
  '[role="article"]',
  'dialog',
  '[role="dialog"]',
  '[aria-modal="true"]'
].join(',');
const MEDIA_MUTATION_ATTRIBUTES = [
  'src', 'data-src', 'class', 'open', 'hidden', 'aria-hidden'
];
const MEDIA_SURFACE_SELECTOR = [
  '[aria-label="Video player"]',
  '[data-testid*="player"]',
  '[data-testid*="video"]',
  '[data-e2e*="player"]',
  '[data-e2e*="video"]',
  '[class*="player"]',
  '[class*="video"]',
  '[id*="player"]',
  '[id*="video"]'
].join(',');


let _activeMedia = null;
let _activeContextNode = null;
let _activePlayer = null;
let _activeMediaKey = '';
let _btn = null;
let _qualityPanel = null;
let _dismissedMediaKey = '';
let _hideTimer = null;
let _pointerFrame = 0;
let _lastPointerEvent = null;
let _forcePointerRefresh = false;
let _contextInvalidated = false;

// Only the top document owns the visible quality panel. Subframes still scan
// their local DOM and report media presence upward, allowing the top frame to
// represent cross-origin players without rendering duplicate controls inside
// both the iframe and its embedding page.
const IS_TOP_FRAME = window === window.top;
const FRAME_MEDIA_MESSAGE = 'pdownloader:media-frame-state:v1';
const _reportedMediaFrames = new WeakSet();
const _reportedMediaFrameInfo = new WeakMap();

function hostnameMatches(hostname, expected) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const domain = String(expected || '').toLowerCase().replace(/^www\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function isYouTubeHost(hostname = location.hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return host === 'youtube.com'
    || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com'
    || host.endsWith('.youtube-nocookie.com')
    || host === 'youtu.be'
    || host.endsWith('.youtu.be');
}

function getYouTubeVideoId(rawUrl = location.href) {
  let url;
  try {
    url = new URL(rawUrl, location.href);
  } catch (_) {
    return '';
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const isYouTubeDomain = host === 'youtube.com'
    || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com'
    || host.endsWith('.youtube-nocookie.com');

  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
  }

  if (!isYouTubeDomain) return '';

  const queryId = url.searchParams.get('v') || '';
  if (/^[A-Za-z0-9_-]{6,20}$/.test(queryId)) return queryId;

  const pathMatch = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,20})(?:[/?]|$)/i);
  return pathMatch?.[1] || '';
}

function getCanonicalYouTubeUrl(rawUrl = location.href) {
  const videoId = getYouTubeVideoId(rawUrl);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}

function isVimeoHost(hostname = location.hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return host === 'vimeo.com'
    || host.endsWith('.vimeo.com');
}

function getVimeoVideoInfo(rawUrl = location.href) {
  let url;
  try {
    url = new URL(rawUrl, location.href);
  } catch (_) {
    return null;
  }

  if (!isVimeoHost(url.hostname)) return null;

  const pathParts = url.pathname.split('/').filter(Boolean);
  let videoId = '';
  let unlistedHash = '';

  if (url.hostname.toLowerCase() === 'player.vimeo.com') {
    if (pathParts[0]?.toLowerCase() !== 'video') return null;
    videoId = pathParts[1] || '';
    unlistedHash = url.searchParams.get('h') || '';
  } else {
    const videoIndex = pathParts[0]?.toLowerCase() === 'video' ? 1 : 0;
    videoId = pathParts[videoIndex] || '';
    unlistedHash = pathParts[videoIndex + 1] || url.searchParams.get('h') || '';
  }

  if (!/^\d+$/.test(videoId)) return null;
  if (unlistedHash && !/^[A-Za-z0-9_-]+$/.test(unlistedHash)) {
    unlistedHash = '';
  }

  return { videoId, unlistedHash };
}

function getCanonicalVimeoUrl(rawUrl = location.href) {
  const info = getVimeoVideoInfo(rawUrl);
  if (!info) return '';

  return `https://vimeo.com/${info.videoId}`
    + (info.unlistedHash ? `/${info.unlistedHash}` : '');
}

function getEmbeddingPageReferer() {
  const referrer = String(document.referrer || '').trim();
  if (window !== window.top && /^https?:\/\//i.test(referrer)) {
    return referrer;
  }

  return '';
}

function usesDedicatedYouTubePanel() {
  const host = location.hostname.toLowerCase();
  const isRegularYouTube = host === 'youtube.com' || host.endsWith('.youtube.com');

  return window === window.top && isRegularYouTube;
}


const _selectorValidityCache = new Map();

function normalizeSelector(selector) {
  if (Array.isArray(selector)) {
    selector = selector
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .join(',');
  }

  return String(selector || '').trim();
}

function isValidSelector(selector) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return false;
  if (_selectorValidityCache.has(normalized)) {
    return _selectorValidityCache.get(normalized);
  }

  // Validate once before the selector reaches any DOM selector API. This keeps
  // malformed lists such as `video,` from producing an uncaught DOMException.
  let valid = false;
  try {
    document.documentElement.matches(normalized);
    valid = true;
  } catch (_) { }

  _selectorValidityCache.set(normalized, valid);
  return valid;
}

function safeMatches(element, selector) {
  if (!(element instanceof Element)) return false;
  const normalized = normalizeSelector(selector);
  if (!isValidSelector(normalized)) return false;
  try { return element.matches(normalized); } catch (_) { return false; }
}

function getSelectorParent(element) {
  if (!(element instanceof Element)) return null;
  if (element.parentElement) return element.parentElement;

  // `Element.closest()` stops at a shadow root. For media scanning it is more
  // useful to continue through the host so custom players are discoverable too.
  try {
    const root = element.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  } catch (_) {
    return null;
  }
}

function safeClosest(element, selector) {
  if (!(element instanceof Element)) return null;
  const normalized = normalizeSelector(selector);
  if (!isValidSelector(normalized)) return null;

  // Do not call Element.closest() at all. Besides preventing selector exceptions
  // from escaping, this lets the scanner cross open shadow-root boundaries.
  let current = element;
  for (let depth = 0; current && depth < 64; depth++) {
    try {
      if (current.matches(normalized)) return current;
    } catch (_) {
      return null;
    }
    current = getSelectorParent(current);
  }

  return null;
}

function safeQueryAll(root, selector) {
  if (!root?.querySelectorAll) return [];
  const normalized = normalizeSelector(selector);
  if (!isValidSelector(normalized)) return [];
  try { return root.querySelectorAll(normalized); } catch (_) { return []; }
}

function getFrameSource(frame) {
  if (!(frame instanceof HTMLIFrameElement)) return '';
  const values = [
    _reportedMediaFrameInfo.get(frame)?.pageUrl,
    frame.src,
    frame.getAttribute('src'),
    frame.dataset?.src,
    frame.getAttribute('data-src')
  ];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || text === 'about:blank' || text.startsWith('javascript:')) continue;
    try { return new URL(text, location.href).href; } catch (_) { }
  }
  return '';
}

function getFrameSemanticScore(frame) {
  if (!(frame instanceof HTMLIFrameElement)) return -Infinity;

  const src = getFrameSource(frame);
  const text = [
    frame.title,
    frame.getAttribute('aria-label'),
    frame.id,
    frame.className,
    frame.getAttribute('name'),
    frame.getAttribute('allow'),
    frame.parentElement?.className,
    frame.parentElement?.id
  ].map(value => String(value || '').toLowerCase()).join(' ');

  let score = 0;
  if (_reportedMediaFrames.has(frame)) score += 180;
  if (getYouTubeVideoId(src) || getVimeoVideoInfo(src)) score += 100;
  if (/\b(?:video|player|media|stream|embed)\b/i.test(text)) score += 18;
  if (/\b(?:autoplay|fullscreen|picture-in-picture)\b/i.test(String(frame.getAttribute('allow') || ''))) score += 16;

  try {
    const url = new URL(src, location.href);
    if (/(?:^|\/)(?:embed|video|player|watch|stream)(?:\/|$)/i.test(url.pathname)) score += 18;
    if (/\.(?:m3u8|mpd|mp4|webm)(?:$|[?#])/i.test(url.href)) score += 30;
  } catch (_) { }

  const rect = frame.getBoundingClientRect();
  if (rect.width >= 240 && rect.height >= 120) score += 8;
  if (rect.width >= 480 && rect.height >= 270) score += 5;

  return score;
}

function isLikelyMediaFrame(frame) {
  return frame instanceof HTMLIFrameElement
    && (_reportedMediaFrames.has(frame) || getFrameSemanticScore(frame) >= 24);
}

function isMediaElement(element) {
  return element instanceof HTMLVideoElement || isLikelyMediaFrame(element);
}

function getMediaSourceUrl(media) {
  if (media instanceof HTMLIFrameElement) return getFrameSource(media);
  return getDirectMediaUrl(media);
}

function isOverlayLike(element) {
  if (!(element instanceof Element)) return false;
  if (element.tagName === 'DIALOG'
      || element.getAttribute('role') === 'dialog'
      || element.getAttribute('aria-modal') === 'true') {
    return true;
  }

  // Also recognize framework-agnostic visual overlays. This catches modal
  // implementations that do not expose ARIA/dialog semantics.
  try {
    const style = getComputedStyle(element);
    if (style.position !== 'fixed') return false;
    const rect = element.getBoundingClientRect();
    const coversWidth = rect.width >= window.innerWidth * 0.55;
    const coversHeight = rect.height >= window.innerHeight * 0.55;
    return coversWidth && coversHeight;
  } catch (_) {
    return false;
  }
}

function getOpenOverlayContainer(media) {
  if (!(media instanceof Element)) return null;

  try {
    const popover = safeClosest(media, ':popover-open');
    if (popover) return popover;
  } catch (_) { }

  let ancestor = media.parentElement;
  for (let depth = 0; ancestor && depth < 16; depth++, ancestor = ancestor.parentElement) {
    if (isOverlayLike(ancestor)) return ancestor;
    if (ancestor === document.body || ancestor === document.documentElement) break;
  }

  return null;
}

function isElementVisuallyRendered(element, minWidth = 1, minHeight = 1) {
  if (!(element instanceof Element) || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < minWidth || rect.height < minHeight) return false;
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
    return false;
  }
  if (!element.getClientRects().length) return false;

  let current = element;
  for (let depth = 0; current && depth < 24; depth++, current = current.parentElement) {
    if (current.hidden) return false;

    const style = getComputedStyle(current);
    if (style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || Number.parseFloat(style.opacity || '1') <= 0.01) {
      return false;
    }

    if (current === document.body || current === document.documentElement) break;
  }

  return true;
}

function getMediaRenderSurface(media) {
  if (!isMediaElement(media) || !media.isConnected) return null;

  // Prefer the media node when it is actually painted. `aria-hidden` is
  // intentionally ignored here: it changes accessibility exposure, not
  // visual rendering. Several modern players mark their visual media layer
  // aria-hidden while it remains the real playback surface.
  if (isElementVisuallyRendered(media, 60, 40)) return media;

  // MSE/canvas-heavy players frequently keep the <video> itself transparent
  // or visually hidden behind a thumbnail/control layer. In that case, use a
  // visible player ancestor as the interaction surface while keeping the real
  // <video>/<iframe> as the media source. This is provider-agnostic and also
  // avoids relying on framework-specific popup/player class names.
  let ancestor = media.parentElement;
  for (let depth = 0; ancestor && depth < 14; depth++, ancestor = ancestor.parentElement) {
    if (safeMatches(ancestor, MEDIA_SURFACE_SELECTOR)
        && isElementVisuallyRendered(ancestor, 120, 70)) {
      const nestedMedia = [...safeQueryAll(ancestor, MEDIA_ELEMENT_SELECTOR)]
        .filter(item => isMediaElement(item));

      // Hidden preload media is only promoted when this surface has an
      // unambiguous media source. This prevents a large feed/container from
      // activating one of many off-screen preload videos.
      if (nestedMedia.length === 1 && nestedMedia[0] === media) return ancestor;

      const activeNested = nestedMedia.filter(item =>
        item instanceof HTMLVideoElement && !item.paused && !item.ended);
      if (activeNested.length === 1 && activeNested[0] === media) return ancestor;
    }

    if (ancestor === document.body || ancestor === document.documentElement) break;
  }

  return null;
}

function isTopmostAtCenter(media) {
  if (!(media instanceof Element)) return false;
  const surface = getMediaRenderSurface(media);
  if (!surface) return false;
  const rect = surface.getBoundingClientRect();
  const x = clamp(rect.left + rect.width / 2, 0, Math.max(0, window.innerWidth - 1));
  const y = clamp(rect.top + rect.height / 2, 0, Math.max(0, window.innerHeight - 1));
  const painted = document.elementFromPoint?.(x, y);
  if (!(painted instanceof Element)) return false;
  if (painted === surface || surface.contains?.(painted)) return true;

  const mediaContext = safeClosest(surface, MEDIA_CONTEXT_SELECTOR)
    || safeClosest(media, MEDIA_CONTEXT_SELECTOR);
  const paintedContext = safeClosest(painted, MEDIA_CONTEXT_SELECTOR);
  return !!mediaContext && mediaContext === paintedContext;
}

function getBtn() {
  if (_btn) return _btn;

  if (!PD.QualityAnalyzer) {
    throw new Error('Quality analyzer is not available.');
  }

  _qualityPanel = PD.QualityAnalyzer.createPanel({
    fixed: true,
    getContext: () => resolveQualityContext(_activeMedia, _activeContextNode),
    onClose: () => {
      _dismissedMediaKey = _activeMediaKey;
      hideButton(false);
    }
  });

  _btn = _qualityPanel.element;

  _btn.addEventListener('pointerenter', () => {
    clearHide();
    showButton();
  });
  _btn.addEventListener('pointerleave', () => scheduleHide(300));

  document.body.appendChild(_btn);
  return _btn;
}

async function resolveQualityContext(media, contextNode) {
  if (!media || !media.isConnected || !isMediaElement(media)) return null;

  const hostname = location.hostname;
  const mediaTitle = getMediaTitle(media, contextNode);
  const directMediaUrl = media instanceof HTMLVideoElement ? getDirectMediaUrl(media) : '';
  const embeddedUrl = media instanceof HTMLIFrameElement ? getFrameSource(media) : '';
  const mediaKey = getMediaKey(media, contextNode);
  const sourceUrl = embeddedUrl || location.href;
  const embeddedYouTubeUrl = getCanonicalYouTubeUrl(sourceUrl);
  const embeddedVimeoUrl = getCanonicalVimeoUrl(sourceUrl);
  let url = '';
  let referer = location.href;
  let allowDirectFallback = true;

  if (embeddedYouTubeUrl) {
    url = embeddedYouTubeUrl;
    allowDirectFallback = false;
  } else if (embeddedVimeoUrl) {
    url = embeddedVimeoUrl;
    referer = media instanceof HTMLIFrameElement
      ? location.href
      : (getEmbeddingPageReferer() || location.href);
    allowDirectFallback = false;
  } else if (isYouTubeHost(hostname)) {
    url = getCanonicalYouTubeUrl(location.href) || location.href;
    allowDirectFallback = false;
  } else if (isVimeoHost(hostname)) {
    const embeddingReferer = getEmbeddingPageReferer();
    url = getCanonicalVimeoUrl(location.href) || getSiteUrl(media, contextNode);
    referer = embeddingReferer || location.href;
    allowDirectFallback = false;
  } else if (media instanceof HTMLIFrameElement) {
    // Generic embed: analyze the iframe URL itself. The background media
    // registry still provides HLS/DASH/direct candidates if the provider page
    // is unsupported by the analyzer.
    url = embeddedUrl || location.href;
    referer = location.href;
  } else {
    const siteUrl = getSiteUrl(media, contextNode);
    if (siteUrl && /^https?:\/\//i.test(siteUrl)) {
      url = siteUrl;
    }

    const shouldPreferPageUrl = [
      'tiktok.com', 'facebook.com', 'fb.watch', 'instagram.com',
      'x.com', 'twitter.com', 'twitch.tv', 'reddit.com',
      'bilibili.com', 'bilibili.tv', 'soundcloud.com'
    ].some(host => hostnameMatches(hostname, host));

    if (!shouldPreferPageUrl && (!url || url === location.href)) {
      if (/^https?:\/\//i.test(directMediaUrl)) url = directMediaUrl;
    }

    const shouldUseCapturedMedia = !url
      || url === location.href
      || url.startsWith('blob:')
      || /\.(?:m3u8|mpd)(?:$|[?#])/i.test(url);

    if (!shouldPreferPageUrl && shouldUseCapturedMedia) {
      const detected = await sendMessageSafe({
        action: 'get_media_candidates',
        mediaType: 'video',
        minScore: 45
      });

      const candidates = Array.isArray(detected?.candidates)
        ? detected.candidates.filter(candidate => /^https?:\/\//i.test(candidate?.url || ''))
        : [];
      const bestCandidate = candidates[0] || null;
      const manifestCandidates = candidates.filter(candidate =>
        candidate.kind === 'hls' || candidate.kind === 'dash');

      let candidate = bestCandidate;
      if (manifestCandidates.length) {
        let bestOrigin = '';
        try { bestOrigin = new URL(bestCandidate?.url || '').origin; } catch (_) { }
        const bestManifestKind = ['hls', 'dash'].includes(bestCandidate?.kind)
          ? bestCandidate.kind
          : '';

        const sameOriginManifests = bestOrigin
          ? manifestCandidates.filter(item => {
              try {
                return new URL(item.url).origin === bestOrigin
                  && (!bestManifestKind || item.kind === bestManifestKind);
              } catch (_) {
                return false;
              }
            })
          : manifestCandidates;

        candidate = [...(sameOriginManifests.length ? sameOriginManifests : manifestCandidates)]
          .sort((a, b) =>
            Number(b.lastSeenAt || b.foundAt || 0)
            - Number(a.lastSeenAt || a.foundAt || 0))[0];
      }

      if (candidate?.url) {
        url = candidate.url;
        referer = candidate.referer || candidate.pageUrl || location.href;
      }
    }

    if (!url || url === location.href || url.startsWith('blob:')) {
      const manifest = await sendMessageSafe({ action: 'get_hls_manifest' });
      if (manifest?.url && /^https?:\/\//i.test(manifest.url)) {
        url = manifest.url;
        referer = manifest.referer || location.href;
      }
    }

    if (!url || url.startsWith('blob:')) url = location.href;
  }

  return {
    url,
    cacheKey: `${url}|${mediaKey}|${directMediaUrl}|${embeddedUrl}|${mediaTitle}`,
    title: mediaTitle,
    referer,
    mediaUrl: directMediaUrl,
    mediaKey,
    allowDirectFallback
  };
}

async function sendMessageSafe(message) {
  if (_contextInvalidated) {
    return { success: false, error: PD.I18n.t('contentReloadPage') };
  }

  try {
    if (!PDWebExt.runtime?.id) {
      throw new Error('Extension context invalidated.');
    }
    return await PDWebExt.runtime.sendMessage(message);
  } catch (error) {
    const text = String(error?.message || error || '');
    if (/extension context invalidated|receiving end does not exist|message port closed/i.test(text)) {
      _contextInvalidated = true;
      hideButton(true);
      return { success: false, error: PD.I18n.t('contentReloadPage') };
    }
    throw error;
  }
}

function showButton() {
  const btn = getBtn();
  btn.style.display = 'flex';
  btn.style.visibility = 'visible';
  btn.style.opacity = '1';
}

function getButtonHost(media) {
  if (!(media instanceof Element)) {
    return document.body || document.documentElement;
  }

  // Native top-layer elements must own the button; a fixed child of <body>
  // would be painted behind an open <dialog>/<popover>.
  const overlay = getOpenOverlayContainer(media);
  if (overlay) return overlay;

  const fullscreen = document.fullscreenElement;
  if (fullscreen instanceof Element && fullscreen.contains(media)) {
    return fullscreen;
  }

  return document.body || document.documentElement;
}

function mountButtonForMedia(media) {
  const btn = getBtn();
  const host = getButtonHost(media);

  if (host && btn.parentNode !== host) {
    host.appendChild(btn);
  }

  return btn;
}

function hideButton(clearActive = true) {
  if (_btn) {
    _btn.style.opacity = '0';
    _btn.style.visibility = 'hidden';
  }

  if (clearActive) {
    _qualityPanel?.invalidateContext?.();
    _activeMedia = null;
    _activeContextNode = null;
    _activePlayer = null;
    _activeMediaKey = '';
  }
}

function positionBtn(media) {
  const surface = getMediaRenderSurface(media);
  if (!surface) {
    hideButton(true);
    return;
  }

  const rect = surface.getBoundingClientRect();
  const btn = mountButtonForMedia(media);

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const estimatedWidth = Math.max(btn.offsetWidth || 0, 176);
  const top = clamp(rect.top + 10, 8, Math.max(8, window.innerHeight - 40));
  const preferredRight = viewportWidth - rect.right + 12;
  const right = clamp(preferredRight, 8, Math.max(8, viewportWidth - estimatedWidth - 8));

  btn.style.top = `${Math.round(top)}px`;
  btn.style.left = 'auto';
  btn.style.right = `${right}px`;
  _qualityPanel?.setDropdownAlignment('right');
  showButton();
}

function isQualityPanelInteractionActive() {
  if (!_btn) return false;

  // Once the user opens or interacts with the quality panel, media hover/scroll
  // tracking must not tear the panel down. The panel is an independent
  // interactive surface and may extend outside the media player's bounds.
  if (_qualityPanel?.isInteractionActive?.()) return true;

  const active = document.activeElement;
  return (active instanceof Node && _btn.contains(active))
    || !!_btn.matches?.(':hover');
}

function isQualityPanelTarget(target) {
  if (!_btn || !(target instanceof Node)) return false;
  return _qualityPanel?.containsTarget?.(target) ?? _btn.contains(target);
}

function scheduleHide(delay = 450) {
  if (isQualityPanelInteractionActive()) {
    clearHide();
    return;
  }
  if (_hideTimer) return;
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    if (isQualityPanelInteractionActive()) return;
    hideButton(true);
  }, delay);
}

function clearHide() {
  if (_hideTimer) {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }
}

function getSiteUrl(media, contextNode) {
  if (media instanceof HTMLVideoElement) {
    return PD.SiteUrlResolver?.resolve(media, contextNode || media) || location.href;
  }
  return getFrameSource(media) || location.href;
}

function getMediaTitle(media, contextNode) {
  if (media instanceof HTMLVideoElement) {
    return PD.SiteUrlResolver?.getMediaTitle?.(media, contextNode || media)
      || document.title
      || 'video';
  }

  return String(
    (media instanceof HTMLIFrameElement ? _reportedMediaFrameInfo.get(media)?.title : '')
    || media?.getAttribute?.('title')
    || media?.getAttribute?.('aria-label')
    || contextNode?.getAttribute?.('aria-label')
    || document.title
    || 'video'
  ).trim() || 'video';
}

function getDirectMediaUrl(media) {
  if (!(media instanceof HTMLVideoElement)) return '';

  const values = [
    media.currentSrc,
    media.src,
    media.getAttribute('src')
  ];

  for (const source of safeQueryAll(media, 'source[src]')) {
    values.push(source.src, source.getAttribute('src'));
  }

  return values.find(value => /^https?:\/\//i.test(String(value || ''))) || '';
}

function getMediaKey(media, contextNode = media) {
  if (!(media instanceof Element)) return '';

  if (media instanceof HTMLIFrameElement) {
    const values = [
      'iframe',
      getFrameSource(media),
      media.id,
      media.getAttribute('name'),
      contextNode?.id,
      contextNode?.getAttribute?.('data-video-id'),
      contextNode?.getAttribute?.('data-media-id')
    ].map(value => String(value || '').trim()).filter(Boolean);
    return [...new Set(values)].join('|');
  }

  if (!(media instanceof HTMLVideoElement)) return '';

  const wrapper = safeClosest(media, '[id^="xgwrapper-"]');
  const mediaNode = safeClosest(
    media,
    '[data-item-id],[data-video-id],[data-aweme-id],[data-e2e="feed-video"],[data-e2e="browse-video"]'
  );
  const values = [
    'video',
    wrapper?.id,
    mediaNode?.getAttribute?.('data-item-id'),
    mediaNode?.getAttribute?.('data-video-id'),
    mediaNode?.getAttribute?.('data-aweme-id'),
    mediaNode?.id,
    contextNode?.getAttribute?.('data-item-id'),
    contextNode?.getAttribute?.('data-video-id'),
    contextNode?.getAttribute?.('data-aweme-id'),
    media.currentSrc,
    media.src,
    media.getAttribute?.('src'),
    media.poster,
    media.getAttribute?.('poster')
  ].map(value => String(value || '').trim()).filter(Boolean);

  return [...new Set(values)].join('|');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isRenderedMedia(media) {
  return !!getMediaRenderSurface(media);
}

function containsPoint(rect, x, y, margin = 1) {
  return x >= rect.left - margin
    && x <= rect.right + margin
    && y >= rect.top - margin
    && y <= rect.bottom + margin;
}

function addMediaFromRoot(root, candidates) {
  if (!root) return;
  if (isMediaElement(root)) {
    candidates.add(root);
  }

  for (const media of safeQueryAll(root, MEDIA_ELEMENT_SELECTOR)) {
    if (isMediaElement(media)) candidates.add(media);
  }
}

function getMediaContextNode(target, media) {
  const targetElement = target instanceof Element ? target : null;
  const targetContext = safeClosest(targetElement, MEDIA_CONTEXT_SELECTOR);
  if (safeMatches(targetContext, '[aria-label="Video player"]')) {
    return targetContext;
  }
  if (targetContext && (targetContext === media || targetContext.contains(media))) {
    return targetContext;
  }

  return safeClosest(media, MEDIA_CONTEXT_SELECTOR)
    || safeClosest(media, VIDEO_CONTEXT_SELECTOR)
    || media;
}

function getMediaPlayerNode(target, media, contextNode) {
  const targetElement = target instanceof Element ? target : null;
  const pointedPlayer = safeClosest(targetElement, '[aria-label="Video player"]');
  if (pointedPlayer) return pointedPlayer;

  if (safeMatches(contextNode, '[aria-label="Video player"]')) return contextNode;

  if (media instanceof HTMLIFrameElement) {
    return getOpenOverlayContainer(media)
      || safeClosest(media, MEDIA_CONTEXT_SELECTOR)
      || media;
  }

  // Some feeds render controls as a sibling of <video>. Walk to the first
  // compact root that owns one video and one player control layer.
  let root = media?.parentElement || null;
  for (let depth = 0; root && depth < 10; depth++, root = root.parentElement) {
    const players = safeQueryAll(root, '[aria-label="Video player"]');
    const videos = safeQueryAll(root, 'video');

    if (players.length === 1 && videos.length === 1 && videos[0] === media) {
      return players[0];
    }
  }

  const renderSurface = getMediaRenderSurface(media);
  if (renderSurface && renderSurface !== media) return renderSurface;

  return safeClosest(media, '[data-video-id],article,[role="article"],[aria-posinset]')
    || contextNode
    || media;
}

function activateMediaPlayer(media, target) {
  const contextNode = getMediaContextNode(target, media);
  const player = getMediaPlayerNode(target, media, contextNode);
  const mediaKey = getMediaKey(media, contextNode);

  if ((_activePlayer && player !== _activePlayer)
      || (_activeMediaKey && mediaKey !== _activeMediaKey)) {
    _qualityPanel?.invalidateContext?.();
  }

  _activeMedia = media;
  _activeContextNode = contextNode;
  _activePlayer = player;
  _activeMediaKey = mediaKey;

  return { player, mediaKey };
}

function findMediaAtPoint(x, y, target) {
  const candidates = new Set();
  const targetElement = target instanceof Element ? target : null;

  const directMedia = safeClosest(targetElement, MEDIA_ELEMENT_SELECTOR);
  if (isMediaElement(directMedia)) candidates.add(directMedia);

  const stack = document.elementsFromPoint?.(x, y) || (targetElement ? [targetElement] : []);
  for (const element of stack) {
    if (!(element instanceof Element)) continue;

    if (isMediaElement(element)) candidates.add(element);

    const context = safeClosest(element, MEDIA_CONTEXT_SELECTOR)
      || safeClosest(element, VIDEO_CONTEXT_SELECTOR);
    addMediaFromRoot(context, candidates);
  }

  const targetContext = safeClosest(targetElement, MEDIA_CONTEXT_SELECTOR)
    || safeClosest(targetElement, VIDEO_CONTEXT_SELECTOR);
  addMediaFromRoot(targetContext, candidates);

  if (candidates.size === 0) {
    let ancestor = targetElement;
    for (let level = 0; level < 12 && ancestor; level++, ancestor = ancestor.parentElement) {
      addMediaFromRoot(ancestor, candidates);
      if (candidates.size > 0) break;
    }
  }

  const ranked = [];
  for (const media of candidates) {
    const surface = getMediaRenderSurface(media);
    if (!surface) continue;

    const rect = surface.getBoundingClientRect();
    if (!containsPoint(rect, x, y, 2)) continue;

    let score = 0;
    if (surface !== media) score += 35;
    if (media === directMedia) score += 1000;
    if (safeClosest(media, '[data-video-id]')) score += 160;
    if (media instanceof HTMLVideoElement) {
      if (!media.paused && !media.ended) score += 80;
      if (media.currentSrc || media.src) score += 30;
      if (media.readyState > 0) score += 20;
    } else if (media instanceof HTMLIFrameElement) {
      score += Math.min(200, Math.max(0, getFrameSemanticScore(media)));
      if (document.activeElement === media) score += 200;
    }

    const mediaContext = safeClosest(media, MEDIA_CONTEXT_SELECTOR)
      || safeClosest(media, VIDEO_CONTEXT_SELECTOR);
    for (let index = 0; index < stack.length; index++) {
      const painted = stack[index];
      if (!(painted instanceof Element)) continue;

      if (painted === surface || surface.contains?.(painted)
          || painted === media || media.contains?.(painted)) {
        score += Math.max(300, 600 - (index * 20));
        break;
      }

      const paintedContext = safeClosest(painted, MEDIA_CONTEXT_SELECTOR)
        || safeClosest(painted, VIDEO_CONTEXT_SELECTOR);
      if (mediaContext && paintedContext === mediaContext) {
        score += Math.max(180, 420 - (index * 15));
        break;
      }
    }

    const centerDistance = Math.hypot(
      x - (rect.left + rect.width / 2),
      y - (rect.top + rect.height / 2)
    );
    const area = rect.width * rect.height;
    score -= centerDistance / 100;

    ranked.push({ media, score, area });
  }

  ranked.sort((a, b) => (b.score - a.score) || (a.area - b.area));
  return ranked[0]?.media || null;
}

function getMediaUnderLastPointer() {
  if (!_lastPointerEvent) return null;

  const { clientX, clientY, target: previousTarget } = _lastPointerEvent;
  const target = document.elementFromPoint?.(clientX, clientY) || previousTarget;
  const media = findMediaAtPoint(clientX, clientY, target);

  return { media, target };
}

function activateDirectMedia(media, target = media) {
  if (!isRenderedMedia(media)) return false;
  const context = getMediaContextNode(target, media);
  const mediaKey = getMediaKey(media, context);
  if (mediaKey && mediaKey === _dismissedMediaKey) return false;
  if (_dismissedMediaKey && mediaKey !== _dismissedMediaKey) _dismissedMediaKey = '';

  clearHide();
  activateMediaPlayer(media, target);
  positionBtn(media);
  return true;
}

function findProminentVisibleMedia() {
  const candidates = [];
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);

  for (const media of safeQueryAll(document, MEDIA_ELEMENT_SELECTOR)) {
    const surface = getMediaRenderSurface(media);
    if (!surface) continue;
    const rect = surface.getBoundingClientRect();
    const area = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const overlay = getOpenOverlayContainer(media);
    let score = (area / viewportArea) * 300;

    if (surface !== media) score += 35;
    if (overlay) score += 500;
    if (media instanceof HTMLVideoElement && !media.paused && !media.ended) score += 180;
    if (media instanceof HTMLIFrameElement) {
      score += Math.min(180, Math.max(0, getFrameSemanticScore(media)));
      if (document.activeElement === media) score += 250;
    }
    if (isTopmostAtCenter(media)) score += 120;

    candidates.push({ media, score, area });
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.area - a.area));
  const best = candidates[0];
  if (!best) return null;

  // Auto-activation is intentionally conservative on normal pages, but an
  // open overlay/dialog or an active/playing media element is enough. This
  // catches dynamically inserted players without any Fancybox-specific code.
  const autoEligible = !!getOpenOverlayContainer(best.media)
    || document.activeElement === best.media
    || (best.media instanceof HTMLVideoElement && !best.media.paused && !best.media.ended);
  return autoEligible && best.score >= 250 ? best.media : null;
}

function getChildFrameForWindow(sourceWindow) {
  if (!sourceWindow) return null;

  for (const frame of safeQueryAll(document, 'iframe')) {
    try {
      if (frame.contentWindow === sourceWindow) return frame;
    } catch (_) { }
  }

  return null;
}

function hasLocalRenderableMedia() {
  for (const media of safeQueryAll(document, MEDIA_ELEMENT_SELECTOR)) {
    if (media instanceof HTMLVideoElement && getMediaRenderSurface(media)) return true;
    if (media instanceof HTMLIFrameElement && isLikelyMediaFrame(media) && getMediaRenderSurface(media)) return true;
  }
  return false;
}

let _lastFrameMediaReport = '';
let _frameReportRaf = 0;
function reportFrameMediaState(force = false) {
  if (IS_TOP_FRAME) return;

  const hasMedia = hasLocalRenderableMedia();
  const payload = {
    channel: FRAME_MEDIA_MESSAGE,
    hasMedia,
    pageUrl: location.href,
    title: document.title || ''
  };
  const signature = `${hasMedia}|${payload.pageUrl}|${payload.title}`;
  if (!force && signature === _lastFrameMediaReport) return;
  _lastFrameMediaReport = signature;

  try { window.parent.postMessage(payload, '*'); } catch (_) { }
}

function queueFrameMediaReport(force = false) {
  if (IS_TOP_FRAME) return;
  if (force) _lastFrameMediaReport = '';
  if (_frameReportRaf) return;
  _frameReportRaf = requestAnimationFrame(() => {
    _frameReportRaf = 0;
    reportFrameMediaState(force);
  });
}

function handleFrameMediaMessage(event) {
  const data = event?.data;
  if (!data || data.channel !== FRAME_MEDIA_MESSAGE) return;

  const frame = getChildFrameForWindow(event.source);
  if (!(frame instanceof HTMLIFrameElement)) return;

  if (data.hasMedia) {
    _reportedMediaFrames.add(frame);
    _reportedMediaFrameInfo.set(frame, {
      pageUrl: /^https?:\/\//i.test(String(data.pageUrl || '')) ? String(data.pageUrl) : '',
      title: String(data.title || '')
    });
  } else {
    _reportedMediaFrames.delete(frame);
    _reportedMediaFrameInfo.delete(frame);
    if (_activeMedia === frame) hideButton(true);
  }

  // A nested child report makes this iframe a media-bearing frame too. Top
  // documents rescan their own DOM; intermediate frames forward their new
  // aggregate state upward so arbitrarily nested embeds still have one owner.
  if (IS_TOP_FRAME) {
    queueMediaScan();
    if (_lastPointerEvent) queuePointerProcessing(true);
  } else {
    queueFrameMediaReport(true);
  }
}

function initFrameMediaReporter() {
  if (IS_TOP_FRAME) return;

  const observer = new MutationObserver(() => queueFrameMediaReport(false));
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: MEDIA_MUTATION_ATTRIBUTES
  });

  document.addEventListener('play', () => queueFrameMediaReport(true), true);
  document.addEventListener('loadstart', () => queueFrameMediaReport(true), true);
  document.addEventListener('loadedmetadata', () => queueFrameMediaReport(true), true);
  window.addEventListener('pageshow', () => queueFrameMediaReport(true));
  window.addEventListener('hashchange', () => queueFrameMediaReport(true));
  window.addEventListener('popstate', () => queueFrameMediaReport(true));

  queueFrameMediaReport(true);
}

window.addEventListener('message', handleFrameMediaMessage, false);

let _scanFrame = 0;
function queueMediaScan() {
  if (_scanFrame || usesDedicatedYouTubePanel()) return;
  _scanFrame = requestAnimationFrame(() => {
    _scanFrame = 0;
    if (_contextInvalidated) return;

    if (_activeMedia && isRenderedMedia(_activeMedia)) {
      positionBtn(_activeMedia);
      return;
    }

    if (_activeMedia && !_activeMedia.isConnected) hideButton(true);
    const media = findProminentVisibleMedia();
    if (media) activateDirectMedia(media, media);
  });
}

function queuePointerProcessing(forceRefresh = false) {
  if (forceRefresh) _forcePointerRefresh = true;
  if (!_pointerFrame) {
    _pointerFrame = requestAnimationFrame(processPointerEvent);
  }
}

function processPointerEvent() {
  _pointerFrame = 0;
  const forceRefresh = _forcePointerRefresh;
  _forcePointerRefresh = false;

  if (!_lastPointerEvent || _contextInvalidated || usesDedicatedYouTubePanel()) return;

  const pointed = getMediaUnderLastPointer();
  const target = pointed?.target || _lastPointerEvent.target;

  // The quality panel is its own interaction surface. Never reinterpret
  // pointer movement over it as movement away from the active media, including
  // forced refreshes caused by scroll/resize.
  if (isQualityPanelTarget(target) || isQualityPanelInteractionActive()) {
    clearHide();
    return;
  }

  const media = pointed?.media || null;
  if (!media) {
    scheduleHide(350);
    return;
  }

  activateDirectMedia(media, target);
}

function initListeners() {
  if (!IS_TOP_FRAME || usesDedicatedYouTubePanel()) return;

  const rememberPointer = event => {
    _lastPointerEvent = {
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target
    };
  };

  document.addEventListener('pointermove', event => {
    rememberPointer(event);
    queuePointerProcessing(false);
  }, true);

  // `mouseover` fires on the iframe element in the parent document immediately
  // before pointer events start going to the cross-origin child frame. This is
  // a reliable hand-off point for embedded players.
  document.addEventListener('mouseover', event => {
    const media = safeClosest(event.target, MEDIA_ELEMENT_SELECTOR);
    if (isMediaElement(media)) {
      rememberPointer(event);
      activateDirectMedia(media, event.target);
    }
  }, true);

  document.addEventListener('pointerdown', event => {
    if (isQualityPanelTarget(event.target)) {
      clearHide();
      return;
    }
    rememberPointer(event);

    const pointed = getMediaUnderLastPointer();
    if (pointed?.media) activateDirectMedia(pointed.media, pointed.target);
  }, true);

  document.addEventListener('focusin', event => {
    const media = safeClosest(event.target, MEDIA_ELEMENT_SELECTOR);
    if (isMediaElement(media)) activateDirectMedia(media, event.target);
  }, true);

  window.addEventListener('blur', () => {
    // Clicking into a cross-origin iframe moves focus to the iframe element in
    // the parent document while the parent window loses focus.
    setTimeout(() => {
      const media = document.activeElement;
      if (isMediaElement(media)) activateDirectMedia(media, media);
    }, 0);
  });

  document.addEventListener('play', event => {
    if (event.target instanceof HTMLVideoElement) activateDirectMedia(event.target, event.target);
  }, true);

  document.addEventListener('pointerleave', () => scheduleHide(150), true);

  const handleMediaIdentityChange = event => {
    if (!(event.target instanceof HTMLVideoElement)) return;

    if (event.target === _activeMedia) {
      _qualityPanel?.invalidateContext?.();
      _activeMediaKey = '';
    }

    queuePointerProcessing(true);
    queueMediaScan();
  };

  document.addEventListener('loadstart', handleMediaIdentityChange, true);
  document.addEventListener('emptied', handleMediaIdentityChange, true);
  document.addEventListener('loadedmetadata', handleMediaIdentityChange, true);
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLIFrameElement && isLikelyMediaFrame(event.target)) {
      if (event.target === _activeMedia) {
        _qualityPanel?.invalidateContext?.();
        _activeMediaKey = '';
      }
      queueMediaScan();
    }
  }, true);

  const observer = new MutationObserver(mutations => {
    let shouldScan = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        if (_activeMedia && !_activeMedia.isConnected) hideButton(true);
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (!(node instanceof Element)) continue;
          if (isMediaElement(node) || safeQueryAll(node, MEDIA_ELEMENT_SELECTOR).length) {
            shouldScan = true;
            break;
          }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (!(target instanceof Element)) continue;
        if (isMediaElement(target)
            || target === _activeMedia
            || target.contains?.(_activeMedia)
            || safeQueryAll(target, MEDIA_ELEMENT_SELECTOR).length) {
          shouldScan = true;
        }
      }

      if (shouldScan) break;
    }

    if (shouldScan) queueMediaScan();
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: MEDIA_MUTATION_ATTRIBUTES
  });

  const reposition = () => {
    if (_activeMedia && isRenderedMedia(_activeMedia)) {
      positionBtn(_activeMedia);
    } else {
      hideButton(true);
      queueMediaScan();
    }
  };

  window.addEventListener('scroll', event => {
    // Capture-phase scroll listeners also receive scrolling from the dropdown's
    // own list. Scrolling inside the panel must never be treated as the user
    // leaving the media player.
    if (isQualityPanelTarget(event.target) || isQualityPanelInteractionActive()) {
      clearHide();
      return;
    }

    if (_lastPointerEvent) {
      queuePointerProcessing(true);
    } else {
      reposition();
    }
  }, true);

  window.addEventListener('resize', () => {
    if (_lastPointerEvent) {
      queuePointerProcessing(true);
    } else {
      reposition();
    }
  }, { passive: true });

  // Initial pass catches players already present when the content script loads.
  queueMediaScan();
}

if (IS_TOP_FRAME) initListeners();
else initFrameMediaReporter();

document.addEventListener('click', (e) => {
  let t = e.target;
  while (t && t.tagName !== 'A') t = t.parentElement;
  if (t?.href?.startsWith('magnet:')) {
    e.preventDefault();
    void sendMessageSafe({ action: 'download_magnet', url: t.href });
  }
}, true);
