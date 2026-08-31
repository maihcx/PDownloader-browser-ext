// Native PiP, invoked directly from the clicked video's control. Never starts
// playback or forwards a trusted click asynchronously to another frame.
(function (root) {
  const PD = root.PD || (root.PD = {});
  if (PD.PictureInPicture) return;
  const sessions = new WeakMap();
  const requests = new WeakSet();
  function resolveVideo(media) {
    if (media?.localName === 'video') return media;
    if (media?.localName === 'iframe') {
      try { return media.contentDocument?.querySelector('video') || null; } catch { return null; }
    }
    return media?.querySelector?.('video') || null;
  }
  function fail(key) { throw new Error(PD.I18n.t(key)); }
  async function toggle(media) {
    const video = resolveVideo(media);
    if (!video || !video.isConnected) return fail(media?.localName === 'iframe' ? 'pipFrameUnavailable' : 'pipNoVideo');
    const doc = video.ownerDocument;
    if (requests.has(video)) return;
    if (doc.pictureInPictureElement === video) {
      await doc.exitPictureInPicture();
      sessions.get(video)?.();
      return;
    }
    if (typeof video.requestPictureInPicture !== 'function') return fail('pipUnsupported');
    if (doc.pictureInPictureEnabled === false) return fail('pipPolicyBlocked');
    if (video.readyState === 0) return fail('pipNotReady');
    requests.add(video);
    const previous = video.getAttribute('disablepictureinpicture');
    let restored = false;
    const observer = new MutationObserver(() => {
      // Only the selected video's temporary PiP session overrides the hint.
      if (!restored && video.hasAttribute('disablepictureinpicture')) video.removeAttribute('disablepictureinpicture');
    });
    const restore = () => {
      if (restored) return;
      restored = true; observer.disconnect(); sessions.delete(video);
      video.removeEventListener('leavepictureinpicture', restore);
      video.removeEventListener('emptied', restore);
      doc.defaultView?.removeEventListener('pagehide', restore);
      if (previous === null) video.removeAttribute('disablepictureinpicture');
      else video.setAttribute('disablepictureinpicture', previous);
    };
    try {
      video.removeAttribute('disablepictureinpicture');
      observer.observe(video, { attributes: true, attributeFilter: ['disablepictureinpicture'] });
      video.addEventListener('leavepictureinpicture', restore);
      video.addEventListener('emptied', restore);
      doc.defaultView?.addEventListener('pagehide', restore, { once: true });
      sessions.set(video, restore);
      // No await before this call: retain transient activation from the click.
      await video.requestPictureInPicture();
    } catch (error) {
      restore();
      return fail(error?.name === 'SecurityError' ? 'pipPolicyBlocked' : error?.name === 'NotAllowedError' ? 'pipClickRequired' : error?.name === 'InvalidStateError' ? 'pipNotReady' : 'pipFailed');
    } finally { requests.delete(video); }
  }
  PD.PictureInPicture = Object.freeze({ toggle, resolveVideo });
})(globalThis);
