if (typeof importScripts === "function" && !globalThis.OpenVideoCatcherUtils) {
  importScripts("../src/media-utils.js");
}

const utils = globalThis.OpenVideoCatcherUtils;
const api = chrome;
const mediaByTab = new Map();
const analyzedPlaylists = new Set();
const MAX_ITEMS_PER_TAB = 500;
const WATCHED_TYPES = ["media", "xmlhttprequest", "object", "other"];

function ignorePromise(result) {
  if (result && typeof result.catch === "function") result.catch(() => {});
}

function tabStore(tabId) {
  if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, new Map());
  return mediaByTab.get(tabId);
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
  const item = utils.createMediaItem({
    url: rawItem.url,
    pageUrl: rawItem.pageUrl,
    pageTitle: rawItem.pageTitle,
    label: rawItem.label,
    source: rawItem.source || defaultSource || "unknown",
    requestType: rawItem.requestType || "",
    fromDom: true,
    mimeType: rawItem.mimeType || "",
    size: rawItem.size || 0,
    now: Date.now()
  });
  if (!item) return false;
  return recordItem(tabId, item);
}

function recordFromRequest(details, extra) {
  if (!details || details.tabId < 0 || !details.url) return;
  const item = utils.createMediaItem({
    url: details.url,
    source: "network",
    requestType: details.type,
    mimeType: extra?.mimeType || "",
    size: extra?.size || 0,
    now: Date.now()
  });
  if (item) recordItem(details.tabId, item);
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
    if (!contentType && !contentLength) return;
    recordFromRequest(details, { mimeType: contentType, size: Number(contentLength) || 0 });
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
    sendResponse({ ok: true, items: sortedItems(tabId) });
    return true;
  }

  if (message.type === "OVC_CLEAR_TAB") {
    const tabId = Number(message.tabId);
    mediaByTab.delete(tabId);
    for (const key of Array.from(analyzedPlaylists)) {
      if (key.startsWith(`${tabId}|`)) analyzedPlaylists.delete(key);
    }
    setBadge(tabId);
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
  mediaByTab.delete(tabId);
  for (const key of Array.from(analyzedPlaylists)) {
    if (key.startsWith(`${tabId}|`)) analyzedPlaylists.delete(key);
  }
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    mediaByTab.delete(tabId);
    for (const key of Array.from(analyzedPlaylists)) {
      if (key.startsWith(`${tabId}|`)) analyzedPlaylists.delete(key);
    }
    setBadge(tabId);
  }
});
