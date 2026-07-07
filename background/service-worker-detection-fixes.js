(() => {
  "use strict";

  const api = chrome;
  const CAPTURE_DEFAULT_MS = 90000;
  const activeUntilByTab = new Map();
  const headerHintsByUrl = new Map();
  const MEDIA_HINT_PATTERN = /(?:^|[/?&._=-])(m3u8|mpd|hls|dash|manifest|playlist|master|chunklist|videoplayback|video|audio|media|stream|playback|segment|fragment|frag|fmp4|m4s|init|range|asset|content|download|file)(?:[/?&._=-]|$)/i;
  const GENERIC_MIME = /^(|application\/octet-stream|binary\/octet-stream|application\/x-binary|text\/plain)$/i;
  const FETCH_LIKE_TYPES = new Set(["fetch", "xmlhttprequest", "other", "object", ""]);
  const MIN_LARGE_BYTES = 256 * 1024;
  const MAX_HEADER_HINTS = 1000;

  function parseUrl(url, baseUrl) {
    try { return new URL(url, baseUrl || "https://example.invalid/"); } catch (_error) { return null; }
  }

  function normalizeMime(value) {
    return String(value || "").split(";")[0].trim().toLowerCase();
  }

  function isNetworkUrl(url) {
    const parsed = parseUrl(url);
    return Boolean(parsed && (parsed.protocol === "http:" || parsed.protocol === "https:"));
  }

  function extensionFromPathname(pathname) {
    const match = String(pathname || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : "";
  }

  function extensionFromContentDisposition(value) {
    const text = String(value || "");
    const star = text.match(/filename\*\s*=\s*([^;]+)/i);
    const normal = text.match(/filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i);
    let filename = "";
    if (star) {
      const raw = star[1].trim().replace(/^"|"$/g, "");
      const match = raw.match(/^(?:[A-Za-z0-9_-]+)?''(.+)$/);
      try { filename = decodeURIComponent(match ? match[1] : raw); } catch (_error) { filename = match ? match[1] : raw; }
    } else if (normal) {
      filename = normal[1].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"');
    }
    return extensionFromPathname(filename.replace(/[?#].*$/, ""));
  }

  function hasMediaExtension(utils, ext) {
    if (!ext) return false;
    return Boolean(utils.DIRECT_MEDIA_EXTENSIONS?.has(ext) || utils.PLAYLIST_EXTENSIONS?.has(ext) || utils.SEGMENT_EXTENSIONS?.has(ext));
  }

  function mediaKindForExtension(utils, ext) {
    return utils.DIRECT_MEDIA_EXTENSIONS?.get(ext) || utils.PLAYLIST_EXTENSIONS?.get(ext) || utils.SEGMENT_EXTENSIONS?.get(ext) || "";
  }

  function headerValue(headers, name) {
    const lower = String(name || "").toLowerCase();
    return headers.find((header) => header.name && header.name.toLowerCase() === lower)?.value || "";
  }

  function rememberHeaderHints(details) {
    if (!details?.url) return;
    const headers = details.responseHeaders || [];
    const hint = {
      mimeType: headerValue(headers, "content-type"),
      size: Number(headerValue(headers, "content-length") || 0) || 0,
      contentRange: headerValue(headers, "content-range"),
      acceptRanges: headerValue(headers, "accept-ranges"),
      statusCode: details.statusCode || 0,
      seenAt: Date.now()
    };
    headerHintsByUrl.set(details.url, hint);
    if (headerHintsByUrl.size > MAX_HEADER_HINTS) {
      const oldest = Array.from(headerHintsByUrl.entries()).sort((a, b) => (a[1].seenAt || 0) - (b[1].seenAt || 0)).slice(0, headerHintsByUrl.size - MAX_HEADER_HINTS);
      for (const [url] of oldest) headerHintsByUrl.delete(url);
    }
  }

  function installHeaderHintRecorder() {
    try {
      api.webRequest.onHeadersReceived.addListener(rememberHeaderHints, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame", "object", "xmlhttprequest", "media", "other"] }, ["responseHeaders"]);
    } catch (_error) {}
  }

  function patchUtils() {
    const utils = globalThis.OpenVideoCatcherUtils;
    if (!utils || utils.__openVideoCatcherDetectionFixes) return;
    utils.__openVideoCatcherDetectionFixes = true;

    const originalShouldSniff = utils.shouldSniffMediaUrl.bind(utils);
    const originalCreateMediaItem = utils.createMediaItem.bind(utils);
    const originalKindLabel = utils.kindLabel?.bind(utils);

    utils.shouldSniffMediaUrl = function patchedShouldSniffMediaUrl(url, options) {
      if (originalShouldSniff(url, options)) return true;
      const opts = options || {};
      const parsed = parseUrl(url, opts.baseUrl);
      if (!parsed || !isNetworkUrl(parsed.href)) return false;
      const ext = extensionFromPathname(parsed.pathname);
      if (hasMediaExtension(utils, ext)) return false;
      const requestType = String(opts.requestType || "").toLowerCase();
      if (!FETCH_LIKE_TYPES.has(requestType)) return false;
      const mime = normalizeMime(opts.mimeType || opts.contentType || "");
      if (mime && !GENERIC_MIME.test(mime)) return false;
      const hint = headerHintsByUrl.get(parsed.href) || {};
      const size = Number(opts.size || opts.contentLength || hint.size || 0) || 0;
      const statusCode = Number(opts.statusCode || hint.statusCode || 0) || 0;
      const contentRange = String(opts.contentRange || hint.contentRange || "");
      const acceptRanges = String(opts.acceptRanges || hint.acceptRanges || "");
      const hintedMime = normalizeMime(hint.mimeType || "");
      if (hintedMime && !GENERIC_MIME.test(hintedMime)) return false;
      const rangeSignal = statusCode === 206 || /^bytes/i.test(contentRange) || /\bbytes\b/i.test(acceptRanges);
      const urlSignal = MEDIA_HINT_PATTERN.test(`${parsed.pathname}${parsed.search}`.toLowerCase());
      return urlSignal || rangeSignal || size >= MIN_LARGE_BYTES;
    };

    utils.createMediaItem = function patchedCreateMediaItem(input) {
      const data = input || {};
      const item = originalCreateMediaItem(data);
      if (item) return item;

      const dispositionExt = extensionFromContentDisposition(data.contentDisposition);
      const dispositionKind = mediaKindForExtension(utils, dispositionExt);
      if (dispositionKind && isNetworkUrl(data.url)) {
        return originalCreateMediaItem(Object.assign({}, data, {
          url: data.url,
          mimeType: data.mimeType || data.contentType || (dispositionKind === "video" ? "video/mp4" : dispositionKind === "audio" ? "audio/mpeg" : ""),
          contentDisposition: data.contentDisposition
        }));
      }

      if (String(data.source || "").endsWith("-sniff") && isNetworkUrl(data.url)) {
        const now = data.now || Date.now();
        const filename = utils.guessFilename(data.url, { kind: "unknown-candidate", ext: "bin", mimeType: normalizeMime(data.mimeType || data.contentType || "") }, data.pageTitle || data.label || "candidate", data.contentDisposition);
        return {
          id: utils.hashString(`${data.url}|unknown-candidate`),
          url: data.url,
          displayUrl: utils.redactUrl(data.url),
          pageUrl: data.pageUrl ? utils.redactUrl(data.pageUrl) : "",
          pageTitle: data.pageTitle || "",
          label: data.label || "",
          source: data.source || "candidate-sniff",
          requestType: data.requestType || "",
          kind: "unknown-candidate",
          ext: "bin",
          mimeType: normalizeMime(data.mimeType || data.contentType || ""),
          protocol: parseUrl(data.url).protocol,
          fileName: filename,
          size: Number(data.size || 0) || 0,
          sizeText: utils.formatBytes(data.size),
          downloadable: false,
          lowConfidence: true,
          qualityLabel: "",
          bandwidth: 0,
          averageBandwidth: 0,
          resolution: "",
          frameRate: "",
          codecs: "",
          parentPlaylistUrl: "",
          encrypted: false,
          analysis: null,
          firstSeen: now,
          lastSeen: now,
          count: 1
        };
      }

      return null;
    };

    if (originalKindLabel) {
      utils.kindLabel = function patchedKindLabel(kind) {
        if (kind === "unknown-candidate") return "Unclassified candidate";
        return originalKindLabel(kind);
      };
    }
  }

  function extensionApiCall(promiseInvoke, callbackInvoke, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let callbackAttempted = false;
      let timer = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const error = api.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const tryCallback = (cause) => {
        if (settled || callbackAttempted || typeof callbackInvoke !== "function") {
          if (cause) fail(cause);
          return;
        }
        callbackAttempted = true;
        try {
          const result = callbackInvoke(finish);
          if (result && typeof result.then === "function") result.then(finish, fail);
          else if (result !== undefined) finish(result);
        } catch (error) {
          fail(cause || error);
        }
      };
      try {
        const result = promiseInvoke();
        if (result && typeof result.then === "function") result.then(finish, (error) => tryCallback(error));
        else if (result !== undefined) finish(result);
        else tryCallback();
      } catch (error) {
        tryCallback(error);
      }
      if (timeoutMs > 0) timer = setTimeout(() => fail(new Error("브라우저 확장 API 응답 시간이 초과되었습니다.")), timeoutMs);
    });
  }

  async function executeScript(details) {
    return extensionApiCall(
      () => api.scripting.executeScript(details),
      (done) => api.scripting.executeScript(details, done)
    );
  }

  async function sendTabMessage(tabId, message) {
    return extensionApiCall(
      () => api.tabs.sendMessage(tabId, message),
      (done) => api.tabs.sendMessage(tabId, message, done)
    );
  }

  async function resumeCaptureAfterNavigation(tabId, captureUntil) {
    const durationMs = Math.max(1000, captureUntil - Date.now());
    try { await executeScript({ target: { tabId, allFrames: true }, files: ["src/media-utils.js"] }); } catch (_error) {}
    try { await executeScript({ target: { tabId, allFrames: true }, files: ["content/content-script.js"] }); } catch (_error) {}
    try { await executeScript({ target: { tabId, allFrames: true }, files: ["page/page-hook.js"], world: "MAIN" }); } catch (_error) {}
    try { await sendTabMessage(tabId, { type: "OVC_SCAN_NOW", durationMs }); } catch (_error) {}
    try { api.runtime.sendMessage({ type: "OVC_TAB_MEDIA_UPDATED", tabId }, () => { void api.runtime.lastError; }); } catch (_error) {}
  }

  function patchExtensionEvents() {
    const originalRuntimeAdd = api.runtime.onMessage.addListener.bind(api.runtime.onMessage);
    api.runtime.onMessage.addListener = function patchedRuntimeAddListener(listener) {
      return originalRuntimeAdd((message, sender, sendResponse) => {
        if (message?.type === "OVC_CLEAR_TAB") activeUntilByTab.delete(Number(message.tabId));
        if (message?.type !== "OVC_START_DETECTION") return listener(message, sender, sendResponse);
        const wrappedSendResponse = (response) => {
          const tabId = Number(message.tabId);
          if (Number.isInteger(tabId) && response?.captureUntil) activeUntilByTab.set(tabId, response.captureUntil);
          sendResponse(response);
        };
        return listener(message, sender, wrappedSendResponse);
      });
    };

    const originalTabsAdd = api.tabs.onUpdated.addListener.bind(api.tabs.onUpdated);
    api.tabs.onUpdated.addListener = function patchedTabsAddListener(listener) {
      return originalTabsAdd((tabId, changeInfo, tab) => {
        const captureUntil = activeUntilByTab.get(tabId) || 0;
        if (changeInfo.status === "loading" && Date.now() <= captureUntil) return;
        return listener(tabId, changeInfo, tab);
      });
    };

    originalTabsAdd((tabId, changeInfo) => {
      const captureUntil = activeUntilByTab.get(tabId) || 0;
      if (changeInfo.status === "complete" && Date.now() <= captureUntil) {
        resumeCaptureAfterNavigation(tabId, captureUntil).catch(() => {});
      }
      if (captureUntil && Date.now() > captureUntil) activeUntilByTab.delete(tabId);
    });

    api.tabs.onRemoved.addListener((tabId) => activeUntilByTab.delete(tabId));
  }

  if (typeof importScripts === "function") {
    importScripts("../src/media-utils.js");
    installHeaderHintRecorder();
    patchUtils();
    patchExtensionEvents();
    importScripts("service-worker.js");
  }
})();
