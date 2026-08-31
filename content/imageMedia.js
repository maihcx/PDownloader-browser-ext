// Image sources come from the selected DOM image, never from guessed CDN URLs
// or a page-wide network candidate. Keep signed URLs and query strings intact.
(function (root) {
  const PD = root.PD || (root.PD = {});
  const IMAGE_EXTENSION = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i;
  const PLAYER_SELECTOR = '.html5-video-player,.jwplayer,.video-js,.dplayer,[data-video-player],[data-video-id],[aria-label="Video player"]';

  function sourceUrl(value) {
    if (!value?.trim()) return '';
    try {
      const url = new URL(value, document.baseURI);
      return /^(https?:|blob:)$/.test(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }
  function extension(url) {
    try { return new URL(url).pathname.match(IMAGE_EXTENSION)?.[1]?.toLowerCase() || ''; }
    catch (_) { return ''; }
  }
  function isEligible(image) {
    if (!(image instanceof HTMLImageElement) || !image.isConnected || !image.naturalWidth) return false;
    const url = sourceUrl(image.currentSrc || image.src);
    if (!url || /(?:avatar|emoji|favicon)/i.test(url)) return false;
    // Ignore interface icons and player posters; selecting a video thumbnail
    // must continue to select its video, rather than download the poster.
    const labels = [image.id, image.className, image.getAttribute('alt')].join(' ');
    if (/(?:^|[\s_-])(?:avatar|icon|logo|emoji)(?:$|[\s_-])/i.test(labels)
        || image.closest(PLAYER_SELECTOR)) return false;
    const link = image.closest('a[href]');
    if (link) {
      try {
        const url = new URL(link.href);
        if (/(?:^|\/)(?:watch|videos?|shorts|embed|player)(?:\/|$)/i.test(url.pathname)
            || /\.(?:mp4|webm|m3u8|mpd)$/i.test(url.pathname)) return false;
      } catch (_) {}
    }
    const rect = image.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 120;
  }

  function srcsetEntries(value) {
    // Tokenize URL + descriptor instead of splitting on every comma: image
    // transformation URLs may themselves contain commas. Whitespace ends URL.
    const entries = [];
    let remaining = String(value || '').trim();
    while (remaining && entries.length < 32) {
      remaining = remaining.replace(/^[\s,]+/, '');
      const token = remaining.match(/^\S+/)?.[0];
      if (!token) break;
      remaining = remaining.slice(token.length);
      if (token.endsWith(',')) {
        entries.push({ url: token.replace(/,+$/, ''), descriptor: '' });
        continue;
      }
      const end = remaining.indexOf(',');
      const descriptor = (end < 0 ? remaining : remaining.slice(0, end)).trim();
      remaining = end < 0 ? '' : remaining.slice(end + 1);
      if (!descriptor || /^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) {
        entries.push({ url: token, descriptor });
      }
    }
    return entries;
  }

  function filename(url) {
    if (!extension(url)) return null; // Let the server name extensionless CDN sources.
    try {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
      return PD.MediaTitle?.sanitize(name, 'image.' + extension(url), 160) || null;
    } catch (_) { return null; }
  }
  function resolve(image, info = {}) {
    if (!(image instanceof HTMLImageElement) || !image.isConnected) return null;
    const current = sourceUrl(image.currentSrc || image.src);
    if (!current) return null;
    const sources = [], seen = new Set();
    const add = (value, descriptor = '', linked = false) => {
      const url = sourceUrl(value);
      if (!url || seen.has(url) || sources.length >= 24 || (url.startsWith('blob:') && url !== current)) return;
      seen.add(url);
      sources.push({ url, descriptor, linked, current: url === current,
        width: url === current ? image.naturalWidth : 0,
        height: url === current ? image.naturalHeight : 0,
        extension: extension(url), filename: filename(url) });
    };
    add(current);
    add(image.getAttribute('src'));
    for (const entry of srcsetEntries(image.getAttribute('srcset'))) add(entry.url, entry.descriptor);
    const picture = image.closest('picture');
    for (const source of picture?.querySelectorAll('source[srcset]') || []) {
      if (source.media && !matchMedia(source.media).matches) continue;
      for (const entry of srcsetEntries(source.srcset)) add(entry.url, entry.descriptor);
    }
    const linked = image.closest('a[href]');
    if (linked && extension(linked.href)) add(linked.href, '', true);
    const title = String(image.alt || image.title || filename(current) || document.title || 'image').trim();
    return {
      mediaType: 'image', url: current, mediaUrl: current, pageUrl: location.href,
      referer: location.href, title, sources,
      blobUrl: current.startsWith('blob:') ? current : '',
      mediaKey: info.mediaKey || '',
      cacheKey: JSON.stringify([current, title, sources]),
      allowDirectFallback: false
    };
  }
  PD.ImageMedia = Object.freeze({ isEligible, resolve });
})(globalThis);
