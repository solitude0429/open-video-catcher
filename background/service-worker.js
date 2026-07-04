if (typeof importScripts === "function" && !globalThis.OpenVideoCatcherUtils) {
  importScripts("../src/media-utils.js");
}

const utils = globalThis.OpenVideoCatcherUtils;
const api = chrome;
const mediaByTab = new Map();
const analyzedPlaylists = new Set();
const captureUntilByTab = new Map();
const diagnosticsByTab = new Map();
const MAX_ITEMS_PER_TAB = 500;
const CAPTURE_DURATION_MS = 90000;
const WATCHED_TYPES = ["media", "xmlhttprequest", "object", "other"];

function ignorePromise(result) {
  if (result && typeof result.catch === "function") result.catch(() => {});
}

function tabStore(tabId) {
  if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, new Map());
  return mediaByTab.get(tabId);
}

function isCaptureActive(tabId) {
  const until = captureUntilByTab.get(tabId) || 0;
  if (Date.now() <= until) return true;
  if (until) captureUntilByTab.delete(tabId);
  return false;
}

function startCaptureWindow(tabId, durationMs = CAPTURE_DURATION_MS) {
  const until = Date.now() + durationMs;
  captureUntilByTab.set(tabId, until);
  diagnosticsByTab.set(tabId, createDiagnostics(tabId, until));
  return until;
}

function createDiagnostics(tabId, captureUntil = 0) {
  return {
    tabId,
    startedAt: Date.now(),
    captureUntil,
    contentInjectionOk: false,
    contentFrames: 0,
    mainWorldHookOk: false,
    mainWorldHookFrames: 0,
    contentFallbackHookOk: false,
    scanMessageOk: false,
    hostPermissionGranted: null,
    networkSeen: 0,
    networkRecorded: 0,
    networkDiscarded: 0,
    pageCandidatesSeen: 0,
    pageCandidatesRecorded: 0,
    lastNetworkUrl: "",
    lastPageUrl: "",
    warning: ""
  };
}

function tabDiagnostics(tabId) {
  if (!diagnosticsByTab.has(tabId)) diagnosticsByTab.set(tabId, createDiagnostics(tabId, captureUntilByTab.get(tabId) || 0));
  return diagnosticsByTab.get(tabId);
}

function resetTab(tabId) {
  mediaByTab.delete(tabId);
  for (const key of Array.from(analyzedPlaylists)) {
    if (key.startsWith(`${tabId}|`)) analyzedPlaylists.delete(key);
  }
  setBadge(tabId);
}

function sortedItems(tabId) {
  const store = mediaByTab.get(tabId);
  if (!store) return [];
  return Array.from(store.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function trimStore(store) {
  if (store.size <= MAX_ITEMS_PER_TAB) return;
  const items = Array.from(store.values()).sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  for (const item of items.slice(0, store.size - MAX_ITEMS_PER_TAB)) store.delete(item.id);
}

function setBadge(tabId) {
  const count = mediaByTab.get(tabId)?.size || 0;
  const text = count > 0 ? String(Math.min(count, 99)) : "";
  ignorePromise(api.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }));
  ignorePromise(api.action.setBadgeText({ tabId, text }));
}

function notifyPopup(tabId) {
  ignorePromise(api.runtime.sendMessage({ type: "OVC_TAB_MEDIA_UPDATED", tabId }).catch?.(() => {}));
}

function shouldAnalyze(item) {
  return item && (item.kind === "hls-playlist" || item.kind === "dash-manifest") && !item.parentPlaylistUrl;
}

function recordItem(tabId, item, options = {}) {
  if (!Number.isInteger(tabId) || tabId < 0 || !item || !item.id) return false;
  const store = tabStore(tabId);
  for (const [key, existingItem] of store) {
    if (key !== item.id && existingItem.url === item.url) store.delete(key);
  }
  const existing = store.get(item.id);
  const merged = utils.mergeMediaItems(existing, item);
  store.set(item.id, merged);
  trimStore(store);
  setBadge(tabId);
  if (!options.silent) notifyPopup(tabId);
  if (!options.skipAnalyze && shouldAnalyze(merged)) {
    analyzePlaylist(tabId, merged, { force: false }).catch(() => {});
  }
  return true;
}

function recordRawMedia(tabId, rawItem, defaultSource) {
  if (!isCaptureActive(tabId)) return false;
  const diag = tabDiagnostics(tabId);
  diag.pageCandidatesSeen += 1;
  diag.lastPageUrl = utils.redactUrl(rawItem?.url || "");
  const item = utils.createMediaItem({
    url: rawItem.url,
    pageUrl: rawItem.pageUrl,
    pageTitle: rawItem.pageTitle,
    label: rawItem.label,
    source: rawItem.source || defaultSource || "unknown",
    requestType: rawItem.requestType || "",
    fromDom: true,
    mimeType: rawItem.mimeType || "",
    contentDisposition: rawItem.contentDisposition || "",
    size: rawItem.size || 0,
    now: Date.now()
  });
  if (!item) return false;
  const recorded = recordItem(tabId, item);
  if (recorded) diag.pageCandidatesRecorded += 1;
  return recorded;
}

function recordFromRequest(details, extra) {
  if (!details || details.tabId < 0 || !details.url || !isCaptureActive(details.tabId)) return;
  const diag = tabDiagnostics(details.tabId);
  diag.networkSeen += 1;
  diag.lastNetworkUrl = utils.redactUrl(details.url);
  const item = utils.createMediaItem({
    url: details.url,
    source: "network",
    requestType: details.type,
    mimeType: extra?.mimeType || "",
    contentDisposition: extra?.contentDisposition || "",
    size: extra?.size || 0,
    now: Date.now()
  });
  if (item) {
    if (recordItem(details.tabId, item)) diag.networkRecorded += 1;
  } else {
    diag.networkDiscarded += 1;
  }
}


function extensionApiCall(callbackInvoke, promiseInvoke) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    };
    try {
      const maybePromise = callbackInvoke(finish);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(finish, (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      } else if (maybePromise !== undefined) {
        finish(maybePromise);
      }
    } catch (callbackError) {
      if (!promiseInvoke) {
        reject(callbackError);
        return;
      }
      try {
        Promise.resolve(promiseInvoke()).then(finish, (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      } catch (_promiseError) {
        reject(callbackError);
      }
    }
  });
}

async function executeScript(details) {
  return extensionApiCall(
    (done) => api.scripting.executeScript(details, done),
    () => api.scripting.executeScript(details)
  );
}

function resultCount(results) {
  return Array.isArray(results) ? results.length : 0;
}

async function ensureContentScripts(tabId) {
  if (!api.scripting || typeof api.scripting.executeScript !== "function") {
    throw new Error("scripting API를 사용할 수 없습니다.");
  }
  const shared = {
    target: { tabId, allFrames: true },
    files: ["src/media-utils.js"]
  };
  const content = {
    target: { tabId, allFrames: true },
    files: ["content/content-script.js"]
  };
  const sharedResults = await executeScript(shared);
  const contentResults = await executeScript(content);
  return resultCount(sharedResults) + resultCount(contentResults);
}

async function injectPageHookMainWorld(tabId) {
  const details = {
    target: { tabId, allFrames: true },
    files: ["page/page-hook.js"],
    world: "MAIN"
  };
  const results = await executeScript(details);
  return resultCount(results);
}

async function sendTabMessage(tabId, message) {
  return extensionApiCall(
    (done) => api.tabs.sendMessage(tabId, message, done),
    () => api.tabs.sendMessage(tabId, message)
  );
}

async function hasAllUrlsPermission() {
  if (!api.permissions || typeof api.permissions.contains !== "function") return null;
  try {
    return await extensionApiCall(
      (done) => api.permissions.contains({ origins: ["<all_urls>"] }, done),
      () => api.permissions.contains({ origins: ["<all_urls>"] })
    );
  } catch (_error) {
    return null;
  }
}

async function startDetection(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: "활성 탭을 찾을 수 없습니다." };
  resetTab(tabId);
  const captureUntil = startCaptureWindow(tabId);
  const diag = tabDiagnostics(tabId);
  diag.hostPermissionGranted = await hasAllUrlsPermission();

  try {
    diag.contentFrames = await ensureContentScripts(tabId);
    diag.contentInjectionOk = true;
  } catch (error) {
    diag.warning = `content script 주입 실패: ${error.message || String(error)}`;
  }

  try {
    diag.mainWorldHookFrames = await injectPageHookMainWorld(tabId);
    diag.mainWorldHookOk = true;
  } catch (error) {
    const message = `main-world hook 주입 실패: ${error.message || String(error)}`;
    diag.warning = diag.warning ? `${diag.warning}; ${message}` : message;
  }

  try {
    const scanResult = await sendTabMessage(tabId, { type: "OVC_SCAN_NOW", durationMs: CAPTURE_DURATION_MS });
    diag.scanMessageOk = true;
    diag.contentFallbackHookOk = Boolean(scanResult?.pageHookInjected);
  } catch (error) {
    const message = `스캔 메시지 실패: ${error.message || String(error)}`;
    diag.warning = diag.warning ? `${diag.warning}; ${message}` : message;
  }

  return {
    ok: true,
    captureUntil,
    durationMs: CAPTURE_DURATION_MS,
    injectionOk: diag.contentInjectionOk,
    scanOk: diag.scanMessageOk,
    warning: diag.warning,
    diagnostics: diag,
    items: sortedItems(tabId)
  };
}

async function fetchText(url) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 6000) : null;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function enrichExistingItem(tabId, itemId, patch) {
  const store = mediaByTab.get(tabId);
  if (!store) return null;
  const existing = store.get(itemId);
  if (!existing) return null;
  const enriched = utils.mergeMediaItems(existing, Object.assign({}, existing, patch, { lastSeen: Date.now() }));
  store.set(itemId, enriched);
  setBadge(tabId);
  notifyPopup(tabId);
  return enriched;
}

function recordHlsVariants(tabId, parentItem, analysis) {
  for (const variant of analysis.variants || []) {
    const item = utils.createMediaItem({
      url: variant.url,
      source: "hls-variant",
      requestType: "playlist",
      mimeType: "application/vnd.apple.mpegurl",
      label: variant.qualityLabel || "HLS variant",
      qualityLabel: variant.qualityLabel || "",
      bandwidth: variant.bandwidth || 0,
      averageBandwidth: variant.averageBandwidth || 0,
      resolution: variant.resolution || "",
      frameRate: variant.frameRate || "",
      codecs: variant.codecs || "",
      parentPlaylistUrl: parentItem.url,
      now: Date.now()
    });
    if (item) recordItem(tabId, item, { skipAnalyze: true, silent: true });
  }
  setBadge(tabId);
  notifyPopup(tabId);
}

async function analyzePlaylist(tabId, item, options = {}) {
  if (!item || !item.url || !shouldAnalyze(item)) return { ok: false, error: "분석할 playlist/manifest 항목이 아닙니다." };
  const key = `${tabId}|${item.id}`;
  if (!options.force && analyzedPlaylists.has(key)) return { ok: true, skipped: true };
  analyzedPlaylists.add(key);

  try {
    const text = await fetchText(item.url);
    let analysis;
    if (item.kind === "hls-playlist") {
      analysis = utils.parseHlsPlaylist(text, item.url);
      const enriched = enrichExistingItem(tabId, item.id, {
        analysis,
        encrypted: analysis.encrypted,
        label: item.label || (analysis.isMaster ? "HLS master playlist" : "HLS media playlist")
      });
      if (enriched) recordHlsVariants(tabId, enriched, analysis);
    } else {
      analysis = utils.parseDashManifest(text, item.url);
      enrichExistingItem(tabId, item.id, {
        analysis,
        encrypted: analysis.protectedContent,
        label: item.label || "DASH manifest"
      });
    }
    return { ok: true, analysis };
  } catch (error) {
    enrichExistingItem(tabId, item.id, {
      analysis: { type: item.kind === "hls-playlist" ? "hls" : "dash", error: error.message }
    });
    return { ok: false, error: error.message };
  }
}

api.webRequest.onBeforeRequest.addListener(
  (details) => recordFromRequest(details),
  { urls: ["<all_urls>"], types: WATCHED_TYPES }
);

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders || [];
    const contentType = headers.find((header) => header.name && header.name.toLowerCase() === "content-type")?.value || "";
    const contentLength = headers.find((header) => header.name && header.name.toLowerCase() === "content-length")?.value || "";
    const contentDisposition = headers.find((header) => header.name && header.name.toLowerCase() === "content-disposition")?.value || "";
    if (!contentType && !contentLength && !contentDisposition) return;
    recordFromRequest(details, { mimeType: contentType, contentDisposition, size: Number(contentLength) || 0 });
  },
  { urls: ["<all_urls>"], types: WATCHED_TYPES },
  ["responseHeaders"]
);

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "OVC_MEDIA_FOUND_BATCH") {
    const tabId = sender.tab?.id;
    const items = Array.isArray(message.items) ? message.items : [];
    let recorded = 0;
    for (const rawItem of items.slice(0, 100)) {
      if (recordRawMedia(tabId, rawItem, "dom")) recorded += 1;
    }
    sendResponse({ ok: true, recorded });
    return true;
  }

  if (message.type === "OVC_GET_TAB_MEDIA") {
    const tabId = Number(message.tabId);
    sendResponse({ ok: true, items: sortedItems(tabId), captureActive: isCaptureActive(tabId), captureUntil: captureUntilByTab.get(tabId) || 0, diagnostics: tabDiagnostics(tabId) });
    return true;
  }

  if (message.type === "OVC_START_DETECTION") {
    const tabId = Number(message.tabId);
    startDetection(tabId).then(sendResponse);
    return true;
  }

  if (message.type === "OVC_CLEAR_TAB") {
    const tabId = Number(message.tabId);
    resetTab(tabId);
    captureUntilByTab.delete(tabId);
    diagnosticsByTab.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "OVC_ANALYZE_PLAYLIST") {
    const tabId = Number(message.tabId);
    const item = sortedItems(tabId).find((candidate) => candidate.id === message.id);
    if (!item) {
      sendResponse({ ok: false, error: "미디어 항목을 찾을 수 없습니다." });
      return true;
    }
    analyzePlaylist(tabId, item, { force: true }).then((result) => {
      sendResponse(Object.assign({}, result, { items: sortedItems(tabId) }));
    });
    return true;
  }

  if (message.type === "OVC_DOWNLOAD") {
    const tabId = Number(message.tabId);
    const item = sortedItems(tabId).find((candidate) => candidate.id === message.id);
    if (!item) {
      sendResponse({ ok: false, error: "미디어 항목을 찾을 수 없습니다." });
      return true;
    }
    if (!item.downloadable) {
      sendResponse({ ok: false, error: "이 항목은 브라우저 다운로드 API로 직접 저장할 수 없습니다." });
      return true;
    }
    api.downloads.download({
      url: item.url,
      filename: item.fileName,
      saveAs: true,
      conflictAction: "uniquify"
    }, (downloadId) => {
      const error = api.runtime.lastError;
      if (error) sendResponse({ ok: false, error: error.message });
      else sendResponse({ ok: true, downloadId });
    });
    return true;
  }

  return false;
});

api.tabs.onRemoved.addListener((tabId) => {
  resetTab(tabId);
  captureUntilByTab.delete(tabId);
  diagnosticsByTab.delete(tabId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    resetTab(tabId);
    captureUntilByTab.delete(tabId);
    diagnosticsByTab.delete(tabId);
  }
});
