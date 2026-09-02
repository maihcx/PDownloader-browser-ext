const VIDEO_CONTEXT_SELECTOR = [
  '[data-video-id]',
  '[aria-label="Video player"]',
  '[data-testid*="video" i]',
  '[data-e2e*="video" i]',
  'article',
  '[role="article"]'
].join(',');

// One DOM scanner for every host. No provider/domain dispatch.
const PLAYER_PLACEHOLDER_SELECTOR = '.html5-video-player,.jwplayer,.video-js,.dplayer,[data-video-player]';
// A player shell groups its video, poster and sibling controls; it is not an
// additional media candidate. In particular, do not add .plyr to the scanner.
const PLAYER_CONTAINER_SELECTOR = PLAYER_PLACEHOLDER_SELECTOR + ',.plyr';
const MEDIA_ELEMENT_SELECTOR = 'video,iframe,' + PLAYER_PLACEHOLDER_SELECTOR;
const MEDIA_CONTEXT_SELECTOR = [
  '[data-video-id]',
  '[aria-label="Video player"]',
  '[data-testid*="video" i]',
  '[data-testid*="player" i]',
  '[data-e2e*="video" i]',
  '[data-e2e*="player" i]',
  '[class*="video" i]',
  '[class*="player" i]',
  '[id*="video" i]',
  '[id*="player" i]',
  'article',
  '[role="article"]',
  'dialog',
  '[role="dialog"]',
  '[aria-modal="true"]'
].join(',');
const MEDIA_MUTATION_ATTRIBUTES = [
  'src', 'data-src', 'poster', 'href', 'id', 'data-video-id', 'data-media-id', 'data-item-id', 'data-aweme-id',
  'class', 'open', 'hidden', 'aria-hidden', 'srcset', 'sizes', 'media', 'alt'
];
const MEDIA_SURFACE_SELECTOR = [
  '[aria-label="Video player"]',
  '[data-testid*="player" i]',
  '[data-testid*="video" i]',
  '[data-e2e*="player" i]',
  '[data-e2e*="video" i]',
  '[class*="player" i]',
  '[class*="video" i]',
  '[id*="player" i]',
  '[id*="video" i]'
].join(',');


let _activeMedia = null;
let _activeContextNode = null;
let _activePlayer = null;
let _activeMediaKey = '';
let _activeAnchor = null;
let _activeIdentity = null;
let _activeLinkedItem = null;
// Explicit pointer selection outranks the previous preview's open picker.
// Retain the next card while the site's shared preview is still loading it.
let _pointerFeedAnchor = null;
let _feedPointerInside = false;
let _feedHideTimer = 0;
let _imageHideTimer = 0;
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
  if (element.assignedSlot) return element.assignedSlot;
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

function containsComposedElement(container, element) {
  if (!(container instanceof Element) || !(element instanceof Element)) return false;
  if (container === element || container.contains(element)) return true;
  for (let node = element, depth = 0; node && depth < 64; depth++, node = getSelectorParent(node)) {
    if (node === container) return true;
  }
  return false;
}

function getPaintedElementAtPoint(x, y) {
  let element = document.elementFromPoint?.(x, y) || null;
  const visited = new Set();
  // Document-level hits may be retargeted to a custom-element host. Only
  // descend the top painted branch of an OPEN shadow root; never look through
  // unrelated dialogs/overlays to a player underneath them.
  for (let depth = 0; element && depth < 16; depth++) {
    const shadow = element.shadowRoot;
    if (!shadow || visited.has(shadow)) break;
    visited.add(shadow);
    const inner = shadow.elementFromPoint?.(x, y) || shadow.elementsFromPoint?.(x, y)?.[0];
    if (!(inner instanceof Element) || inner === element) break;
    element = inner;
  }
  return element;
}

function getPaintedStackAtPoint(x, y) {
  const top = getPaintedElementAtPoint(x, y);
  const stack = top ? [top] : [];
  // Retain composed ancestors, including slot/host boundaries, for ownership
  // lookup when Flutter projects a light-DOM video into its rendering tree.
  for (let node = getSelectorParent(top), depth = 0; node && depth < 64; depth++, node = getSelectorParent(node)) stack.push(node);
  stack.push(...(document.elementsFromPoint?.(x, y) || []));
  return [...new Set(stack)];
}

function getKnownPlayerContainer(media) {
  if (media instanceof HTMLImageElement || media instanceof HTMLIFrameElement) return null;
  const player = safeClosest(media, PLAYER_CONTAINER_SELECTOR);
  if (!player) return null;
  const owned = [...safeQueryAll(player, 'video,iframe')];
  if (safeMatches(player, 'video,iframe')) owned.unshift(player);
  return owned.length === 1 && (owned[0] === media || player === media) ? player : null;
}

function getSiblingPlayerGroup(media) {
  if (!(media instanceof HTMLVideoElement) || !media.isConnected) return null;
  // Some players put their accessible control layer in a parallel DOM branch,
  // not above the <video>. Resolve their first common, single-media container;
  // obfuscated wrapper classes and blob URLs are not player identity.
  let root = getSelectorParent(media);
  for (let depth = 0; root && depth < 16; depth++, root = getSelectorParent(root)) {
    if (root === document.body || root === document.documentElement) break;
    const owned = [...safeQueryAll(root, 'video,iframe')];
    if (owned.length > 1) return null;
    if (owned.length !== 1 || owned[0] !== media) continue;
    const controls = [...safeQueryAll(root, '[aria-label="Video player"]')];
    if (controls.length > 1) return null;
    if (controls.length === 1 && !containsComposedElement(controls[0], media)) {
      return { container: root, controls: controls[0] };
    }
  }
  return null;
}

function getWrappingMediaCard(media, item = PD.MediaContext.getItemLink(media)) {
  if (!(media instanceof Element) || media instanceof HTMLImageElement || media instanceof HTMLIFrameElement) return null;
  const card = safeClosest(media, 'a[href]');
  if (!card || card === media || !item?.url
      || !PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(card))
      || !card.querySelector('img,picture')) return null;
  const owned = [...safeQueryAll(card, 'video,iframe')];
  // A thumbnail link with one inline preview is also a stable feed card.
  // Never adopt a multi-player container or a publisher/profile link.
  return owned.length === 1 && (owned[0] === media || media.contains(owned[0])) ? card : null;
}

function isMediaHitAtPoint(media, x, y, painted = getPaintedElementAtPoint(x, y)) {
  if (!(painted instanceof Element)) return false;
  const surface = getMediaRenderSurface(media);
  if (!surface) return false;
  if (isQualityPanelTarget(painted)) return media === _activeMedia;
  if (media instanceof HTMLImageElement) return isImageHitAtPoint(media, painted, x, y);
  if (containsComposedElement(surface, painted)) return true;
  if (painted instanceof HTMLImageElement && PD.ImageMedia?.getVideoOwner(painted) === media) return true;
  const player = getKnownPlayerContainer(media);
  if (player) {
    if (containsComposedElement(player, painted)) return true;
    // A detached preview can put its clickable cover/controls OUTSIDE the
    // inner playback engine. Accept only its single-video preview wrapper,
    // over the thumbnail whose permalink matches this player's title link.
    const item = isFeedPreview(media) && PD.MediaContext.getItemLink(media);
    const anchor = item?.url && getMediaAnchor(media, item);
    if (anchor?.localName === 'a' && !anchor.contains(media)
        && containsPoint(anchor.getBoundingClientRect(), x, y)
        && PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(anchor))) {
      let root = getSelectorParent(player);
      for (let depth = 0; root && depth < 10; depth++, root = getSelectorParent(root)) {
        if (root === document.body || root === document.documentElement) break;
        const owned = [...safeQueryAll(root, 'video,iframe')];
        if (owned.length > 1) break;
        if (owned.length === 1 && owned[0] === media
            && safeMatches(root, '[class*="preview" i],[id*="preview" i]')
            && containsComposedElement(root, painted)) return true;
      }
    }
    return false;
  }
  const card = getWrappingMediaCard(media);
  if (card && containsComposedElement(card, painted)) return true;
  const siblingPlayer = getSiblingPlayerGroup(media);
  // The top painted node may be the sibling play/mute/seek layer. Both hover
  // and periodic scans must recognize it as this video's own controls. Do not
  // accept arbitrary overlays elsewhere inside a shared feed/page container.
  if (siblingPlayer && containsComposedElement(siblingPlayer.controls, painted)) return true;
  // A <video class="video-..."> must not become its own context: a sibling
  // poster/control layer belongs to the common container, not to the video.
  const context = safeClosest(getSelectorParent(surface), MEDIA_CONTEXT_SELECTOR);
  if (!context || !containsComposedElement(context, painted)) return false;
  const owned = [...safeQueryAll(context, 'video,iframe')];
  return owned.length === 1 && owned[0] === media;
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

function isVideoElement(element) {
  return element instanceof HTMLVideoElement || isLikelyMediaFrame(element)
    || (element instanceof Element && safeMatches(element, PLAYER_PLACEHOLDER_SELECTOR)
      && !element.querySelector('video,iframe'));
}

function isMediaElement(element) {
  return isVideoElement(element) || !!PD.ImageMedia?.isEligible(element);
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
  for (let depth = 0; current && depth < 64; depth++, current = getSelectorParent(current)) {
    if (current.hidden) return false;

    const style = getComputedStyle(current);
    // visibility is inherited and may be explicitly restored on a slotted
    // child. Its own computed value is authoritative; opacity/display on
    // ancestors still suppress the entire rendered subtree.
    if (style.display === 'none'
        || (current === element && (style.visibility === 'hidden' || style.visibility === 'collapse'))
        || Number.parseFloat(style.opacity || '1') <= 0.01) {
      return false;
    }

    if (current === document.body || current === document.documentElement) break;
  }

  return true;
}

function getMediaRenderSurface(media) {
  // A hover-selected permalink card is usable before its disposable preview
  // creates a <video>. It is not an image or an automatic scan candidate.
  if (media === _activeLinkedItem?.anchor && isLinkedItemCurrent()) return media;
  if (!isMediaElement(media) || !media.isConnected) return null;

  // Prefer the media node when it is actually painted. `aria-hidden` is
  // intentionally ignored here: it changes accessibility exposure, not
  // visual rendering. Several modern players mark their visual media layer
  // aria-hidden while it remains the real playback surface.
  if (isElementVisuallyRendered(media, 60, 40)) return media;
  if (media instanceof HTMLImageElement) return null;
  const card = getWrappingMediaCard(media);
  if (card && isElementVisuallyRendered(card, 120, 70)) return card;
  const siblingPlayer = getSiblingPlayerGroup(media);
  if (siblingPlayer && isElementVisuallyRendered(siblingPlayer.controls, 120, 70)) {
    return siblingPlayer.controls;
  }

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
  const rect = media instanceof HTMLImageElement ? PD.ImageMedia?.getVisibleRect(media) : surface.getBoundingClientRect();
  if (!rect) return false;
  const x = clamp(rect.left + rect.width / 2, 0, Math.max(0, window.innerWidth - 1));
  const y = clamp(rect.top + rect.height / 2, 0, Math.max(0, window.innerHeight - 1));
  return isMediaHitAtPoint(media, x, y);
}

function getBtn() {
  if (_btn) return _btn;

  if (!PD.QualityAnalyzer) {
    throw new Error('Quality analyzer is not available.');
  }

  _qualityPanel = PD.QualityAnalyzer.createPanel({
    fixed: true,
    getContext: () => resolveQualityContext(_activeMedia, _activeContextNode),
    getVideo: () => {
      if (_activeLinkedItem) {
        const current = PD.MediaContext.getItemLink(_activeMedia);
        if (!isLinkedItemCurrent() || !current
            || !PD.MediaContext.linksMatch(current.url, _activeLinkedItem.url)) return null;
      }
      return _activeMedia?.isConnected ? _activeMedia : _activeAnchor;
    },
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

function resolveQualityContext(media, contextNode) {
  if (media === _activeMedia && _activeLinkedItem) {
    if (!isLinkedItemCurrent()) return null;
    // A feed card is the download target. The site's shared hover video may
    // be unloaded/reused while the user searches formats or presses Download.
    return PD.MediaContext.resolve(_activeLinkedItem.anchor, _activeLinkedItem.anchor, {
      itemUrl: _activeLinkedItem.url, itemTitle: _activeLinkedItem.title,
      mediaKey: _activeMediaKey
    });
  }
  // Preview nodes may be temporarily detached while the clicked toolbar is
  // still in use. The visible, previously validated player remains its owner.
  if (media === _activeMedia && !media?.isConnected
      && isQualityPanelInteractionActive() && isElementVisuallyRendered(_activeAnchor, 120, 70)) {
    media = _activeAnchor;
  }
  if (!media?.isConnected || (!isMediaElement(media) && media !== _activeAnchor)) return null;
  return PD.MediaContext.resolve(media, contextNode, {
    frameUrl: media instanceof HTMLIFrameElement ? getFrameSource(media) : '',
    frameTitle: media instanceof HTMLIFrameElement ? _reportedMediaFrameInfo.get(media)?.title : '',
    mediaKey: getMediaKey(media)
  });
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
  clearImageHide();
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
    _activeAnchor = null;
    _activeIdentity = null;
    _activeLinkedItem = null;
  }
}

function positionBtn(media) {
  if (media === _activeMedia && _activeMediaKey && _activeMediaKey === _dismissedMediaKey) return;
  const surface = (media === _activeMedia && isLinkedItemCurrent() ? _activeLinkedItem.anchor : null)
    || getMediaRenderSurface(media)
    || (media === _activeMedia && isQualityPanelInteractionActive()
      && isElementVisuallyRendered(_activeAnchor, 120, 70) ? _activeAnchor : null);
  if (!surface) {
    hideButton(true);
    return;
  }

  // A scan/play event has just confirmed a live owner. An earlier pointer
  // leave timeout must not hide it again after this successful reconciliation.
  clearHide();

  const rect = media instanceof HTMLImageElement ? PD.ImageMedia?.getVisibleRect(media) : surface.getBoundingClientRect();
  if (!rect) { hideButton(true); return; }
  const btn = mountButtonForMedia(media);
  _qualityPanel?.setMediaType(media instanceof HTMLImageElement ? 'image' : 'video');

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const estimatedWidth = Math.max(btn.offsetWidth || 0, 138);
  const top = clamp(rect.top + 10, 8, Math.max(8, window.innerHeight - 40));
  const left = clamp(rect.left + 12, 8, Math.max(8, viewportWidth - estimatedWidth - 8));

  btn.style.top = `${Math.round(top)}px`;
  btn.style.left = `${Math.round(left)}px`;
  btn.style.right = 'auto';
  _qualityPanel?.setDropdownAlignment('left');
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
  if (_activeMedia instanceof HTMLImageElement) { scheduleImageHide(); return; }
  if (isLinkedItemPinned()) { clearHide(); return; }
  if (isQualityPanelInteractionActive()) {
    clearHide();
    return;
  }
  if (_hideTimer) return;
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    if (isLinkedItemPinned()) { positionBtn(_activeMedia); return; }
    if (isQualityPanelInteractionActive()) return;
    // Pointer events stop reaching this document inside a cross-origin
    // iframe. Leaving the parent document is therefore not evidence that the
    // player disappeared. Use the same eligibility rule as automatic scans.
    if (_activeMedia && _activeMediaKey !== _dismissedMediaKey
        && isRenderedMedia(_activeMedia) && isTopmostAtCenter(_activeMedia)) {
      positionBtn(_activeMedia);
      return;
    }
    hideButton(true);
  }, delay);
}

function clearHide() {
  if (_hideTimer) {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }
}

function clearImageHide() {
  clearTimeout(_imageHideTimer);
  _imageHideTimer = 0;
}

function scheduleImageHide() {
  if (_imageHideTimer) return;
  const image = _activeMedia;
  _imageHideTimer = setTimeout(() => {
    _imageHideTimer = 0;
    if (_activeMedia !== image || !(image instanceof HTMLImageElement)) return;
    // An open list or its focused input does not pin an image after pointer
    // exit. Allow the small gap between the toolbar and portaled popup.
    if (_qualityPanel?.isPointerInteractionActive?.()) return;
    if (_lastPointerEvent) {
      const { clientX: x, clientY: y } = _lastPointerEvent;
      const target = getPaintedElementAtPoint(x, y);
      if (isQualityPanelTarget(target) || imageAtPoint(target, x, y) === image) return;
    }
    hideButton(true);
  }, 240);
}

function isImageHitAtPoint(image, painted, x, y) {
  const visible = PD.ImageMedia?.getVisibleRect(image);
  if (!visible || !(painted instanceof Element)) return false;
  const insideImage = containsPoint(visible, x, y, 0);
  if (painted === image) return insideImage;
  if (safeClosest(painted, 'video,iframe')) return false;
  const overlay = safeClosest(painted, 'dialog,[role="dialog"],[aria-modal="true"],:popover-open');
  if (overlay && !containsComposedElement(overlay, image)) return false;
  const photoLink = PD.ImageMedia?.getPhotoLink(image);
  // A single-photo link also owns its colored backdrop and click overlay.
  // Hover can be in that backdrop while the toolbar remains anchored to the
  // visible image. Never extend this rule to a multi-photo gallery/container.
  if (photoLink && containsComposedElement(photoLink, painted)
      && containsPoint(photoLink.getBoundingClientRect(), x, y, 0)) return true;
  if (!insideImage) return false;
  const imageBox = image.getBoundingClientRect();
  for (let root = getSelectorParent(image), depth = 0; root && depth < 10; root = getSelectorParent(root), depth++) {
    if (root === document.body || root === document.documentElement) break;
    if (!containsComposedElement(root, painted)) continue;
    // A sibling shading/click layer belongs to the first compact container
    // owning exactly this image, not to a gallery, post, or page-wide overlay.
    const images = [...safeQueryAll(root, 'img')];
    const box = root.getBoundingClientRect();
    return images.length === 1 && images[0] === image
      && box.width <= imageBox.width * 1.5 && box.height <= imageBox.height * 1.5;
  }
  return false;
}

function imageAtPoint(target, x, y, includePosters = false) {
  const painted = getPaintedElementAtPoint(x, y) || target;
  if (isQualityPanelTarget(painted)) return null;
  const candidates = new Set([painted, ...(document.elementsFromPoint?.(x, y) || [])]
    .filter(element => element instanceof HTMLImageElement));
  const pointedLink = safeClosest(painted, 'a[href]');
  for (const image of safeQueryAll(pointedLink, 'img')) {
    if (PD.ImageMedia?.getPhotoLink(image) === pointedLink) candidates.add(image);
  }
  // pointer-events:none images are absent from elementsFromPoint. Resolve
  // them through only the nearest unambiguous image/overlay container.
  for (let root = painted, depth = 0; root instanceof Element && depth < 10; root = getSelectorParent(root), depth++) {
    if (root === document.body || root === document.documentElement) break;
    const images = [...safeQueryAll(root, 'img')];
    if (images.length > 1) break;
    if (images.length === 1) { candidates.add(images[0]); break; }
  }
  for (const image of candidates) {
    if (!includePosters && !PD.ImageMedia?.isEligible(image)) continue;
    const rect = PD.ImageMedia?.getVisibleRect(image);
    if (PD.ImageMedia?.hasVisibleSize(image, rect) && isImageHitAtPoint(image, painted, x, y)) return image;
  }
  return null;
}

function selectPointedImage(target, x, y) {
  const wasImage = _activeMedia instanceof HTMLImageElement;
  if (isQualityPanelTarget(target) || _qualityPanel?.isGestureActive?.()) {
    if (wasImage) clearImageHide();
    return wasImage;
  }
  // Unloading an inline preview reveals its cover; it does not turn the
  // already selected video card into a new image-download target.
  if (isLinkedItemCurrent() && containsComposedElement(_activeLinkedItem.anchor, target)) return false;
  const poster = imageAtPoint(target, x, y, true);
  const owner = PD.ImageMedia?.getVideoOwner(poster);
  if (owner) {
    // Release an image picker before the general interaction lock runs. This
    // also handles a lazy player appearing behind its already-selected cover.
    if (wasImage) hideButton(true);
    // Continue through normal video/card selection so the existing feed
    // hover rules can close an old card before activating the new player.
    return false;
  }
  const image = imageAtPoint(target, x, y);
  if (image) {
    if (_activeMedia !== image) {
      hideButton(true);
      // A photo is not the next video feed card. Release any pending preview
      // selection so it cannot invalidate the image picker on pointer move.
      _pointerFeedAnchor = null; _feedPointerInside = false; clearFeedHide();
    }
    clearImageHide();
    activateDirectMedia(image, image);
    return true;
  }
  if (!wasImage) return false;
  const media = safeClosest(target, MEDIA_ELEMENT_SELECTOR);
  if (isMediaElement(media)) { hideButton(true); return false; }
  scheduleImageHide();
  return true;
}

function getMediaTitle(media, contextNode) {
  return PD.MediaContext.getMediaTitle(media, contextNode);
}

function getDirectMediaUrl(media) {
  return PD.MediaContext.getDirectMediaUrl(media);
}

const _mediaIds = new WeakMap();
let _nextMediaId = 0;

function isVideoCardLink(link) {
  if (link?.localName !== 'a' || !link.querySelector('img,picture')) return false;
  if (link.querySelectorAll('video,iframe').length > 1) return false;
  try {
    const url = new URL(PD.MediaContext.linkUrl(link));
    // Require an item, not a feed/category/profile or arbitrary image link.
    // Use the actual permalink; do not infer a video ID from its thumbnail.
    return /\.(?:mp4|webm|m3u8|mpd)$/i.test(url.pathname)
      || /(?:^|\/)(?:videos?|shorts|reels?|embed|watch)\/[^/]+\/?$/i.test(url.pathname)
      || (/(?:^|\/)watch\/?$/i.test(url.pathname) && !!url.searchParams.get('v')?.trim());
  } catch (_) { return false; }
}

function getVideoCardRoot(card) {
  if (!isVideoCardLink(card)) return card;
  const url = PD.MediaContext.linkUrl(card);
  // The image, title and hover-feedback layer are siblings in modern cards.
  // Stop at their first shared single-item root, never at the entire grid.
  let parent = card.parentElement;
  for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) break;
    const thumbnails = [...safeQueryAll(parent, 'a[href]')].filter(isVideoCardLink);
    if (thumbnails.length !== 1 || thumbnails[0] !== card
        || safeQueryAll(parent, 'video,iframe').length > 1) break;
    const title = [...safeQueryAll(parent, 'a[href]')].find(link => link !== card
      && PD.MediaContext.linksMatch(url, PD.MediaContext.linkUrl(link))
      && (link.closest('h1,h2,h3,[role="heading"]') || /title/i.test(link.className + ' ' + link.id)));
    if (title) return parent;
  }
  return card;
}

function isVideoCardRendered(card) {
  if (isElementVisuallyRendered(card, 120, 70)) return true;
  // A preview may hide only the image link while leaving its layout/card in
  // place. The card must still be mounted and visibly occupy that same area.
  if (!card?.isConnected) return false;
  const root = getVideoCardRoot(card);
  if (root === card || !isElementVisuallyRendered(root, 120, 70)) return false;
  const rect = card.getBoundingClientRect();
  return rect.width >= 120 && rect.height >= 70 && card.getClientRects().length > 0
    && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function isCardPreviewHit(card, painted, x, y) {
  if (!(painted instanceof Element)) return false;
  const box = card.getBoundingClientRect();
  let root = painted;
  for (let depth = 0; root && depth < 16; depth++, root = getSelectorParent(root)) {
    if (root === document.body || root === document.documentElement
        || safeMatches(root, 'dialog,[role="dialog"],[aria-modal="true"]')) break;
    if (!safeMatches(root, '[class*="preview" i],[id*="preview" i]')) continue;
    const owned = [...safeQueryAll(root, 'video,iframe')];
    if (owned.length > 1) break;
    if (owned.length !== 1 || !(owned[0] instanceof HTMLVideoElement)
        || !isElementVisuallyRendered(root, 120, 70)) continue;
    const rect = root.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left))
      * Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
    if (!containsPoint(rect, x, y) || rect.width > box.width * 1.8 || rect.height > box.height * 1.8
        || overlap < Math.min(box.width * box.height, rect.width * rect.height) * 0.7) continue;
    const item = PD.MediaContext.getItemLink(owned[0]);
    if (item?.url) return PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(card));
    // Retain only an already selected card while its preview loads/recycles.
    // This grants visual ownership, NOT the preview's URL or media identity.
    // Download context remains the frozen permalink; PiP still needs a match.
    return card === _activeLinkedItem?.anchor && isLinkedItemCurrent();
  }
  return false;
}

function getVideoCardTitle(card) {
  const url = PD.MediaContext.linkUrl(card);
  let parent = card.parentElement;
  for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) break;
    const thumbnails = [...safeQueryAll(parent, 'a[href]')].filter(isVideoCardLink);
    if (thumbnails.some(link => !PD.MediaContext.linksMatch(url, PD.MediaContext.linkUrl(link)))) break;
    const title = [...safeQueryAll(parent, 'a[href]')].find(link => link !== card
      && PD.MediaContext.linksMatch(url, PD.MediaContext.linkUrl(link))
      && (link.closest('h1,h2,h3,[role="heading"]') || /title/i.test(link.className + ' ' + link.id)));
    const text = (title?.getAttribute('title') || title?.textContent || title?.getAttribute('aria-label') || '').trim();
    if (text) return text;
  }
  return (card.title || card.getAttribute('aria-label') || card.querySelector('img')?.alt || '').trim();
}

function activateVideoCard(card) {
  if (!isVideoCardLink(card) || !isVideoCardRendered(card)) return;
  const item = { url: PD.MediaContext.linkUrl(card), title: getVideoCardTitle(card) };
  const identity = getMediaIdentity(card, card, item);
  const sameItem = card === _activeAnchor && !identityChanged(_activeIdentity, identity);
  if (sameItem && isLinkedItemCurrent()) {
    if (_activeMediaKey !== _dismissedMediaKey) positionBtn(_activeMedia);
    return;
  }
  if (_activeIdentity && !sameItem) _qualityPanel?.invalidateContext?.();
  _activeMedia = card;
  _activeAnchor = card;
  _activeContextNode = card;
  _activePlayer = card;
  _activeIdentity = identity;
  _activeMediaKey = getMediaKey(card, identity, card);
  _activeLinkedItem = { anchor: card, ...item, pageUrl: location.href };
  if (_activeMediaKey !== _dismissedMediaKey) { clearHide(); positionBtn(card); }
}

function isLinkedItemCurrent() {
  return !!_activeLinkedItem && _activeLinkedItem.pageUrl === location.href
    && isVideoCardRendered(_activeLinkedItem.anchor)
    && PD.MediaContext.linksMatch(_activeLinkedItem.url, PD.MediaContext.linkUrl(_activeLinkedItem.anchor));
}

function isLinkedItemPinned() {
  return _activeMediaKey !== _dismissedMediaKey && isLinkedItemCurrent()
    && (isQualityPanelInteractionActive()
      || (_feedPointerInside && _pointerFeedAnchor === _activeLinkedItem.anchor));
}

function isFeedPreview(media) {
  return media instanceof Element && !(media instanceof HTMLIFrameElement)
    && !!safeClosest(media, '[class*="preview" i],[id*="preview" i]');
}

function matchesPointerFeedSelection(media) {
  if (!_pointerFeedAnchor) return true;
  if (!_feedPointerInside && !_qualityPanel?.isPointerInteractionActive?.()) {
    // Leaving a feed must not let automatic discovery reopen its first card.
    // Ordinary independent players outside that feed remain discoverable.
    return !isFeedPreview(media) && !getWrappingMediaCard(media);
  }
  const item = PD.MediaContext.getItemLink(media);
  return isVideoCardRendered(_pointerFeedAnchor)
    && !!item && PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(_pointerFeedAnchor));
}

function clearFeedHide() {
  clearTimeout(_feedHideTimer);
  _feedHideTimer = 0;
}

function scheduleFeedHide() {
  if (_feedHideTimer) return;
  const anchor = _activeLinkedItem?.anchor || _pointerFeedAnchor;
  // Allow crossing the small gap between toolbar and portaled format list.
  // An open list or retained keyboard focus alone must not pin a feed card.
  _feedHideTimer = setTimeout(() => {
    _feedHideTimer = 0;
    if (anchor !== (_activeLinkedItem?.anchor || _pointerFeedAnchor)) return;
    // Re-read the live hit before closing. A queued exit can outlive a
    // thumbnail -> preview -> controls transition with a stationary pointer.
    if (_lastPointerEvent) {
      const { clientX: x, clientY: y } = _lastPointerEvent;
      const target = getPaintedElementAtPoint(x, y);
      if (isQualityPanelTarget(target)) return;
      selectPointedFeedCard(target, x, y, false);
    }
    if (_feedPointerInside || _qualityPanel?.isPointerInteractionActive?.()) return;
    if (_activeLinkedItem || isFeedPreview(_activeMedia)) {
      clearHide(); hideButton(true);
    }
  }, 240);
}

function selectPointedFeedCard(target, x, y, scheduleExit = true) {
  if (isQualityPanelTarget(target) || _qualityPanel?.isGestureActive?.()) {
    clearFeedHide(); return;
  }

  const stack = document.elementsFromPoint?.(x, y) || [];
  const links = [];
  for (const element of new Set([target, ...stack])) {
    if (links.some(link => PD.MediaContext.linkUrl(link) && isElementVisuallyRendered(link, 120, 70))) break;
    const link = safeClosest(element, 'a[href]');
    if (!link) {
      // Card padding/metadata may itself be the pointer target. Stay within
      // a compact single-thumbnail container instead of climbing into a grid.
      let parent = element instanceof Element ? element : null;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) break;
        const images = [...safeQueryAll(parent, 'a[href]')].filter(candidate => candidate.querySelector('img,picture'));
        if (images.length > 1) break;
        if (images.length === 1) { links.push(images[0]); break; }
      }
      continue;
    }
    if (!PD.MediaContext.linkUrl(link)) continue;
    if (link.querySelector('img,picture')) links.push(link);
    else {
      // Titles and thumbnails often use separate links in the same card.
      // Find only an image link to that exact item in a compact ancestor.
      let parent = link.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) break;
        const images = [...safeQueryAll(parent, 'a[href]')].filter(candidate => candidate.querySelector('img,picture'));
        if (images.length > 1) break;
        if (images.length === 1 && PD.MediaContext.linksMatch(PD.MediaContext.linkUrl(link), PD.MediaContext.linkUrl(images[0]))) {
          links.push(images[0]); break;
        }
      }
    }
  }
  const currentAnchor = _activeLinkedItem?.anchor || _pointerFeedAnchor;
  const painted = getPaintedElementAtPoint(x, y);
  const isPointedCard = link => {
    if (!PD.MediaContext.linkUrl(link) || !isVideoCardRendered(link)) return false;
    if (!isVideoCardLink(link) && link !== currentAnchor
        && getWrappingMediaCard(link.querySelector('video,iframe')) !== link) return false;
    const root = getVideoCardRoot(link);
    if (containsComposedElement(root, painted) && containsPoint(root.getBoundingClientRect(), x, y)) return true;
    // Visual card ownership must not depend on a ready/rendered <video> or
    // on whichever preview happened to be the active media last frame.
    return isCardPreviewHit(link, painted, x, y);
  };
  const card = links.find(isPointedCard) || (isPointedCard(currentAnchor) ? currentAnchor : null);
  if (!card) {
    _feedPointerInside = false;
    if (scheduleExit && (_pointerFeedAnchor || _activeLinkedItem)) scheduleFeedHide();
    return;
  }
  _feedPointerInside = true;
  clearFeedHide();
  const changed = _activeLinkedItem
    ? card !== _activeLinkedItem.anchor
      || !PD.MediaContext.linksMatch(_activeLinkedItem.url, PD.MediaContext.linkUrl(card))
    : card !== _pointerFeedAnchor;
  _pointerFeedAnchor = card;
  if (changed) {
    clearHide();
    // Invalidating the controller also discards late analysis responses.
    hideButton(true);
  }
  // Bootstrap from the hovered thumbnail itself. Waiting for an already
  // active preview here made the first card (and unloaded previews) invisible.
  activateVideoCard(card);
}

function getMediaAnchor(media, item = PD.MediaContext.getItemLink(media)) {
  if (!(media instanceof Element) || media instanceof HTMLIFrameElement || media instanceof HTMLImageElement) return media;
  const wrappingCard = getWrappingMediaCard(media, item);
  if (wrappingCard) return wrappingCard;
  // Hover previews can be portaled outside the feed card and disappear when
  // our toolbar receives the pointer. Use the player title link as well as a
  // wrapping link: an <a> around the preview need not have an href at all.
  if (item?.url) {
    const rect = media.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const anchors = [...safeQueryAll(document, 'a[href]')].filter(candidate => {
      if (candidate.contains(media) || !PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(candidate))
          || !candidate.querySelector('img,picture') || !isElementVisuallyRendered(candidate, 120, 70)) return false;
      const box = candidate.getBoundingClientRect();
      return rect.width >= 60 && rect.height >= 40 && x >= box.left && x <= box.right
        && y >= box.top && y <= box.bottom && box.width <= rect.width * 1.6 && box.height <= rect.height * 1.6;
    });
    if (_pointerFeedAnchor && anchors.includes(_pointerFeedAnchor)) return _pointerFeedAnchor;
    if (anchors.length === 1) return anchors[0];
  }
  if (media === _activeMedia && isLinkedItemCurrent()
      && ((item && PD.MediaContext.linksMatch(item.url, _activeLinkedItem.url)) || isLinkedItemPinned())) {
    return _activeLinkedItem.anchor;
  }
  const player = getKnownPlayerContainer(media);
  if (player) return player;
  const siblingPlayer = getSiblingPlayerGroup(media);
  if (siblingPlayer) return siblingPlayer.container;
  if (_activeAnchor && _activeAnchor !== media && _activeAnchor.contains(media)
      && safeQueryAll(_activeAnchor, 'video,iframe').length === 1) return _activeAnchor;
  if (safeMatches(media, PLAYER_PLACEHOLDER_SELECTOR)) return media;
  let parent = media.parentElement;
  for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) break;
    if (safeMatches(parent, PLAYER_PLACEHOLDER_SELECTOR + ',' + MEDIA_SURFACE_SELECTOR)
        && safeQueryAll(parent, 'video,iframe').length === 1) return parent;
  }
  return media;
}

function getMediaIdentity(media, anchor = getMediaAnchor(media), item = PD.MediaContext.getItemLink(media)) {
  if (media instanceof HTMLImageElement) {
    return { page: location.href, image: PD.ImageMedia.resolve(media)?.cacheKey || 'unavailable' };
  }
  const identityNode = safeClosest(anchor, '[data-video-id],[data-media-id]');
  const article = safeClosest(anchor, 'article,[role="article"]');
  const bookmarks = safeQueryAll(article, 'a[rel~="bookmark"][href]');
  let source = media instanceof HTMLIFrameElement ? getFrameSource(media)
    : media instanceof HTMLVideoElement ? (media.getAttribute('src') || media.currentSrc || getDirectMediaUrl(media)) : '';
  if (source) {
    try { source = new URL(source, location.href).href; } catch (_) {}
  }
  const linkedPreview = anchor?.localName === 'a' && anchor !== media && !!item?.url
    && PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(anchor));
  return {
    page: location.href,
    item: identityNode?.getAttribute('data-video-id') || identityNode?.getAttribute('data-media-id') || '',
    link: item?.url || PD.MediaContext.linkUrl(safeClosest(anchor, 'a[href]')) || (bookmarks.length === 1 ? PD.MediaContext.linkUrl(bookmarks[0]) : ''),
    // Preview blob URLs change when the same card starts/stops hovering.
    // The selected card link, rather than its disposable stream, owns identity.
    source: linkedPreview ? '' : source,
    poster: !linkedPreview && media instanceof HTMLVideoElement ? media.poster : ''
  };
}

function identityChanged(previous, current) {
  // Loading an empty src/poster for the first time is not another video.
  // Keep known values across temporary emptied/replacement transitions.
  return !!previous && Object.keys(current).some(key =>
    previous[key] && current[key] && previous[key] !== current[key]);
}

function getMediaKey(media, identity = getMediaIdentity(media), anchor = getMediaAnchor(media)) {
  if (!(media instanceof Element)) return '';
  if (!_mediaIds.has(anchor)) _mediaIds.set(anchor, ++_nextMediaId);
  return [_mediaIds.get(anchor), ...Object.values(identity)].join('|');
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
  // Keep video discovery separate from the image hover path. In particular,
  // finding a cover image must not terminate the climb to its video owner.
  if (isVideoElement(root)) {
    candidates.add(root);
  }

  for (const media of safeQueryAll(root, MEDIA_ELEMENT_SELECTOR)) {
    if (isVideoElement(media)) candidates.add(media);
  }
}

function getMediaContextNode(target, media) {
  if (media instanceof HTMLImageElement) return media;
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
  if (media instanceof HTMLImageElement) return media;
  const targetElement = target instanceof Element ? target : null;
  const pointedPlayer = safeClosest(targetElement, '[aria-label="Video player"]');
  if (pointedPlayer) return pointedPlayer;

  if (safeMatches(contextNode, '[aria-label="Video player"]')) return contextNode;

  if (media instanceof HTMLIFrameElement) {
    return getOpenOverlayContainer(media)
      || safeClosest(media, MEDIA_CONTEXT_SELECTOR)
      || media;
  }

  // Use the same ownership resolution as hit-testing and anchor selection.
  const siblingPlayer = getSiblingPlayerGroup(media);
  if (siblingPlayer) return siblingPlayer.controls;

  const renderSurface = getMediaRenderSurface(media);
  if (renderSurface && renderSurface !== media) return renderSurface;

  return safeClosest(media, '[data-video-id],article,[role="article"],[aria-posinset]')
    || contextNode
    || media;
}

function activateMediaPlayer(media, target) {
  // A loading/emptied event may arrive during the short pointer-exit grace
  // period. It cannot turn the selected permalink back into a raw preview,
  // nor discard a thumbnail-only card because anchor === media.
  if (media === _activeMedia && isLinkedItemCurrent()) {
    return { player: _activePlayer, mediaKey: _activeMediaKey };
  }
  const contextNode = getMediaContextNode(target, media);
  const player = getMediaPlayerNode(target, media, contextNode);
  const item = PD.MediaContext.getItemLink(media);
  const anchor = getMediaAnchor(media, item);
  const identity = getMediaIdentity(media, anchor, item);
  const sameItem = anchor === _activeAnchor && !identityChanged(_activeIdentity, identity);
  if (_activeIdentity && !sameItem) {
    _qualityPanel?.invalidateContext?.();
  }
  if (sameItem) {
    for (const key of Object.keys(identity)) identity[key] ||= _activeIdentity?.[key] || '';
  }
  const mediaKey = getMediaKey(media, identity, anchor);
  if (sameItem && _dismissedMediaKey === _activeMediaKey) _dismissedMediaKey = mediaKey;

  _activeMedia = media;
  _activeAnchor = anchor;
  _activeIdentity = identity;
  _activeContextNode = contextNode;
  _activePlayer = player;
  _activeMediaKey = mediaKey;
  _activeLinkedItem = anchor?.localName === 'a' && anchor !== media
    && item?.url && PD.MediaContext.linksMatch(item.url, PD.MediaContext.linkUrl(anchor))
    ? { anchor, url: item.url, title: item.title || getMediaTitle(media, contextNode), pageUrl: location.href }
    : null;
  if (_activeLinkedItem && !_pointerFeedAnchor) {
    _pointerFeedAnchor = anchor;
    _feedPointerInside = !!_lastPointerEvent
      && containsPoint(anchor.getBoundingClientRect(), _lastPointerEvent.clientX, _lastPointerEvent.clientY);
    if (!_feedPointerInside && !isQualityPanelInteractionActive()) scheduleFeedHide();
  }

  return { player, mediaKey };
}

function findMediaAtPoint(x, y, target) {
  const candidates = new Set();
  const targetElement = target instanceof Element ? target : null;

  const directMedia = PD.ImageMedia?.getVideoOwner(targetElement)
    || safeClosest(targetElement, MEDIA_ELEMENT_SELECTOR);
  if (isVideoElement(directMedia)) candidates.add(directMedia);

  const stack = getPaintedStackAtPoint(x, y);
  for (const element of stack) {
    if (!(element instanceof Element)) continue;

    if (isVideoElement(element)) candidates.add(element);

    const context = safeClosest(element, MEDIA_CONTEXT_SELECTOR)
      || safeClosest(element, VIDEO_CONTEXT_SELECTOR);
    addMediaFromRoot(context, candidates);
  }

  const targetContext = safeClosest(targetElement, MEDIA_CONTEXT_SELECTOR)
    || safeClosest(targetElement, VIDEO_CONTEXT_SELECTOR);
  addMediaFromRoot(targetContext, candidates);

  if (candidates.size === 0) {
    let ancestor = targetElement;
    for (let level = 0; level < 16 && ancestor; level++, ancestor = getSelectorParent(ancestor)) {
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
    // Hover and automatic scans must agree about the same painted owner;
    // otherwise pointermove shows the toolbar and the next scan hides it.
    if (!isMediaHitAtPoint(media, x, y, stack[0])) continue;

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
  const target = getPaintedElementAtPoint(clientX, clientY) || previousTarget;
  const media = findMediaAtPoint(clientX, clientY, target);

  return { media, target };
}

function activateDirectMedia(media, target = media) {
  if (media instanceof HTMLImageElement && !IS_TOP_FRAME) return false;
  if (!matchesPointerFeedSelection(media)) return false;
  if (isLinkedItemPinned()) {
    if (media !== _activeMedia) {
      if (getMediaAnchor(media) !== _activeLinkedItem.anchor) return false;
      // A replacement <video> in the same card updates PiP, not the item's
      // URL/cache identity or its open format picker.
      _activeMedia = media;
      _activeContextNode = getMediaContextNode(target, media);
      _activePlayer = getMediaPlayerNode(target, media, _activeContextNode);
    }
    positionBtn(_activeMedia); return true;
  }
  if (!isRenderedMedia(media)) return false;
  // Autoplay/hover in another player must not steal an in-progress click,
  // native PiP request, or an open picker.
  if (_activeAnchor && getMediaAnchor(media) !== _activeAnchor && isQualityPanelInteractionActive()) return false;
  const { mediaKey } = activateMediaPlayer(media, target);
  if (mediaKey && mediaKey === _dismissedMediaKey) return false;
  if (_dismissedMediaKey && mediaKey !== _dismissedMediaKey) _dismissedMediaKey = '';

  clearHide();
  positionBtn(media);
  return true;
}

function findProminentVisibleMedia() {
  const candidates = [];
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);

  for (const media of safeQueryAll(document, MEDIA_ELEMENT_SELECTOR)) {
    if (!matchesPointerFeedSelection(media)) continue;
    const surface = getMediaRenderSurface(media);
    if (!surface) continue;
    const rect = surface.getBoundingClientRect();
    const area = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0))
      * Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    if (area < 120 * 70 || !isTopmostAtCenter(media)) continue;
    const overlay = getOpenOverlayContainer(media);
    let score = (area / viewportArea) * 300;

    if (surface !== media) score += 35;
    if (overlay) score += 500;
    if (media instanceof HTMLVideoElement && !media.paused && !media.ended) score += 180;
    if (media instanceof HTMLIFrameElement) {
      score += Math.min(180, Math.max(0, getFrameSemanticScore(media)));
      if (document.activeElement === media) score += 250;
    }
    score += 120;

    candidates.push({ media, score, area });
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.area - a.area));
  const best = candidates[0];
  if (!best) return null;

  // Presence and visible geometry, not playback, decide eligibility.
  // A paused/unloaded <video> behind its poster already has controls.
  return best.media;
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

function hasLocalMedia() {
  for (const media of safeQueryAll(document, MEDIA_ELEMENT_SELECTOR)) {
    // Report media presence, not whether its internal layer is currently
    // painted. Players can hide/swap that layer while loading or starting
    // playback. The parent independently validates the iframe's visibility.
    if (isMediaElement(media)) return true;
  }
  return false;
}

let _lastFrameMediaReport = '';
let _frameReportRaf = 0;
function reportFrameMediaState(force = false) {
  if (IS_TOP_FRAME) return;

  const hasMedia = hasLocalMedia();
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
    // Reconcile below instead of tearing down a visible iframe immediately.
    // A temporary empty media layer must not discard its toolbar or picker.
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

  // A page may finish initializing its player without another observed DOM
  // mutation. Deduplicated reports keep the parent in sync after that phase.
  const reportTimer = setInterval(() => queueFrameMediaReport(false), 1000);
  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      clearInterval(reportTimer);
      observer.disconnect();
      if (_frameReportRaf) cancelAnimationFrame(_frameReportRaf);
    }
  });

  queueFrameMediaReport(true);
}

window.addEventListener('message', handleFrameMediaMessage, false);

let _scanFrame = 0;
function queueMediaScan() {
  if (_scanFrame) return;
  _scanFrame = requestAnimationFrame(() => {
    _scanFrame = 0;
    if (_contextInvalidated) return;

    // Images are hover-selected only. Automatic video discovery must not
    // reopen them or replace their picker with an unrelated playing video.
    if (_activeMedia instanceof HTMLImageElement) {
      const owner = PD.ImageMedia?.getVideoOwner(_activeMedia);
      if (owner) {
        hideButton(true);
        activateDirectMedia(owner, owner);
        return;
      }
      if (!isRenderedMedia(_activeMedia)) { hideButton(true); return; }
      activateMediaPlayer(_activeMedia, _activeMedia);
      const pointer = _lastPointerEvent;
      const target = pointer && document.elementFromPoint?.(pointer.clientX, pointer.clientY);
      if (isQualityPanelTarget(target) || _qualityPanel?.isGestureActive?.()
          || (pointer && imageAtPoint(target, pointer.clientX, pointer.clientY) === _activeMedia)) {
        clearImageHide(); positionBtn(_activeMedia);
      } else scheduleImageHide();
      return;
    }

    // Re-evaluate stationary-pointer ownership before automatic discovery.
    // Layout changes and playback events must not promote another card.
    if (_pointerFeedAnchor && _lastPointerEvent) {
      const { clientX: x, clientY: y } = _lastPointerEvent;
      selectPointedFeedCard(getPaintedElementAtPoint(x, y), x, y);
    }

    // Pin the card before reconciling the disposable portal player. This is
    // also the URL snapshot used by getContext, not just a visual workaround.
    if (_activeLinkedItem && !isLinkedItemCurrent()) hideButton(true);
    if (isLinkedItemPinned()) {
      if (!_activeLinkedItem.anchor.contains(_activeMedia)) {
        const replacements = [...safeQueryAll(_activeLinkedItem.anchor, 'video')];
        if (replacements.length === 1) activateDirectMedia(replacements[0], _activeLinkedItem.anchor);
      }
      positionBtn(_activeMedia); return;
    }
    if (_activeLinkedItem) {
      // Linked cards have one exit path. Do not run ordinary video
      // reconciliation while their pointer-exit timer is pending: that path
      // could clear the card identity or select a different autoplay video.
      scheduleFeedHide();
      return;
    }
    if (_pointerFeedAnchor && _feedPointerInside) {
      const pointed = getMediaUnderLastPointer();
      if (pointed?.media) activateDirectMedia(pointed.media, pointed.target);
      // A hovered card that is still loading is not permission to select the
      // first visible video elsewhere in the carousel.
      return;
    }

    // A preview/player can create or replace its media node between pointerdown
    // and click. Adopt that node before deciding to hide the stable toolbar.
    if (_activeMedia && !isRenderedMedia(_activeMedia) && _activeAnchor?.isConnected) {
      const replacements = [...safeQueryAll(_activeAnchor, 'video,iframe')].filter(isRenderedMedia);
      if (replacements.length === 1) activateMediaPlayer(replacements[0], _activeAnchor);
      else if (!replacements.length && isMediaElement(_activeAnchor) && isRenderedMedia(_activeAnchor)) {
        activateMediaPlayer(_activeAnchor, _activeAnchor);
      }
    }
    if (_activeMedia && isRenderedMedia(_activeMedia)
        && (isQualityPanelInteractionActive() || isTopmostAtCenter(_activeMedia))) {
      activateMediaPlayer(_activeMedia, _activeContextNode);
      if (_activeMediaKey !== _dismissedMediaKey) positionBtn(_activeMedia);
      return;
    }
    if (_activeMedia && isQualityPanelInteractionActive()
        && isElementVisuallyRendered(_activeAnchor, 120, 70)) {
      const current = getMediaIdentity(_activeAnchor, _activeAnchor);
      if (!identityChanged(_activeIdentity, current)) {
        clearHide(); positionBtn(_activeMedia); return;
      }
    }

    // Player controls can briefly replace their painted layer within a frame.
    // Recheck a still-mounted player after a short grace period instead of
    // tearing down its picker on the first transient failed hit.
    if (_activeMedia && (getKnownPlayerContainer(_activeMedia) || getSiblingPlayerGroup(_activeMedia))
        && isElementVisuallyRendered(_activeAnchor, 120, 70)) {
      scheduleHide(200);
      return;
    }
    if (_activeMedia) hideButton(true);
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

  if (!_lastPointerEvent || _contextInvalidated) return;

  const pointed = getMediaUnderLastPointer();
  const target = pointed?.target || _lastPointerEvent.target;
  if (selectPointedImage(target, _lastPointerEvent.clientX, _lastPointerEvent.clientY)) return;
  selectPointedFeedCard(target, _lastPointerEvent.clientX, _lastPointerEvent.clientY);

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
  if (!IS_TOP_FRAME) return;

  const rememberPointer = event => {
    const target = event.composedPath?.().find(node => node instanceof Element) || event.target;
    _lastPointerEvent = {
      clientX: event.clientX,
      clientY: event.clientY,
      target
    };
    if (selectPointedImage(target, event.clientX, event.clientY)) return;
    selectPointedFeedCard(target, event.clientX, event.clientY);
  };

  document.addEventListener('pointermove', event => {
    rememberPointer(event);
    queuePointerProcessing(false);
  }, true);

  // `mouseover` fires on the iframe element in the parent document immediately
  // before pointer events start going to the cross-origin child frame. This is
  // a reliable hand-off point for embedded players.
  document.addEventListener('mouseover', event => {
    if (isQualityPanelTarget(event.target)) { clearHide(); return; }
    if (event.target instanceof HTMLImageElement || _activeMedia instanceof HTMLImageElement) {
      rememberPointer(event);
      queuePointerProcessing();
      return;
    }
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

    if (_activeMedia instanceof HTMLImageElement) { queuePointerProcessing(); return; }

    const pointed = getMediaUnderLastPointer();
    if (pointed?.media) activateDirectMedia(pointed.media, pointed.target);
  }, true);

  document.addEventListener('focusin', event => {
    if (isQualityPanelTarget(event.target)) { clearHide(); return; }
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

  document.addEventListener('pointerleave', event => {
    // Capture receives non-bubbling leaves from every descendant, including
    // video -> toolbar and icon -> button transitions. Only leaving the
    // document should schedule a document-level hide.
    if (event.target === document.documentElement && !event.relatedTarget) {
      _lastPointerEvent = null;
      if (_activeMedia instanceof HTMLImageElement) scheduleImageHide();
      else if (_pointerFeedAnchor) { _feedPointerInside = false; scheduleFeedHide(); }
      else scheduleHide(150);
    }
  }, true);

  const handleMediaIdentityChange = event => {
    if (!(event.target instanceof HTMLVideoElement)) return;

    if (event.target === _activeMedia) activateMediaPlayer(_activeMedia, _activeContextNode);

    queuePointerProcessing(true);
    queueMediaScan();
  };

  document.addEventListener('loadstart', handleMediaIdentityChange, true);
  document.addEventListener('emptied', handleMediaIdentityChange, true);
  document.addEventListener('loadedmetadata', handleMediaIdentityChange, true);
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement) {
      if (event.target === _activeMedia) queueMediaScan();
      if (_lastPointerEvent) queuePointerProcessing(true);
      return;
    }
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
        if (_activeMedia && !_activeMedia.isConnected) shouldScan = true;
        if (_activeMedia instanceof HTMLImageElement && mutation.target === _activeMedia.closest('picture')) shouldScan = true;
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
        // Image crops can change via inline left/width/overflow without a
        // class mutation. Ignore unrelated/player/UI style animation churn.
        if (mutation.attributeName === 'style' && !(_activeMedia instanceof HTMLImageElement
            && containsComposedElement(target, _activeMedia))) continue;
        if (isMediaElement(target)
            || (_activeMedia instanceof HTMLImageElement && target.localName === 'source'
              && target.parentElement === _activeMedia.closest('picture'))
            || (mutation.attributeName === 'href' && _activeMedia
              && safeClosest(_activeMedia, PLAYER_PLACEHOLDER_SELECTOR)?.contains(target))
            || target === _activeMedia
            || target === _activeAnchor
            || (_activeAnchor && target.contains(_activeAnchor))
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
    attributeFilter: [...MEDIA_MUTATION_ATTRIBUTES, 'style']
  });

  const reposition = () => {
    // Use the same reconciliation path during resize/fullscreen, too.
    queueMediaScan();
  };

  window.addEventListener('scroll', event => {
    // Capture-phase scroll listeners also receive scrolling from the dropdown's
    // own list. Scrolling inside the panel must never be treated as the user
    // leaving the media player.
    if (isQualityPanelTarget(event.target)) {
      clearHide();
      return;
    }
    if (_activeMedia instanceof HTMLImageElement) {
      queuePointerProcessing(true); queueMediaScan(); return;
    }
    if (isQualityPanelInteractionActive()) { clearHide(); return; }

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

  document.addEventListener('fullscreenchange', reposition);

  // SPA navigation and reused media nodes need no site-specific events.
  let pageUrl = location.href;
  const refresh = () => {
    if (_contextInvalidated || document.hidden) return;
    if (pageUrl !== location.href) {
      pageUrl = location.href;
      _pointerFeedAnchor = null;
      _feedPointerInside = false;
      clearFeedHide();
      _dismissedMediaKey = '';
      hideButton(true);
      PD.QualityAnalyzer?.clearCache();
    }
    queueMediaScan();
  };
  const scanTimer = setInterval(refresh, 1000);
  window.addEventListener('popstate', refresh);
  window.addEventListener('hashchange', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { clearImageHide(); clearFeedHide(); clearInterval(scanTimer); observer.disconnect(); _qualityPanel?.destroy(); }
  });
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
