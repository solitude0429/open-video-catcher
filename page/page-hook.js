(() => {
  "use strict";
  if (window.__openVideoCatcherPageHook) return;
  window.__openVideoCatcherPageHook = true;

  const EVENT_NAME = "__OVC_MEDIA_CANDIDATE";
  const MEDIA_URL_PATTERN = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|flv|ogv|mp3|m4a|aac|ogg|oga|opus|wav|flac|ts|m4s|cmfv|cmfa)(?:[?#]|$)/i;
  const MEDIA_INITIATORS = new Set(["video", "audio", "source", "media", "fetch", "xmlhttprequest", "other"]);
  const seen = new Map();

  function normalizeUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, document.baseURI).href;
      if (input && typeof input.url === "string") return new URL(input.url, document.baseURI).href;
    } catch (_error) {
      return "";
    }
    return "";
  }

  function looksUseful(url, force) {
    if (!url) return false;
    if (url.startsWith("blob:")) return true;
    if (force) return true;
    return MEDIA_URL_PATTERN.test(url);
  }

  function emit(rawUrl, source, extra) {
    const url = normalizeUrl(rawUrl);
    if (!looksUseful(url, extra && extra.force)) return;
    const key = `${source}|${url}`;
    const now = Date.now();
    if (seen.has(key) && now - seen.get(key) < 2500) return;
    seen.set(key, now);
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: Object.assign({ url, source: `page-${source}`, label: source }, extra || {})
    }));
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function openVideoCatcherFetch(input, init) {
      emit(input, "fetch", { requestType: "fetch" });
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          const url = response && response.url ? response.url : normalizeUrl(input);
          const mimeType = response && response.headers ? response.headers.get("content-type") || "" : "";
          emit(url, "fetch-response", { requestType: "fetch", mimeType, force: /^audio\//i.test(mimeType) || /^video\//i.test(mimeType) || /mpegurl|dash\+xml/i.test(mimeType) });
        } catch (_error) {}
        return response;
      });
    };
  }

  const originalOpen = XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open;
  if (typeof originalOpen === "function") {
    XMLHttpRequest.prototype.open = function openVideoCatcherXhrOpen(method, url) {
      emit(url, "xhr", { requestType: "xmlhttprequest" });
      this.addEventListener("readystatechange", () => {
        try {
          if (this.readyState === 2 || this.readyState === 4) {
            const mimeType = this.getResponseHeader("content-type") || "";
            emit(this.responseURL || url, "xhr-response", { requestType: "xmlhttprequest", mimeType, force: /^audio\//i.test(mimeType) || /^video\//i.test(mimeType) || /mpegurl|dash\+xml/i.test(mimeType) });
          }
        } catch (_error) {}
      });
      return originalOpen.apply(this, arguments);
    };
  }

  const originalCreateObjectURL = URL.createObjectURL;
  if (typeof originalCreateObjectURL === "function") {
    URL.createObjectURL = function openVideoCatcherCreateObjectURL(object) {
      const url = originalCreateObjectURL.apply(this, arguments);
      const mimeType = object && typeof object.type === "string" ? object.type : "";
      emit(url, "object-url", { requestType: "blob", mimeType, force: Boolean(mimeType && /^(audio|video)\//i.test(mimeType)) });
      return url;
    };
  }

  function scanPerformance() {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const initiator = String(entry.initiatorType || "").toLowerCase();
        emit(entry.name, `perf-${initiator || "resource"}`, { requestType: initiator, force: MEDIA_INITIATORS.has(initiator) });
      }
    } catch (_error) {}
  }

  window.addEventListener("load", scanPerformance, { once: true });
  scanPerformance();
  setInterval(scanPerformance, 3000);
})();
