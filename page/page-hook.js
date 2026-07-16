(() => {
  "use strict";
  const previousInstallation = window.__openVideoCatcherPageHook;
  if (previousInstallation?.rearm) {
    previousInstallation.rearm();
    return;
  }
  if (previousInstallation?.stop) previousInstallation.stop();

  const installation = {};
  window.__openVideoCatcherPageHook = installation;

  const EVENT_NAME = "__OVC_MEDIA_CANDIDATE";
  const STOP_EVENT = "__OVC_CAPTURE_STOP";
  const MAX_CAPTURE_MS = 90000;
  const MEDIA_URL_PATTERN = /\.(m3u8|mpd|mp4|m4v|webm|mov|avi|mkv|flv|ogv|mp3|m4a|aac|ogg|oga|opus|wav|flac|ts|m4s|cmfv|cmfa)(?:[?#]|$)/i;
  const MEDIA_INITIATORS = new Set(["video", "audio", "source", "media", "fetch", "xmlhttprequest", "other"]);
  const MAX_SEEN = 600;
  const SEEN_TTL_MS = 15000;
  const seen = new Map();
  let captureUntil = Date.now() + MAX_CAPTURE_MS;
  let stopTimer = 0;
  let performanceObserver = null;
  let originalFetch = null;
  let fetchWrapper = null;
  let originalOpen = null;
  let xhrOpenWrapper = null;
  let originalCreateObjectURL = null;
  let createObjectURLWrapper = null;
  let stopped = false;

  function pruneSeen(current = Date.now()) {
    for (const [key, seenAt] of seen) {
      if (current - seenAt <= SEEN_TTL_MS) break;
      seen.delete(key);
    }
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  }

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

  function restoreHooks() {
    if (fetchWrapper && window.fetch === fetchWrapper) window.fetch = originalFetch;
    if (xhrOpenWrapper && window.XMLHttpRequest?.prototype?.open === xhrOpenWrapper) window.XMLHttpRequest.prototype.open = originalOpen;
    if (createObjectURLWrapper && URL.createObjectURL === createObjectURLWrapper) URL.createObjectURL = originalCreateObjectURL;
    fetchWrapper = null;
    xhrOpenWrapper = null;
    createObjectURLWrapper = null;
    originalFetch = null;
    originalOpen = null;
    originalCreateObjectURL = null;
  }

  function stopCapture() {
    if (stopped) return;
    stopped = true;
    captureUntil = 0;
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = 0;
    }
    if (performanceObserver) {
      performanceObserver.disconnect();
      performanceObserver = null;
    }
    restoreHooks();
    seen.clear();
    window.removeEventListener?.(STOP_EVENT, stopCapture);
    if (window.__openVideoCatcherPageHook === installation) {
      try { delete window.__openVideoCatcherPageHook; } catch (_error) { window.__openVideoCatcherPageHook = false; }
    }
  }

  function isCaptureActive() {
    if (!stopped && captureUntil && Date.now() <= captureUntil) return true;
    stopCapture();
    return false;
  }

  function emit(rawUrl, source, extra) {
    if (!isCaptureActive()) return;
    const url = normalizeUrl(rawUrl);
    if (!looksUseful(url, extra && extra.force)) return;
    const key = `${source}|${url}`;
    const current = Date.now();
    const previous = seen.get(key) || 0;
    if (previous && current - previous < 5000) return;
    seen.delete(key);
    seen.set(key, current);
    pruneSeen(current);
    const detail = JSON.stringify(Object.assign({
      url,
      source: `page-${source}`,
      label: source
    }, extra || {}));
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  }

  function installFetchHook() {
    if (fetchWrapper || typeof window.fetch !== "function") return;
    const delegate = window.fetch;
    originalFetch = delegate;
    fetchWrapper = function openVideoCatcherFetch(input) {
      emit(input, "fetch", { requestType: "fetch" });
      return Promise.resolve(delegate.apply(this, arguments)).then((response) => {
        try {
          const url = response && response.url ? response.url : normalizeUrl(input);
          const mimeType = response && response.headers ? response.headers.get("content-type") || "" : "";
          emit(url, "fetch-response", {
            requestType: "fetch",
            mimeType,
            force: /^audio\//i.test(mimeType) || /^video\//i.test(mimeType) || /mpegurl|dash\+xml/i.test(mimeType)
          });
        } catch (_error) {}
        return response;
      });
    };
    window.fetch = fetchWrapper;
  }

  function installXhrHook() {
    if (xhrOpenWrapper || !window.XMLHttpRequest?.prototype?.open) return;
    const delegate = window.XMLHttpRequest.prototype.open;
    originalOpen = delegate;
    xhrOpenWrapper = function openVideoCatcherXhrOpen(method, url) {
      emit(url, "xhr", { requestType: "xmlhttprequest" });
      this.addEventListener("readystatechange", () => {
        try {
          if (this.readyState === 2 || this.readyState === 4) {
            const mimeType = this.getResponseHeader("content-type") || "";
            emit(this.responseURL || url, "xhr-response", {
              requestType: "xmlhttprequest",
              mimeType,
              force: /^audio\//i.test(mimeType) || /^video\//i.test(mimeType) || /mpegurl|dash\+xml/i.test(mimeType)
            });
          }
        } catch (_error) {}
      });
      return delegate.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.open = xhrOpenWrapper;
  }

  function installObjectUrlHook() {
    if (createObjectURLWrapper || typeof URL.createObjectURL !== "function") return;
    const delegate = URL.createObjectURL;
    originalCreateObjectURL = delegate;
    createObjectURLWrapper = function openVideoCatcherCreateObjectURL(object) {
      const url = delegate.apply(this, arguments);
      const mimeType = object && typeof object.type === "string" ? object.type : "";
      emit(url, "object-url", {
        requestType: "blob",
        mimeType,
        force: Boolean(mimeType && /^(audio|video)\//i.test(mimeType))
      });
      return url;
    };
    URL.createObjectURL = createObjectURLWrapper;
  }

  function scanPerformanceEntries(entries) {
    try {
      for (const entry of entries) {
        const initiator = String(entry.initiatorType || "").toLowerCase();
        emit(entry.name, `perf-${initiator || "resource"}`, { requestType: initiator, force: MEDIA_INITIATORS.has(initiator) });
      }
    } catch (_error) {}
  }

  function startPerformanceObserver() {
    scanPerformanceEntries(performance.getEntriesByType("resource"));
    if (typeof PerformanceObserver !== "function") return;
    try {
      performanceObserver = new PerformanceObserver((list) => {
        if (!isCaptureActive()) return;
        scanPerformanceEntries(list.getEntries());
      });
      performanceObserver.observe({ type: "resource", buffered: false });
    } catch (_error) {
      performanceObserver = null;
    }
  }

  function rearmCapture() {
    if (stopped) return;
    captureUntil = Date.now() + MAX_CAPTURE_MS;
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(stopCapture, MAX_CAPTURE_MS + 250);
    try { scanPerformanceEntries(performance.getEntriesByType("resource")); } catch (_error) {}
  }

  installation.stop = stopCapture;
  installation.rearm = rearmCapture;
  window.addEventListener(STOP_EVENT, stopCapture);
  try {
    installFetchHook();
    installXhrHook();
    installObjectUrlHook();
    startPerformanceObserver();
    rearmCapture();
  } catch (_error) {
    stopCapture();
  }
})();
