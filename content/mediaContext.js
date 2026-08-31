// Shared media selection context. DOM permalink fallbacks only identify the
// selected item; extraction, format analysis and downloads use the same pipeline.
(function (root) {
  const PD = root.PD || (root.PD = {});
  function httpUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function getDirectMediaUrl(media) {
    if (media?.localName !== 'video') return '';
    // currentSrc is authoritative. Do not substitute an inactive <source>
    // when MSE/blob playback is already selected.
    if (media.currentSrc) return httpUrl(media.currentSrc);
    const values = [media.getAttribute('src'), ...Array.from(media.querySelectorAll('source[src]'), source => source.getAttribute('src'))];
    return values.map(httpUrl).find(Boolean) || '';
  }
  function getMediaTitle(media, contextNode) {
    return String(media?.getAttribute?.('title') || media?.getAttribute?.('aria-label')
      || contextNode?.getAttribute?.('aria-label') || document.title || 'video').trim();
  }
  function linkUrl(link) {
    const raw = link?.getAttribute?.('href')?.trim();
    // An empty href resolves to the current page, not the selected video.
    return raw && !raw.startsWith('#') ? httpUrl(raw) : '';
  }
  function linksMatch(first, second) {
    try {
      const a = new URL(first), b = new URL(second);
      if (!/^https?:$/.test(a.protocol) || a.origin !== b.origin || a.pathname !== b.pathname || a.hash !== b.hash) return false;
      // Compare actual URLs; never extract a provider ID or strip arbitrary
      // parameters from the URL sent to the backend. A thumbnail may add
      // navigation parameters to the player title's more specific item link.
      const subset = (x, y) => [...x.searchParams.keys()].every(key => {
        const wanted = x.searchParams.getAll(key).sort();
        const available = y.searchParams.getAll(key).sort();
        return wanted.length === available.length && wanted.every((value, index) => value === available[index]);
      });
      if (a.href === b.href) return true;
      if ((!a.search || !b.search) && a.pathname === '/') return false;
      return subset(a, b) || subset(b, a);
    } catch { return false; }
  }
  function getTikTokIdentityPermalink(media) {
    const card = media.closest('[data-e2e="feed-video"],[data-e2e="recommend-list-item-container"],article,[role="article"]');
    if (!card || card.querySelectorAll('video,iframe').length !== 1) return null;
    // media-card-0 is a recyclable list position, not a video ID. The original
    // resolver read xgwrapper/data-item IDs; only trust this player's ancestry.
    const ids = new Set();
    for (let node = media; node && card.contains(node); node = node.parentElement) {
      const wrapperId = node.id?.match(/^xgwrapper-(?:\d+-)?(\d{15,22})(?:-|$)/i)?.[1];
      if (wrapperId) ids.add(wrapperId);
      for (const name of ['data-item-id', 'data-video-id', 'data-aweme-id']) {
        const value = node.getAttribute(name)?.trim();
        if (/^\d{15,22}$/.test(value || '')) ids.add(value);
      }
      if (node === card) break;
    }
    if (ids.size !== 1) return null;
    const id = [...ids][0], profiles = new Map(), permalinks = new Map();
    for (const link of card.querySelectorAll('a[href]')) {
      try {
        const url = new URL(linkUrl(link));
        if (url.hostname !== 'tiktok.com' && !url.hostname.endsWith('.tiktok.com')) continue;
        const match = url.pathname.match(/^\/@([^/]+)(?:\/video\/(\d{15,22}))?\/?$/);
        if (!match) continue;
        const username = decodeURIComponent(match[1]);
        if (!/^[A-Za-z0-9._]{1,64}$/.test(username)) continue;
        if (match[2] === id) permalinks.set(username.toLowerCase(), username);
        else if (!match[2] && !link.closest('[data-e2e="video-desc"],[data-media-card-description-container]')) {
          profiles.set(username.toLowerCase(), username);
        }
      } catch { /* Ignore malformed links, never substitute another card. */ }
    }
    const authors = permalinks.size ? permalinks : profiles;
    if (authors.size !== 1) return null;
    const username = [...authors.values()][0];
    const title = (card.querySelector('[data-e2e="video-desc"]')?.textContent || '').trim().slice(0, 300);
    return { url: 'https://www.tiktok.com/@' + encodeURIComponent(username) + '/video/' + id,
      title, source: 'dom-id' };
  }
  function getIdentityPermalink(media) {
    // Restore the original DOM-ID fallback for feed players that expose no
    // usable href/src. The site's ID is an identifier, not a CDN file name.
    // Scope this URL convention to its actual host, never to arbitrary pages
    // that happen to use an attribute called data-video-id.
    const host = location.hostname.toLowerCase();
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return getTikTokIdentityPermalink(media);
    if (host !== 'facebook.com' && !host.endsWith('.facebook.com')
        && host !== 'fb.watch' && host !== 'www.fb.watch') return null;
    const owner = media.closest('[data-video-id]');
    const id = owner?.getAttribute('data-video-id')?.trim() || '';
    if (!/^[1-9]\d{4,29}$/.test(id)) return null;
    return { url: 'https://www.facebook.com/watch/?v=' + encodeURIComponent(id),
      title: '', source: 'dom-id' };
  }
  function getItemAnalysisUrl(itemUrl) {
    if (!itemUrl) return '';
    try {
      const url = new URL(itemUrl);
      if (!/^https?:$/.test(url.protocol)
          || (url.hostname !== 'instagram.com' && !url.hostname.endsWith('.instagram.com'))) return '';
      const item = url.pathname.match(/^\/(reels|reel|p|tv)\/([A-Za-z0-9_-]+)\/?$/i);
      if (!item) return '';
      // Restore the original resolver's /reels/ -> /reel/ alias for analysis.
      // Keep getItemLink/linkUrl unchanged: hover ownership must still match
      // the actual href in the DOM. Never derive an item from captured CDN URLs.
      if (item[1].toLowerCase() === 'reels') url.pathname = '/reel/' + item[2] + '/';
      return url.href;
    } catch { return ''; }
  }
  function getItemLink(media) {
    if (!media?.isConnected || media.localName === 'iframe' || media.localName === 'img') return null;
    const identifiedItem = getIdentityPermalink(media);
    if (identifiedItem) return identifiedItem;
    const wrapper = media.closest('a[href]');
    const wrappingUrl = linkUrl(wrapper);
    let parent = media.parentElement;
    for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      // Stay inside one player/card; never search a multi-video feed for a
      // convenient link, and do not mistake the channel link for the item.
      if (parent.querySelectorAll('video,iframe').length !== 1) break;
      const links = [...parent.querySelectorAll('a[href]')].filter(link => linkUrl(link));
      const titles = links.filter(link => link.relList.contains('bookmark')
        || /title[-_]?link|link[-_]?title/i.test(link.className + ' ' + link.id)
        || link.closest('h1,h2,h3,[role="heading"]'));
      const urls = [...new Set(titles.map(linkUrl))];
      if (urls.length === 1 && (!wrappingUrl || linksMatch(wrappingUrl, urls[0]))) {
        const link = titles[0];
        return { url: urls[0], title: (link.getAttribute('title') || link.getAttribute('aria-label') || link.textContent || '').trim() };
      }
    }
    if (wrappingUrl) return { url: wrappingUrl, title: (wrapper.title || wrapper.getAttribute('aria-label') || '').trim() };
    return null;
  }
  function resolve(media, contextNode, info = {}) {
    if (!media?.isConnected) return null;
    if (media.localName === 'img') return PD.ImageMedia?.resolve(media, info) || null;
    const pageUrl = httpUrl(location.href);
    const mediaUrl = getDirectMediaUrl(media);
    const frameUrl = media.localName === 'iframe' ? httpUrl(info.frameUrl || media.src) : '';
    // A wrapping link or explicit bookmark is associated with this item.
    // Never take an arbitrary link elsewhere in a feed as the selected video.
    const item = info.itemUrl ? { url: httpUrl(info.itemUrl), title: info.itemTitle || '' } : getItemLink(media);
    const article = media.closest('article, [role="article"]');
    const bookmarks = article?.querySelectorAll('a[rel~="bookmark"][href]') || [];
    const linkedUrl = item?.url || (bookmarks.length === 1 ? linkUrl(bookmarks[0]) : '');
    const itemAnalysisUrl = getItemAnalysisUrl(linkedUrl);
    // A directly opened Instagram Reel may expose only blob: video nodes and
    // no self-link in the rendered player. In that case the current page is
    // the selected item, so normalize it through the same shared URL path.
    const pageItemAnalysisUrl = !linkedUrl ? getItemAnalysisUrl(pageUrl) : '';
    const multipleVideos = document.querySelectorAll('video').length > 1;
    const isPreview = !!media.closest('[class*="preview" i],[id*="preview" i]');
    // A feed preview without an item link must not silently analyze the feed
    // homepage. Wait for its item URL, or use its own HTTP media source.
    const url = frameUrl || itemAnalysisUrl || pageItemAnalysisUrl || linkedUrl
      || (isPreview ? mediaUrl : (multipleVideos && mediaUrl ? mediaUrl : pageUrl)) || mediaUrl;
    if (!url) return null;
    const title = info.frameTitle || item?.title || getMediaTitle(media, contextNode);
    return {
      url, pageUrl, mediaUrl, frameUrl, title, referer: pageUrl,
      // A validated selected-item permalink takes priority over unrelated
      // requests captured in the same frame. Keep capture as a fallback.
      preferItemAnalysis: !frameUrl && (item?.source === 'dom-id' || !!itemAnalysisUrl || !!pageItemAnalysisUrl),
      blobUrl: media.localName === 'video' && /^blob:/.test(media.currentSrc || media.src || '') ? (media.currentSrc || media.src) : '',
      mediaKey: info.mediaKey || '',
      cacheKey: [url, info.mediaKey || '', mediaUrl, title].join('|'),
      allowDirectFallback: !!mediaUrl
    };
  }
  PD.MediaContext = Object.freeze({ resolve, getDirectMediaUrl, getMediaTitle, getItemLink, linkUrl, linksMatch });
})(globalThis);
