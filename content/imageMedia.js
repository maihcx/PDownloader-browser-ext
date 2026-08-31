// Image sources come from the selected DOM image, never from guessed CDN URLs
// or a page-wide network candidate. Keep signed URLs and query strings intact.
(function (root) {
  const PD = root.PD || (root.PD = {});
  const IMAGE_EXTENSION = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svg|tiff?|webp)$/i;
  const PLAYER_SELECTOR = [
    '.html5-video-player', '.jwplayer', '.video-js', '.dplayer',
    '[data-video-player]', '[data-video-id]', '[aria-label="Video player" i]',
    '[class*="videoplayer" i]', '[class*="video-player" i]', '[class*="video_player" i]',
    '[data-testid*="video-player" i]', '[data-testid*="video_player" i]'
  ].join(',');

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
  function getVideoOwner(image) {
    if (!(image instanceof HTMLImageElement) || !image.isConnected) return null;
    const pictureRect = image.getBoundingClientRect();
    let parent = image.parentElement;
    for (let depth = 0; parent && depth < 10; depth++, parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      const videos = parent.querySelectorAll('video');
      // Stay within one player, never associate an image with a whole feed.
      if (videos.length > 1) return null;
      if (!videos.length) continue;
      const video = videos[0];
      const player = parent.closest(PLAYER_SELECTOR);
      if (player?.contains(video)) return video;

      // A poster is frequently a sibling overlay, not a child of <video>.
      // Geometry remains meaningful when the underlying video has opacity:0.
      const videoRect = video.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(pictureRect.right, videoRect.right) - Math.max(pictureRect.left, videoRect.left))
        * Math.max(0, Math.min(pictureRect.bottom, videoRect.bottom) - Math.max(pictureRect.top, videoRect.top));
      if (pictureRect.width >= 60 && pictureRect.height >= 40 && videoRect.width >= 60 && videoRect.height >= 40
          && overlap >= pictureRect.width * pictureRect.height * 0.75
          && overlap >= videoRect.width * videoRect.height * 0.5) return video;
      // This is the nearest common container. A distant ancestor cannot make
      // a non-overlapping standalone photo become this video's poster.
      return null;
    }
    return null;
  }
  function isEligible(image) {
    if (!(image instanceof HTMLImageElement) || !image.isConnected || !image.naturalWidth) return false;
    const url = sourceUrl(image.currentSrc || image.src);
    if (!url || /(?:avatar|emoji|favicon)/i.test(url)) return false;
    // Ignore interface icons and player posters; selecting a video thumbnail
    // must continue to select its video, rather than download the poster.
    const labels = [image.id, image.className, image.getAttribute('alt')].join(' ');
    if (/(?:^|[\s_-])(?:avatar|icon|logo|emoji)(?:$|[\s_-])/i.test(labels)
        || image.closest(PLAYER_SELECTOR) || getVideoOwner(image)) return false;
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
  PD.ImageMedia = Object.freeze({ isEligible, resolve, getVideoOwner });
})(globalThis);
