// Local Blob files are browser-owned. Never send a blob: URL to the desktop
// bridge, buffer the whole movie, or revoke a URL that belongs to the page.
(function (root) {
  const PD = root.PD || (root.PD = {});
  async function save(video, context, isCurrent = () => true) {
    const url = context?.blobUrl || '';
    const image = context?.mediaType === 'image';
    const changedMessage = () => PD.I18n.t(image ? 'qaImageChanged' : 'qaBlobChanged');
    const current = () => isCurrent() && video?.isConnected && video.localName === (image ? 'img' : 'video')
      && (video.currentSrc || video.src) === url;
    if (!/^blob:/.test(url) || !current()) throw new Error(changedMessage());
    let response;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      // Blob URL fetch obtains headers only. MediaSource object URLs cannot
      // be read as a complete file and fail here instead of saving garbage.
      response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error('Blob unavailable');
      const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (mime && !(image ? /^image\// : /^video\//).test(mime)
          && !/^(application|binary)\/octet-stream$/.test(mime)) throw new Error('Unexpected media type');
      if (!current()) throw new Error(changedMessage());
      const ext = ({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff' })[mime] || 'bin';
      const link = document.createElement('a');
      link.href = url;
      const fallback = image ? 'image' : 'video';
      const title = image ? String(context.title || '').replace(/\.(?:jpe?g|png|webp|avif|gif|svg|bmp|tiff?)$/i, '') : context.title;
      link.download = (PD.MediaTitle?.sanitize(title, fallback, 100) || fallback) + '.' + ext;
      link.hidden = true; document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch (error) {
      if (!current()) throw new Error(changedMessage());
      throw new Error(PD.I18n.t(image ? 'qaImageUnavailable' : 'qaBlobUnavailable'));
    } finally {
      clearTimeout(timer);
      void response?.body?.cancel?.().catch(() => {});
      abort.abort();
    }
  }
  PD.BlobMedia = Object.freeze({ save });
})(globalThis);
