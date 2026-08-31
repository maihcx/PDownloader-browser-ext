// Site-independent media context. Page/embed analysis is delegated to the
// existing desktop analyzer; no hostname checks or provider video IDs here.
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
  function getItemLink(media) {
    if (!media?.isConnected || media.localName === 'iframe' || media.localName === 'img') return null;
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
    const multipleVideos = document.querySelectorAll('video').length > 1;
    const isPreview = !!media.closest('[class*="preview" i],[id*="preview" i]');
    // A feed preview without an item link must not silently analyze the feed
    // homepage. Wait for its item URL, or use its own HTTP media source.
    const url = frameUrl || linkedUrl || (isPreview ? mediaUrl : (multipleVideos && mediaUrl ? mediaUrl : pageUrl)) || mediaUrl;
    if (!url) return null;
    const title = info.frameTitle || item?.title || getMediaTitle(media, contextNode);
    return {
      url, pageUrl, mediaUrl, frameUrl, title, referer: pageUrl,
      blobUrl: media.localName === 'video' && /^blob:/.test(media.currentSrc || media.src || '') ? (media.currentSrc || media.src) : '',
      mediaKey: info.mediaKey || '',
      cacheKey: [url, info.mediaKey || '', mediaUrl, title].join('|'),
      allowDirectFallback: !!mediaUrl
    };
  }
  PD.MediaContext = Object.freeze({ resolve, getDirectMediaUrl, getMediaTitle, getItemLink, linkUrl, linksMatch });
})(globalThis);
