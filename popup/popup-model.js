// Pure display/validation helpers, shared with the regression tests.
(function (root) {
  const PD = root.PD || (root.PD = {});
  function domain(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.hostname : ''; } catch { return ''; }
  }
  function category(item) {
    if (item.mediaType === 'audio') return 'audio';
    if (item.mediaType === 'pdf') return 'document';
    if (['hls', 'dash', 'page'].includes(item.kind) || ['manifest', 'video'].includes(item.mediaType)) return 'video';
    return 'other';
  }
  function name(item, pageTitle = '') {
    if (['hls', 'dash', 'page'].includes(item.kind) || item.mediaType === 'manifest') return item.title || pageTitle || 'Media';
    if (item.filename) return item.filename.split(/[/\\]/).pop();
    if (item.title) return item.title;
    try { return decodeURIComponent(new URL(item.url).pathname.split('/').pop()) || item.url; } catch { return item.url || 'Media'; }
  }
  function bytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    for (const [size, unit] of [[1024 ** 3, 'GB'], [1024 ** 2, 'MB'], [1024, 'KB']]) {
      if (n >= size) return `${(n / size).toFixed(1)} ${unit}`;
    }
    return `${n} B`;
  }
  function filter(items, { query = '', type = 'all', sort = 'detected', title = '' } = {}) {
    const needle = query.trim().toLocaleLowerCase();
    const rows = items.filter(item => !item.likelySegment && (type === 'all' || category(item) === type)
      && [name(item, title), item.url, item.extension, item.kind].join(' ').toLocaleLowerCase().includes(needle));
    if (sort === 'name') rows.sort((a, b) => name(a, title).localeCompare(name(b, title), undefined, { numeric: true, sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id)));
    if (sort === 'size') rows.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0) || String(a.id).localeCompare(String(b.id)));
    return rows;
  }
  function normalizeDomain(value) {
    const raw = value.trim();
    if (!raw || /[\s*?#@]/.test(raw)) return '';
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !host) return '';
      if (host === 'localhost') return host;
      if (!host.includes('.') || host.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return '';
      return host;
    } catch { return ''; }
  }
  function extensions(value) {
    const entries = [...new Set(value.toLowerCase().split(/[\s,;]+/).filter(Boolean).map(x => x.replace(/^\./, '')))];
    return entries.length && entries.length <= 250 && entries.every(x => /^[a-z0-9*]{1,15}$/.test(x)) ? entries : null;
  }
  PD.PopupModel = Object.freeze({ domain, category, name, bytes, filter, normalizeDomain, extensions });
})(globalThis);
