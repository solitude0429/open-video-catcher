/*
 * Shared Open Video Catcher background runtime.
 * This file is intentionally adapter-free so Chrome MV3 service workers,
 * Firefox background scripts, and Node regression tests run the same policy.
 */
(function attachBackgroundCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OpenVideoCatcherBackgroundCore = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function backgroundCoreFactory() {
  "use strict";

  const DEFAULT_CAPTURE_DURATION_MS = 90000;
  const WATCHED_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"];
  const FETCH_LIKE_TYPES = new Set(["media", "video", "audio", "source", "fetch", "xmlhttprequest", "object", "other", ""]);
  const GENERIC_MIME = /^(|application\/octet-stream|binary\/octet-stream|application\/x-binary|text\/plain)$/i;
  const MEDIA_HINT_PATTERN = /(?:^|[/?&._=-])(m3u8|mpd|hls|dash|manifest|playlist|master|chunklist|videoplayback|video|audio|media|stream|playback|segment|fragment|frag|fmp4|m4s|init|range|asset|content|download|file)(?:[/?&._=-]|$)/i;
  const SESSION_KEY = "openVideoCatcher.runtime.v1";
  const CLEANUP_ALARM = "openVideoCatcher.cleanup";
  const CLEANUP_ALARM_PREFIX = `${CLEANUP_ALARM}.tab.`;

  const LIMITS = Object.freeze({
    maxItemsPerTab: 500,
    maxObservedPerTab: 300,
    observationTtlMs: 15000,
    maxUrlLength: 4096,
    maxLabelLength: 256,
    maxPageCandidatesPerSecond: 10,
    maxPageCandidatesTotal: 200,
    maxBatchItems: 50,
    maxBatchPayloadBytes: 64 * 1024,
    maxSessionBytes: 512 * 1024,
    maxSniffBytes: 16384,
    maxSniffAttemptsPerTab: 40,
    maxNetworkEventsPerTab: 1000,
    maxPlaylistAnalysesPerTab: 20,
    maxGlobalFetches: 3,
    maxFetchesPerTab: 2,
    maxQueuedFetches: 100,
    fetchTimeoutMs: 6000,
    maxPlaylistBytes: 1024 * 1024
  });

  function byteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function ignorePromise(result) {
    if (result && typeof result.catch === "function") result.catch(() => {});
  }

  function normalizeMime(value) {
    return String(value || "").split(";")[0].trim().toLowerCase();
  }

  function parseUrl(url, baseUrl) {
    if (!url || typeof url !== "string" || url.length > LIMITS.maxUrlLength) return null;
    try { return new URL(url, baseUrl || "https://example.invalid/"); } catch (_error) { return null; }
  }

  function headerValue(headers, name) {
    const lower = String(name || "").toLowerCase();
    return (headers || []).find((header) => header.name && String(header.name).toLowerCase() === lower)?.value || "";
  }

  function extensionApiCall(api, apiMode, promiseInvoke, callbackInvoke, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const error = api.runtime?.lastError;
        if (error) reject(new Error(error.message || String(error)));
        else resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      if (timeoutMs > 0) timer = setTimeout(() => fail(new Error("브라우저 확장 API 응답 시간이 초과되었습니다.")), timeoutMs);
      try {
        if (apiMode === "callback") {
          callbackInvoke(finish);
          return;
        }
        const result = promiseInvoke();
        if (result && typeof result.then === "function") result.then(finish, fail);
        else finish(result);
      } catch (error) {
        fail(error);
      }

    });
  }

  function parseIpv4(host) {
    const match = String(host || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return null;
    return parts;
  }

  function ipv4PrivateReason(parts) {
    if (!parts) return "";
    const [a, b] = parts;
    if (a === 0) return "ipv4-unspecified";
    if (a === 10) return "ipv4-private";
    if (a === 100 && b >= 64 && b <= 127) return "ipv4-shared";
    if (a === 127) return "ipv4-loopback";
    if (a === 169 && b === 254) return "ipv4-link-local";
    if (a === 172 && b >= 16 && b <= 31) return "ipv4-private";
    if (a === 192 && b === 168) return "ipv4-private";
    if (a === 192 && (b === 0 || b === 2 || b === 88)) return "ipv4-special";
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return "ipv4-special";
    if (a === 203 && b === 0 && parts[2] === 113) return "ipv4-documentation";
    if (a >= 224) return "ipv4-non-unicast";
    return "";
  }

  function normalizeHost(hostname) {
    return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  }

  function ipv6PrivateReason(host) {
    const clean = normalizeHost(host).split("%")[0];
    if (!clean.includes(":")) return "";
    if (clean === "::" || clean === "0:0:0:0:0:0:0:0") return "ipv6-unspecified";
    if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return "ipv6-loopback";
    const mapped = clean.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return ipv4PrivateReason(parseIpv4(mapped[1])) || "";
    const mappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return ipv4PrivateReason([high >> 8, high & 255, low >> 8, low & 255]) || "";
    }
    const first = clean.split(":").find(Boolean) || "0";
    const firstValue = Number.parseInt(first, 16);
    if (!Number.isFinite(firstValue)) return "ipv6-invalid";
    if ((firstValue & 0xfe00) === 0xfc00) return "ipv6-ula";
    if ((firstValue & 0xffc0) === 0xfe80) return "ipv6-link-local";
    if ((firstValue & 0xffc0) === 0xfec0) return "ipv6-site-local";
    if ((firstValue & 0xff00) === 0xff00) return "ipv6-multicast";
    if (clean.startsWith("2001:db8:")) return "ipv6-documentation";
    return "";
  }

  function privateHostReason(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return "missing-host";
    if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
    if (/\.(?:local|internal|lan|home)$/.test(host)) return "local-name";
    return ipv4PrivateReason(parseIpv4(host)) || ipv6PrivateReason(host);
  }

  function validatePrivilegedFetchUrl(url) {
    if (typeof url !== "string" || url.length === 0) return { ok: false, reason: "missing-url" };
    if (url.length > LIMITS.maxUrlLength) return { ok: false, reason: "url-too-large" };
    const parsed = parseUrl(url);
    if (!parsed) return { ok: false, reason: "invalid-url" };
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "unsupported-scheme" };
    if (parsed.username || parsed.password) return { ok: false, reason: "url-credentials" };
    const privateReason = privateHostReason(parsed.hostname);
    if (privateReason) return { ok: false, reason: privateReason };
    return { ok: true, url: parsed.href };
  }

  function createDiagnostics(tabId, captureUntil = 0, now = Date.now()) {
    return {
      tabId,
      startedAt: now,
      captureUntil,
      contentInjectionOk: false,
      contentFrames: 0,
      mainWorldHookOk: false,
      mainWorldHookFrames: 0,
      scanMessageOk: false,
      hostPermissionGranted: null,
      networkSeen: 0,
      networkRecorded: 0,
      networkDiscarded: 0,
      headerHintsSeen: 0,
      headerHintsRecorded: 0,
      headerHintsDiscarded: 0,
      pageCandidatesSeen: 0,
      pageCandidatesRecorded: 0,
      pageCandidatesDiscarded: 0,
      sniffAttempts: 0,
      sniffRecorded: 0,
      sniffFailed: 0,
      abortedFetches: 0,
      cleanupRuns: 0,
      lastNetworkUrl: "",
      lastPageUrl: "",
      warning: "",
      limits: {
        batchDrops: 0,
        payloadDrops: 0,
        pageRateDrops: 0,
        pageTotalDrops: 0,
        urlPolicyDrops: 0,
        unobservedSniffDrops: 0,
        sniffTotalDrops: 0,
        playlistTotalDrops: 0,
        fetchQueueDrops: 0,
        bodyLimitDrops: 0
      }
    };
  }

  function createBudget(now) {
    return {
      networkEventsTotal: 0,
      pageTotal: 0,
      sniffTotal: 0,
      playlistTotal: 0,
      rateWindowStartedAt: now,
      rateWindowCount: 0
    };
  }

  function createBackgroundCore(options) {
    const api = options.api;
    const utils = options.utils;
    const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    const apiMode = options.apiMode === "callback" ? "callback" : "promise";
    const mediaByTab = new Map();
    const captureUntilByTab = new Map();
    const diagnosticsByTab = new Map();
    const analyzedPlaylists = new Set();
    const budgetsByTab = new Map();
    const observationsByTab = new Map();
    const captureGenerationByTab = new Map();
    const sniffedRequestIds = new Map();
    const requestPhases = new Map();
    const pendingFetches = [];
    const controllersByTab = new Map();
    const activeFetchCountByTab = new Map();
    let activeFetchCount = 0;
    let hydrated = false;
    let hydratePromise = null;
    let installed = false;
    let persistScheduled = false;
    let generationCounter = 0;

    if (!api) throw new Error("WebExtension API is required");
    if (!utils) throw new Error("OpenVideoCatcherUtils is required");

    function isExtensionPageSender(sender) {
      if (!sender) return false;
      if (api.runtime?.id && sender.id !== api.runtime.id) return false;
      const popupUrl = api.runtime?.getURL?.("popup/popup.html") || "";
      if (!sender.url || !popupUrl) return false;
      try {
        const senderUrl = new URL(sender.url);
        const expectedUrl = new URL(popupUrl);
        return senderUrl.protocol === expectedUrl.protocol
          && senderUrl.host === expectedUrl.host
          && senderUrl.pathname === expectedUrl.pathname
          && (!Number.isInteger(sender.frameId) || sender.frameId === 0);
      } catch (_error) {
        return false;
      }
    }

    function tabStore(tabId) {
      if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, new Map());
      return mediaByTab.get(tabId);
    }

    function tabDiagnostics(tabId) {
      if (!diagnosticsByTab.has(tabId)) diagnosticsByTab.set(tabId, createDiagnostics(tabId, captureUntilByTab.get(tabId) || 0, now()));
      const diag = diagnosticsByTab.get(tabId);
      diag.limits = Object.assign(createDiagnostics(tabId).limits, diag.limits || {});
      return diag;
    }

    function tabBudget(tabId) {
      if (!budgetsByTab.has(tabId)) budgetsByTab.set(tabId, createBudget(now()));
      return budgetsByTab.get(tabId);
    }

    function sortedItems(tabId) {
      const store = mediaByTab.get(tabId);
      if (!store) return [];
      return Array.from(store.values()).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    }

    function trimStore(store) {
      if (store.size <= LIMITS.maxItemsPerTab) return;
      const items = Array.from(store.values()).sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      for (const item of items.slice(0, store.size - LIMITS.maxItemsPerTab)) store.delete(item.id);
    }

    function setBadge(tabId) {
      const count = mediaByTab.get(tabId)?.size || 0;
      const text = count > 0 ? String(Math.min(count, 99)) : "";
      ignorePromise(api.action?.setBadgeBackgroundColor?.({ tabId, color: "#2563eb" }));
      ignorePromise(api.action?.setBadgeText?.({ tabId, text }));
    }

    function notifyPopup(tabId) {
      try {
        ignorePromise(api.runtime?.sendMessage?.({ type: "OVC_TAB_MEDIA_UPDATED", tabId }));
      } catch (_error) {
        // Popup may be closed.
      }
    }

    function storageSession() {
      return api.storage?.session || null;
    }

    async function storageGet(key) {
      const session = storageSession();
      if (!session?.get) return {};
      try {
        return await extensionApiCall(api, apiMode, () => session.get(key), (done) => session.get(key, done));
      } catch (_error) {
        return {};
      }
    }

    async function storageSet(value) {
      const session = storageSession();
      if (!session?.set) return false;
      try {
        await extensionApiCall(api, apiMode, () => session.set(value), (done) => session.set(value, done));
        return true;
      } catch (_error) {
        return false;
      }
    }

    function serializeState() {
      const state = { version: 1, savedAt: now(), tabs: {} };
      let usedBytes = byteLength(JSON.stringify(state));
      for (const [tabId, captureUntil] of captureUntilByTab.entries()) {
        if (!captureUntil || captureUntil <= now()) continue;
        const key = String(tabId);
        const tabState = {
          captureUntil,
          captureGeneration: captureGeneration(tabId),
          items: [],
          diagnostics: diagnosticsByTab.get(tabId) || null,
          budget: budgetsByTab.get(tabId) || null
        };
        const baseCost = byteLength(JSON.stringify({ [key]: tabState })) + 1;
        if (usedBytes + baseCost > LIMITS.maxSessionBytes) continue;
        state.tabs[key] = tabState;
        usedBytes += baseCost;
        for (const item of sortedItems(tabId).slice(0, LIMITS.maxItemsPerTab)) {
          const itemCost = byteLength(JSON.stringify(item)) + 1;
          if (usedBytes + itemCost > LIMITS.maxSessionBytes) continue;
          tabState.items.push(item);
          usedBytes += itemCost;
        }
      }
      while (byteLength(JSON.stringify(state)) > LIMITS.maxSessionBytes) {
        const tab = Object.values(state.tabs).reverse().find((candidate) => candidate.items.length);
        if (!tab) break;
        tab.items.pop();
      }
      return state;
    }

    async function persistNow() {
      persistScheduled = false;
      const persisted = await storageSet({ [SESSION_KEY]: serializeState() });
      if (!persisted) await storageSet({ [SESSION_KEY]: { version: 1, savedAt: now(), tabs: {} } });
    }

    function schedulePersist() {
      if (persistScheduled) return;
      persistScheduled = true;
      Promise.resolve().then(persistNow);
    }

    async function hydrate() {
      if (hydrated) return;
      if (hydratePromise) return hydratePromise;
      hydratePromise = (async () => {
        const stored = await storageGet(SESSION_KEY);
        const state = stored?.[SESSION_KEY];
        const tabs = state?.tabs || {};
        let discardedExpiredState = false;
        for (const [rawTabId, tabState] of Object.entries(tabs)) {
          const tabId = Number(rawTabId);
          if (!Number.isInteger(tabId) || tabId < 0 || !tabState) continue;
          const captureUntil = Number(tabState.captureUntil || 0);
          if (!captureUntil || captureUntil <= now()) {
            discardedExpiredState = true;
            continue;
          }
          const store = new Map();
          for (const item of Array.isArray(tabState.items) ? tabState.items.slice(0, LIMITS.maxItemsPerTab) : []) {
            if (item?.id && item?.url) store.set(item.id, item);
          }
          if (store.size) mediaByTab.set(tabId, store);
          captureUntilByTab.set(tabId, captureUntil);
          captureGenerationByTab.set(tabId, String(tabState.captureGeneration || `restored-${++generationCounter}`));
          if (tabState.diagnostics) diagnosticsByTab.set(tabId, tabState.diagnostics);
          if (tabState.budget) budgetsByTab.set(tabId, tabState.budget);
          setBadge(tabId);
        }
        hydrated = true;
        if (discardedExpiredState) schedulePersist();
      })();
      try {
        await hydratePromise;
      } finally {
        hydratePromise = null;
      }
    }

    function isCaptureActiveSync(tabId) {
      const until = captureUntilByTab.get(tabId) || 0;
      return Boolean(Number.isInteger(tabId) && tabId >= 0 && until && now() <= until);
    }

    function captureGeneration(tabId) {
      return captureGenerationByTab.get(tabId) || "";
    }

    function generationMatches(tabId, generation) {
      return Boolean(generation && captureGeneration(tabId) === generation && isCaptureActiveSync(tabId));
    }

    function itemObservationFresh(tabId, item) {
      return Boolean(item && generationMatches(tabId, item.captureGeneration)
        && Number(item.observedAt || 0) > 0
        && now() - Number(item.observedAt) <= LIMITS.observationTtlMs);
    }

    async function isCaptureActive(tabId) {
      await hydrate();
      if (isCaptureActiveSync(tabId)) return true;
      if ((captureUntilByTab.get(tabId) || 0) > 0) expireCapture(tabId);
      return false;
    }

    function shouldAnalyze(item) {
      return item && (item.kind === "hls-playlist" || item.kind === "dash-manifest") && !item.parentPlaylistUrl;
    }

    function recordItem(tabId, item, options = {}) {
      if (!Number.isInteger(tabId) || tabId < 0 || !item?.id) return false;
      const store = tabStore(tabId);
      for (const [key, existingItem] of store) {
        if (key !== item.id && existingItem.url === item.url) store.delete(key);
      }
      const existing = store.get(item.id);
      const merged = utils.mergeMediaItems(existing, item, { enrichment: Boolean(options.enrichment) });
      if (options.trustedObservation) {
        const observation = options.observation || observedHint(tabId, item.url);
        merged.lowConfidence = false;
        merged.downloadable = Boolean(item.downloadable);
        merged.observedAt = Number(observation?.seenAt || now());
        merged.captureGeneration = String(observation?.captureGeneration || captureGeneration(tabId));
      } else if (item.lowConfidence || existing?.lowConfidence) {
        merged.lowConfidence = true;
        merged.downloadable = false;
      }
      store.set(item.id, merged);
      trimStore(store);
      setBadge(tabId);
      schedulePersist();
      if (!options.silent) notifyPopup(tabId);
      return true;
    }

    function clearAnalyzedForTab(tabId) {
      for (const key of Array.from(analyzedPlaylists)) {
        if (key.startsWith(`${tabId}|`)) analyzedPlaylists.delete(key);
      }
    }

    function pruneObservations(tabId) {
      const entries = observationsByTab.get(tabId);
      if (!entries) return;
      const cutoff = now() - LIMITS.observationTtlMs;
      for (const [url, hint] of entries) {
        if ((hint.seenAt || 0) < cutoff) entries.delete(url);
      }
      if (entries.size > LIMITS.maxObservedPerTab) {
        const oldest = Array.from(entries.entries()).sort((a, b) => (a[1].seenAt || 0) - (b[1].seenAt || 0));
        for (const [url] of oldest.slice(0, entries.size - LIMITS.maxObservedPerTab)) entries.delete(url);
      }
    }

    function isObserved(tabId, url) {
      pruneObservations(tabId);
      return Boolean(observationsByTab.get(tabId)?.has(url));
    }

    function observedHint(tabId, url) {
      pruneObservations(tabId);
      return observationsByTab.get(tabId)?.get(url) || null;
    }

    function rememberObservation(details, extra = {}) {
      if (!details || details.tabId < 0 || !details.url || !isCaptureActiveSync(details.tabId)) return false;
      const policy = validatePrivilegedFetchUrl(details.url);
      const diag = tabDiagnostics(details.tabId);
      if (!policy.ok) {
        diag.headerHintsDiscarded += 1;
        diag.limits.urlPolicyDrops += 1;
        return false;
      }
      const hint = {
        url: policy.url,
        mimeType: extra.mimeType || "",
        size: Number(extra.size || 0) || 0,
        contentDisposition: extra.contentDisposition || "",
        contentRange: extra.contentRange || "",
        acceptRanges: extra.acceptRanges || "",
        statusCode: Number(extra.statusCode || details.statusCode || 0) || 0,
        requestType: details.type || "",
        seenAt: now(),
        captureGeneration: captureGeneration(details.tabId)
      };
      if (!observationsByTab.has(details.tabId)) observationsByTab.set(details.tabId, new Map());
      observationsByTab.get(details.tabId).set(policy.url, hint);
      pruneObservations(details.tabId);
      diag.headerHintsRecorded += 1;
      schedulePersist();
      return true;
    }

    function enhancedShouldSniff(tabId, candidate) {
      if (!candidate?.url) return false;
      const parsed = parseUrl(candidate.url);
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false;
      if (utils.shouldSniffMediaUrl(candidate.url, {
        requestType: candidate.requestType || "",
        mimeType: candidate.mimeType || candidate.contentType || ""
      })) return true;
      const ext = utils.extensionFromUrl(candidate.url);
      if (utils.DIRECT_MEDIA_EXTENSIONS?.has(ext) || utils.PLAYLIST_EXTENSIONS?.has(ext) || utils.SEGMENT_EXTENSIONS?.has(ext)) return false;
      const requestType = String(candidate.requestType || "").toLowerCase();
      if (!FETCH_LIKE_TYPES.has(requestType)) return false;
      const mime = normalizeMime(candidate.mimeType || candidate.contentType || "");
      if (mime && !GENERIC_MIME.test(mime)) return false;
      const hint = observedHint(tabId, candidate.url) || {};
      const hintedMime = normalizeMime(hint.mimeType || "");
      if (hintedMime && !GENERIC_MIME.test(hintedMime)) return false;
      const size = Number(candidate.size || hint.size || 0) || 0;
      const statusCode = Number(candidate.statusCode || hint.statusCode || 0) || 0;
      const contentRange = String(candidate.contentRange || hint.contentRange || "");
      const acceptRanges = String(candidate.acceptRanges || hint.acceptRanges || "");
      const rangeSignal = statusCode === 206 || /^bytes/i.test(contentRange) || /\bbytes\b/i.test(acceptRanges);
      const urlSignal = MEDIA_HINT_PATTERN.test(`${parsed.pathname}${parsed.search}`.toLowerCase());
      return rangeSignal || urlSignal || size >= 256 * 1024;
    }

    function normalizeRawCandidate(rawItem, defaultSource) {
      if (!rawItem || typeof rawItem !== "object") return null;
      const url = typeof rawItem.url === "string" && rawItem.url.length <= LIMITS.maxUrlLength ? rawItem.url : "";
      const parsed = parseUrl(url);
      if (!parsed || !["http:", "https:", "blob:"].includes(parsed.protocol)) return null;
      const pageUrl = typeof rawItem.pageUrl === "string" && rawItem.pageUrl.length <= LIMITS.maxUrlLength ? rawItem.pageUrl : "";
      const source = String(rawItem.source || defaultSource || "unknown").slice(0, 64);
      return {
        url: parsed.href,
        pageUrl,
        pageTitle: String(rawItem.pageTitle || "").slice(0, LIMITS.maxLabelLength),
        label: String(rawItem.label || "").slice(0, LIMITS.maxLabelLength),
        source,
        requestType: String(rawItem.requestType || "").slice(0, 64),
        mimeType: String(rawItem.mimeType || rawItem.contentType || "").slice(0, 256),
        contentDisposition: String(rawItem.contentDisposition || "").slice(0, 512),
        size: Number(rawItem.size || 0) || 0,
        fromDom: rawItem.fromDom !== false,
        lowConfidence: Boolean(rawItem.lowConfidence || rawItem.untrustedPageHint || source.includes("page-hook")),
        sniff: Boolean(rawItem.sniff || rawItem.candidateHint || rawItem.force)
      };
    }

    function consumePageBudget(tabId, diag) {
      const budget = tabBudget(tabId);
      const current = now();
      if (current - (budget.rateWindowStartedAt || 0) >= 1000) {
        budget.rateWindowStartedAt = current;
        budget.rateWindowCount = 0;
      }
      if (budget.pageTotal >= LIMITS.maxPageCandidatesTotal) {
        diag.pageCandidatesDiscarded += 1;
        diag.limits.pageTotalDrops += 1;
        return false;
      }
      if (budget.rateWindowCount >= LIMITS.maxPageCandidatesPerSecond) {
        diag.pageCandidatesDiscarded += 1;
        diag.limits.pageRateDrops += 1;
        return false;
      }
      budget.pageTotal += 1;
      budget.rateWindowCount += 1;
      return true;
    }

    function canAttemptSniff(tabId, diag) {
      const budget = tabBudget(tabId);
      if (budget.sniffTotal >= LIMITS.maxSniffAttemptsPerTab) {
        diag.limits.sniffTotalDrops += 1;
        return false;
      }
      budget.sniffTotal += 1;
      return true;
    }

    function controllerSet(tabId) {
      if (!controllersByTab.has(tabId)) controllersByTab.set(tabId, new Set());
      return controllersByTab.get(tabId);
    }

    function processFetchQueue() {
      for (;;) {
        if (activeFetchCount >= LIMITS.maxGlobalFetches) return;
        const index = pendingFetches.findIndex((task) => (activeFetchCountByTab.get(task.tabId) || 0) < LIMITS.maxFetchesPerTab);
        if (index < 0) return;
        const [task] = pendingFetches.splice(index, 1);
        activeFetchCount += 1;
        activeFetchCountByTab.set(task.tabId, (activeFetchCountByTab.get(task.tabId) || 0) + 1);
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        if (controller) controllerSet(task.tabId).add(controller);
        Promise.resolve()
          .then(() => task.run(controller))
          .then(task.resolve, task.reject)
          .finally(() => {
            if (controller) controllerSet(task.tabId).delete(controller);
            activeFetchCount -= 1;
            activeFetchCountByTab.set(task.tabId, Math.max(0, (activeFetchCountByTab.get(task.tabId) || 1) - 1));
            processFetchQueue();
          });
      }
    }

    function enqueueFetch(tabId, generation, run) {
      if (pendingFetches.length >= LIMITS.maxQueuedFetches) {
        tabDiagnostics(tabId).limits.fetchQueueDrops += 1;
        return Promise.reject(new Error("fetch queue limit exceeded"));
      }
      return new Promise((resolve, reject) => {
        pendingFetches.push({ tabId, generation, run, resolve, reject });
        processFetchQueue();
      });
    }

    function abortTabWork(tabId) {
      const diag = tabDiagnostics(tabId);
      for (let index = pendingFetches.length - 1; index >= 0; index -= 1) {
        if (pendingFetches[index].tabId === tabId) {
          pendingFetches[index].reject(new Error("capture stopped"));
          pendingFetches.splice(index, 1);
          diag.abortedFetches += 1;
        }
      }
      for (const controller of controllersByTab.get(tabId) || []) {
        try {
          controller.abort();
          diag.abortedFetches += 1;
        } catch (_error) {}
      }
      controllersByTab.delete(tabId);
    }

    async function fetchWithPolicy(tabId, url, fetchOptions, bodyReader, generation = captureGeneration(tabId)) {
      if (!fetchImpl) throw new Error("fetch API is unavailable");
      const policy = validatePrivilegedFetchUrl(url);
      if (!policy.ok) {
        const diag = tabDiagnostics(tabId);
        diag.limits.urlPolicyDrops += 1;
        throw new Error(`URL policy denied: ${policy.reason}`);
      }
      return enqueueFetch(tabId, generation, async (controller) => {
        if (!generationMatches(tabId, generation)) throw new Error("capture generation changed");
        const timer = controller ? setTimeoutFn(() => controller.abort(), LIMITS.fetchTimeoutMs) : null;
        try {
          const response = await fetchImpl(policy.url, Object.assign({}, fetchOptions || {}, {
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller ? controller.signal : undefined
          }));
          if (!response.ok && response.status !== 206) {
            if (response.status === 401 || response.status === 403) {
              const authError = new Error("브라우저 로그인 정보가 전달되지 않아 인증된 미디어를 분석할 수 없습니다.");
              authError.code = "AUTH_REQUIRED";
              authError.status = response.status;
              throw authError;
            }
            const httpError = new Error(`HTTP ${response.status}`);
            httpError.code = "HTTP_ERROR";
            httpError.status = response.status;
            throw httpError;
          }
          const result = await bodyReader(response);
          if (!generationMatches(tabId, generation)) throw new Error("capture generation changed");
          return result;
        } finally {
          if (timer) clearTimeoutFn(timer);
        }
      });
    }

    async function readResponsePrefix(response) {
      const contentType = response.headers?.get?.("content-type") || "";
      const contentDisposition = response.headers?.get?.("content-disposition") || "";
      const contentLength = Number(response.headers?.get?.("content-length") || 0) || 0;
      let bytes = new Uint8Array();
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (total < LIMITS.maxSniffBytes) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          const slice = value.slice(0, Math.max(0, LIMITS.maxSniffBytes - total));
          chunks.push(slice);
          total += slice.length;
          if (value.length > slice.length) break;
        }
        try { await reader.cancel(); } catch (_error) {}
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      } else {
        const buffer = await response.arrayBuffer();
        bytes = new Uint8Array(buffer).slice(0, LIMITS.maxSniffBytes);
      }
      let sniffedText = "";
      try { sniffedText = new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch (_error) {}
      return { mimeType: contentType, contentDisposition, size: contentLength, sniffedBytes: bytes, sniffedText };
    }

    async function fetchSniff(tabId, url, generation) {
      return fetchWithPolicy(tabId, url, { headers: { Range: "bytes=0-16383" } }, readResponsePrefix, generation);
    }

    async function readTextCapped(response, tabId) {
      const length = Number(response.headers?.get?.("content-length") || 0) || 0;
      if (length > LIMITS.maxPlaylistBytes) {
        tabDiagnostics(tabId).limits.bodyLimitDrops += 1;
        throw new Error("playlist body limit exceeded");
      }
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: false });
        let total = 0;
        let text = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.length;
          if (total > LIMITS.maxPlaylistBytes) {
            try { await reader.cancel(); } catch (_error) {}
            tabDiagnostics(tabId).limits.bodyLimitDrops += 1;
            throw new Error("playlist body limit exceeded");
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
      }
      const text = await response.text();
      if (byteLength(text) > LIMITS.maxPlaylistBytes) {
        tabDiagnostics(tabId).limits.bodyLimitDrops += 1;
        throw new Error("playlist body limit exceeded");
      }
      return text;
    }

    async function fetchText(tabId, url, generation) {
      return fetchWithPolicy(tabId, url, {}, (response) => readTextCapped(response, tabId), generation);
    }

    async function sniffAndRecordCandidate(tabId, candidate, diag, counterName, options = {}) {
      if (!Number.isInteger(tabId) || tabId < 0 || !candidate?.url || !(await isCaptureActive(tabId))) return false;
      const generation = captureGeneration(tabId);
      const policy = validatePrivilegedFetchUrl(candidate.url);
      if (!policy.ok) {
        diag.limits.urlPolicyDrops += 1;
        return false;
      }
      if (!options.observed && !isObserved(tabId, policy.url)) {
        diag.limits.unobservedSniffDrops += 1;
        return false;
      }
      if (!enhancedShouldSniff(tabId, Object.assign({}, candidate, { url: policy.url }))) return false;
      if (options.requestKey) {
        if (sniffedRequestIds.has(options.requestKey)) return false;
        sniffedRequestIds.set(options.requestKey, now());
        while (sniffedRequestIds.size > 1000) sniffedRequestIds.delete(sniffedRequestIds.keys().next().value);
      }
      if (!canAttemptSniff(tabId, diag)) return false;
      diag.sniffAttempts += 1;
      try {
        const sniffed = await fetchSniff(tabId, policy.url, generation);
        if (!generationMatches(tabId, generation)) return false;
        const item = utils.createMediaItem({
          url: policy.url,
          pageUrl: candidate.pageUrl,
          pageTitle: candidate.pageTitle,
          label: candidate.label,
          source: `${candidate.source || "candidate"}-sniff`,
          requestType: candidate.requestType || "",
          fromDom: Boolean(candidate.fromDom),
          mimeType: candidate.mimeType || sniffed.mimeType || "",
          contentDisposition: candidate.contentDisposition || sniffed.contentDisposition || "",
          size: candidate.size || sniffed.size || 0,
          sniffedBytes: sniffed.sniffedBytes,
          sniffedText: sniffed.sniffedText,
          now: now()
        });
        if (!item) {
          diag.sniffFailed += 1;
          return false;
        }
        const recorded = recordItem(tabId, item, { trustedObservation: true });
        if (recorded) {
          diag.sniffRecorded += 1;
          if (counterName && typeof diag[counterName] === "number") diag[counterName] += 1;
        }
        return recorded;
      } catch (_error) {
        diag.sniffFailed += 1;
        return false;
      } finally {
        schedulePersist();
      }
    }

    async function recordRawMedia(tabId, rawItem, defaultSource) {
      if (!(await isCaptureActive(tabId))) return false;
      const diag = tabDiagnostics(tabId);
      diag.pageCandidatesSeen += 1;
      const candidate = normalizeRawCandidate(rawItem, defaultSource);
      diag.lastPageUrl = utils.redactUrl(candidate?.url || rawItem?.url || "");
      if (!candidate || !consumePageBudget(tabId, diag)) {
        diag.pageCandidatesDiscarded += candidate ? 0 : 1;
        schedulePersist();
        return false;
      }
      const networkHint = observedHint(tabId, candidate.url);
      const item = utils.createMediaItem({
        url: candidate.url,
        pageUrl: candidate.pageUrl,
        pageTitle: candidate.pageTitle,
        label: candidate.label,
        source: candidate.source,
        requestType: candidate.requestType,
        fromDom: true,
        mimeType: networkHint?.mimeType || "",
        contentDisposition: networkHint?.contentDisposition || "",
        size: networkHint?.size || candidate.size,
        now: now()
      });
      if (item) {
        const trustedObservation = Boolean(networkHint);
        if (!trustedObservation) {
          item.lowConfidence = true;
          item.downloadable = false;
        }
        const recorded = recordItem(tabId, item, { skipAnalyze: !trustedObservation, trustedObservation });
        if (recorded) diag.pageCandidatesRecorded += 1;
        schedulePersist();
        return recorded;
      }
      diag.pageCandidatesDiscarded += 1;
      if (candidate.sniff || enhancedShouldSniff(tabId, candidate)) {
        await sniffAndRecordCandidate(tabId, candidate, diag, "pageCandidatesRecorded", { observed: false });
      }
      schedulePersist();
      return false;
    }

    async function processContentBatch(tabId, message) {
      await hydrate();
      const diag = tabDiagnostics(tabId);
      if (!(await isCaptureActive(tabId))) return { ok: true, recorded: 0, dropped: 0 };
      const items = Array.isArray(message.items) ? message.items : [];
      const payloadText = JSON.stringify(items);
      if (byteLength(payloadText) > LIMITS.maxBatchPayloadBytes) {
        diag.limits.payloadDrops += items.length || 1;
        schedulePersist();
        return { ok: false, recorded: 0, dropped: items.length, error: "payload-too-large" };
      }
      let recorded = 0;
      let dropped = Math.max(0, items.length - LIMITS.maxBatchItems);
      if (dropped) diag.limits.batchDrops += dropped;
      for (const rawItem of items.slice(0, LIMITS.maxBatchItems)) {
        if (await recordRawMedia(tabId, rawItem, "dom")) recorded += 1;
      }
      return { ok: true, recorded, dropped };
    }

    function contentTypeExtra(details) {
      const headers = details.responseHeaders || [];
      return {
        mimeType: headerValue(headers, "content-type"),
        size: Number(headerValue(headers, "content-length") || 0) || 0,
        contentDisposition: headerValue(headers, "content-disposition"),
        contentRange: headerValue(headers, "content-range"),
        acceptRanges: headerValue(headers, "accept-ranges"),
        statusCode: details.statusCode || 0
      };
    }

    async function recordFromRequest(details, extra, options = {}) {
      await hydrate();
      if (!details || details.tabId < 0 || !details.url || !(await isCaptureActive(details.tabId))) return;
      const diag = tabDiagnostics(details.tabId);
      const budget = tabBudget(details.tabId);
      const requestKey = details.requestId ? `${details.tabId}|${details.requestId}` : "";
      const phase = extra ? "headers" : "before";
      const previousPhases = requestKey ? requestPhases.get(requestKey) : null;
      if (previousPhases?.has("dropped")) return;
      if (previousPhases?.has(phase)) return;
      if (requestKey) {
        const phases = previousPhases || new Set();
        phases.add(phase);
        requestPhases.set(requestKey, phases);
        while (requestPhases.size > 2000) requestPhases.delete(requestPhases.keys().next().value);
      }
      budget.networkEventsTotal = Math.max(0, Number(budget.networkEventsTotal || 0));
      if (!previousPhases && budget.networkEventsTotal >= LIMITS.maxNetworkEventsPerTab) {
        if (requestKey) requestPhases.get(requestKey)?.add("dropped");
        diag.limits.networkEventDrops = Number(diag.limits.networkEventDrops || 0) + 1;
        return;
      }
      if (!previousPhases) {
        budget.networkEventsTotal += 1;
        diag.networkSeen += 1;
      }
      diag.lastNetworkUrl = utils.redactUrl(details.url);
      const requestExtra = extra || {};
      rememberObservation(details, requestExtra);
      const item = utils.createMediaItem({
        url: details.url,
        source: "network",
        requestType: details.type,
        mimeType: requestExtra.mimeType || "",
        contentDisposition: requestExtra.contentDisposition || "",
        size: requestExtra.size || 0,
        now: now()
      });
      if (item) {
        if (item.downloadable && !validatePrivilegedFetchUrl(item.url).ok) item.downloadable = false;
        if (recordItem(details.tabId, item, { trustedObservation: true, enrichment: Boolean(previousPhases) })) diag.networkRecorded += 1;
      } else {
        diag.networkDiscarded += 1;
        if (options.allowSniff === false) {
          schedulePersist();
          return;
        }
        await sniffAndRecordCandidate(details.tabId, {
          url: details.url,
          source: "network",
          requestType: details.type,
          mimeType: requestExtra.mimeType || "",
          contentDisposition: requestExtra.contentDisposition || "",
          size: requestExtra.size || 0,
          statusCode: requestExtra.statusCode || details.statusCode || 0,
          contentRange: requestExtra.contentRange || "",
          acceptRanges: requestExtra.acceptRanges || ""
        }, diag, "networkRecorded", { observed: true, requestKey: details.requestId ? `${details.tabId}|${details.requestId}` : "" });
      }
      schedulePersist();
    }

    async function executeScript(details) {
      return extensionApiCall(api, apiMode, () => api.scripting.executeScript(details), (done) => api.scripting.executeScript(details, done));
    }

    function resultCount(results) {
      return Array.isArray(results) ? results.length : 0;
    }

    async function ensureContentScripts(tabId) {
      if (!api.scripting?.executeScript) throw new Error("scripting API를 사용할 수 없습니다.");
      const sharedResults = await executeScript({ target: { tabId, allFrames: true }, files: ["src/media-utils.js"] });
      const contentCoreResults = await executeScript({ target: { tabId, allFrames: true }, files: ["content/content-core.js"] });
      const contentResults = await executeScript({ target: { tabId, allFrames: true }, files: ["content/content-script.js"] });
      return resultCount(sharedResults) + resultCount(contentCoreResults) + resultCount(contentResults);
    }

    async function injectPageHookMainWorld(tabId) {
      const results = await executeScript({ target: { tabId, allFrames: true }, files: ["page/page-hook.js"], world: "MAIN" });
      return resultCount(results);
    }

    async function sendTabMessage(tabId, message) {
      return extensionApiCall(api, apiMode, () => api.tabs.sendMessage(tabId, message), (done) => api.tabs.sendMessage(tabId, message, done));
    }

    async function hasAllUrlsPermission() {
      if (!api.permissions?.contains) return null;
      try {
        return await extensionApiCall(api, apiMode, () => api.permissions.contains({ origins: ["<all_urls>"] }), (done) => api.permissions.contains({ origins: ["<all_urls>"] }, done));
      } catch (_error) {
        return null;
      }
    }

    function startCaptureWindow(tabId, durationMs = DEFAULT_CAPTURE_DURATION_MS) {
      const captureUntil = now() + durationMs;
      captureGenerationByTab.set(tabId, `${now()}-${++generationCounter}`);
      captureUntilByTab.set(tabId, captureUntil);
      diagnosticsByTab.set(tabId, createDiagnostics(tabId, captureUntil, now()));
      budgetsByTab.set(tabId, createBudget(now()));
      scheduleCleanupAlarm(tabId, captureUntil);
      schedulePersist();
      return captureUntil;
    }

    async function startDetection(tabId) {
      await hydrate();
      if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: "활성 탭을 찾을 수 없습니다." };
      clearTabState(tabId, { stopContent: false, clearItems: true });
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
        await sendTabMessage(tabId, { type: "OVC_SCAN_NOW", durationMs: DEFAULT_CAPTURE_DURATION_MS });
        diag.scanMessageOk = true;
      } catch (error) {
        const message = `스캔 메시지 실패: ${error.message || String(error)}`;
        diag.warning = diag.warning ? `${diag.warning}; ${message}` : message;
      }

      schedulePersist();
      return {
        ok: true,
        captureUntil,
        durationMs: DEFAULT_CAPTURE_DURATION_MS,
        injectionOk: diag.contentInjectionOk,
        scanOk: diag.scanMessageOk,
        warning: diag.warning,
        diagnostics: diag,
        items: sortedItems(tabId)
      };
    }

    function enrichExistingItem(tabId, itemId, patch) {
      const store = mediaByTab.get(tabId);
      if (!store) return null;
      const existing = store.get(itemId);
      if (!existing) return null;
      const enriched = utils.mergeMediaItems(existing, Object.assign({}, existing, patch, { lastSeen: now() }), { enrichment: true });
      store.set(itemId, enriched);
      setBadge(tabId);
      notifyPopup(tabId);
      schedulePersist();
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
          now: now()
        });
        if (item) recordItem(tabId, item, { skipAnalyze: true, silent: true });
      }
      setBadge(tabId);
      notifyPopup(tabId);
    }

    async function analyzePlaylist(tabId, item, options = {}) {
      await hydrate();
      if (!item || !item.url || !shouldAnalyze(item)) return { ok: false, error: "분석할 playlist/manifest 항목이 아닙니다." };
      if (!(await isCaptureActive(tabId))) return { ok: false, error: "감지 시간이 끝났습니다. 다시 감지를 시작하세요.", errorCode: "CAPTURE_INACTIVE" };
      if (!itemObservationFresh(tabId, item)) return { ok: false, error: "현재 감지 세션의 최신 네트워크 관찰이 없어 분석할 수 없습니다.", errorCode: "OBSERVATION_EXPIRED" };
      const generation = captureGeneration(tabId);
      const budget = tabBudget(tabId);
      budget.playlistTotal = Number.isFinite(Number(budget.playlistTotal)) ? Math.max(0, Number(budget.playlistTotal)) : 0;
      if (budget.playlistTotal >= LIMITS.maxPlaylistAnalysesPerTab) {
        tabDiagnostics(tabId).limits.playlistTotalDrops += 1;
        schedulePersist();
        return { ok: false, error: "이 감지 세션의 playlist 분석 한도를 초과했습니다.", errorCode: "ANALYSIS_LIMIT" };
      }
      budget.playlistTotal += 1;
      const key = `${tabId}|${item.id}`;
      if (!options.force && analyzedPlaylists.has(key)) return { ok: true, skipped: true };
      analyzedPlaylists.add(key);
      try {
        const text = await fetchText(tabId, item.url, generation);
        if (!generationMatches(tabId, generation)) return { ok: false, error: "감지 세션이 변경되었습니다.", errorCode: "CAPTURE_CHANGED" };
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
        const errorMessage = error?.code === "AUTH_REQUIRED"
          ? "브라우저 로그인 정보가 전달되지 않아 인증된 미디어를 분석할 수 없습니다."
          : (error.message || "playlist 분석에 실패했습니다.");
        enrichExistingItem(tabId, item.id, {
          analysis: {
            type: item.kind === "hls-playlist" ? "hls" : "dash",
            error: errorMessage,
            errorCode: error?.code || "ANALYSIS_FAILED"
          }
        });
        return {
          ok: false,
          error: errorMessage,
          errorCode: error?.code || "ANALYSIS_FAILED",
          status: Number.isInteger(error?.status) ? error.status : undefined
        };
      } finally {
        schedulePersist();
      }
    }

    function sendCaptureStop(tabId) {
      try {
        ignorePromise(api.tabs?.sendMessage?.(tabId, { type: "OVC_CAPTURE_STOP" }));
      } catch (_error) {}
    }

    function eraseDownloadHistoryWhenFinished(downloadId) {
      const changed = api.downloads?.onChanged;
      if (!Number.isInteger(downloadId) || !changed?.addListener || !api.downloads?.erase) return;
      const listener = (delta) => {
        if (delta?.id !== downloadId || !["complete", "interrupted"].includes(delta.state?.current)) return;
        try { changed.removeListener?.(listener); } catch (_error) {}
        extensionApiCall(
          api,
          apiMode,
          () => api.downloads.erase({ id: downloadId }),
          (done) => api.downloads.erase({ id: downloadId }, done)
        ).catch(() => {});
      };
      changed.addListener(listener);
    }

    function clearTabState(tabId, options = {}) {
      abortTabWork(tabId);
      if (options.clearItems !== false) mediaByTab.delete(tabId);
      captureUntilByTab.delete(tabId);
      captureGenerationByTab.delete(tabId);
      diagnosticsByTab.delete(tabId);
      budgetsByTab.delete(tabId);
      observationsByTab.delete(tabId);
      clearAnalyzedForTab(tabId);
      for (const key of sniffedRequestIds.keys()) if (key.startsWith(`${tabId}|`)) sniffedRequestIds.delete(key);
      for (const key of requestPhases.keys()) if (key.startsWith(`${tabId}|`)) requestPhases.delete(key);
      setBadge(tabId);
      if (options.stopContent !== false) sendCaptureStop(tabId);
      schedulePersist();
    }

    function expireCapture(tabId) {
      const diag = tabDiagnostics(tabId);
      diag.cleanupRuns += 1;
      captureUntilByTab.delete(tabId);
      captureGenerationByTab.delete(tabId);
      observationsByTab.delete(tabId);
      budgetsByTab.delete(tabId);
      abortTabWork(tabId);
      sendCaptureStop(tabId);
      schedulePersist();
    }

    async function cleanupExpired() {
      await hydrate();
      for (const [tabId, captureUntil] of Array.from(captureUntilByTab.entries())) {
        if (captureUntil && now() > captureUntil) expireCapture(tabId);
      }
    }

    function cleanupAlarmName(tabId) {
      return `${CLEANUP_ALARM_PREFIX}${tabId}`;
    }

    function scheduleCleanupAlarm(tabId, captureUntil) {
      if (!api.alarms?.create) return;
      try {
        api.alarms.create(cleanupAlarmName(tabId), { when: Math.max(now() + 1000, captureUntil + 250) });
      } catch (_error) {}
    }

    async function resumeTabCapture(tabId) {
      await hydrate();
      if (!(await isCaptureActive(tabId))) return;
      const durationMs = Math.max(1000, (captureUntilByTab.get(tabId) || 0) - now());
      try { await ensureContentScripts(tabId); } catch (_error) {}
      try { await injectPageHookMainWorld(tabId); } catch (_error) {}
      try { await sendTabMessage(tabId, { type: "OVC_SCAN_NOW", durationMs }); } catch (_error) {}
      notifyPopup(tabId);
    }

    function install() {
      if (installed) return;
      installed = true;
      if (api.webRequest?.onBeforeRequest?.addListener) {
        api.webRequest.onBeforeRequest.addListener((details) => {
          recordFromRequest(details).catch(() => {});
        }, { urls: ["<all_urls>"], types: WATCHED_TYPES });
      }
      if (api.webRequest?.onHeadersReceived?.addListener) {
        api.webRequest.onHeadersReceived.addListener((details) => {
          const extra = contentTypeExtra(details);
          const diag = Number.isInteger(details?.tabId) && details.tabId >= 0 && isCaptureActiveSync(details.tabId) ? tabDiagnostics(details.tabId) : null;
          if (diag) diag.headerHintsSeen += 1;
          recordFromRequest(details, extra).catch(() => {});
        }, { urls: ["<all_urls>"], types: WATCHED_TYPES }, ["responseHeaders"]);
      }
      if (api.runtime?.onMessage?.addListener) {
        api.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (!message || typeof message.type !== "string") return false;
          if (message.type === "OVC_MEDIA_FOUND_BATCH") {
            const tabId = sender?.tab?.id;
            processContentBatch(tabId, message).then(sendResponse);
            return true;
          }
          if (["OVC_GET_TAB_MEDIA", "OVC_START_DETECTION", "OVC_CLEAR_TAB", "OVC_ANALYZE_PLAYLIST", "OVC_DOWNLOAD"].includes(message.type) && !isExtensionPageSender(sender)) {
            sendResponse({ ok: false, error: "This command is available to an extension page only." });
            return false;
          }
          if (message.type === "OVC_GET_TAB_MEDIA") {
            const tabId = Number(message.tabId);
            hydrate().then(() => {
              sendResponse({
                ok: true,
                items: sortedItems(tabId),
                captureActive: isCaptureActiveSync(tabId),
                captureUntil: captureUntilByTab.get(tabId) || 0,
                diagnostics: tabDiagnostics(tabId)
              });
            });
            return true;
          }
          if (message.type === "OVC_START_DETECTION") {
            startDetection(Number(message.tabId)).then(sendResponse);
            return true;
          }
          if (message.type === "OVC_CLEAR_TAB") {
            hydrate().then(() => {
              clearTabState(Number(message.tabId));
              sendResponse({ ok: true });
            });
            return true;
          }
          if (message.type === "OVC_ANALYZE_PLAYLIST") {
            hydrate().then(() => {
              const tabId = Number(message.tabId);
              const item = sortedItems(tabId).find((candidate) => candidate.id === message.id);
              if (!item) {
                sendResponse({ ok: false, error: "미디어 항목을 찾을 수 없습니다." });
                return;
              }
              analyzePlaylist(tabId, item, { force: true }).then((result) => {
                sendResponse(Object.assign({}, result, { items: sortedItems(tabId) }));
              });
            });
            return true;
          }
          if (message.type === "OVC_DOWNLOAD") {
            hydrate().then(() => {
              const tabId = Number(message.tabId);
              const item = sortedItems(tabId).find((candidate) => candidate.id === message.id);
              if (!item) {
                sendResponse({ ok: false, error: "미디어 항목을 찾을 수 없습니다." });
                return;
              }
              if (!isCaptureActiveSync(tabId)) {
                sendResponse({ ok: false, error: "감지 시간이 끝났습니다. 다시 감지를 시작하세요.", errorCode: "CAPTURE_INACTIVE" });
                return;
              }
              if (item.lowConfidence) {
                sendResponse({ ok: false, error: "브라우저 네트워크에서 확인되지 않은 페이지 힌트는 다운로드할 수 없습니다.", errorCode: "UNTRUSTED_MEDIA" });
                return;
              }
              if (!itemObservationFresh(tabId, item)) {
                sendResponse({ ok: false, error: "현재 감지 세션의 최신 네트워크 관찰이 없어 다운로드할 수 없습니다.", errorCode: "OBSERVATION_EXPIRED" });
                return;
              }
              const downloadPolicy = validatePrivilegedFetchUrl(item.url);
              if (!downloadPolicy.ok) {
                sendResponse({ ok: false, error: "로컬·사설 네트워크 또는 허용되지 않은 URL은 다운로드할 수 없습니다.", errorCode: "URL_POLICY" });
                return;
              }
              if (!item.downloadable) {
                sendResponse({ ok: false, error: "이 항목은 브라우저 다운로드 API로 직접 저장할 수 없습니다.", errorCode: "NOT_DOWNLOADABLE" });
                return;
              }
              const downloadOptions = {
                url: item.url,
                filename: item.fileName,
                saveAs: true,
                conflictAction: "uniquify"
              };
              extensionApiCall(
                api,
                apiMode,
                () => api.downloads.download(downloadOptions),
                (done) => api.downloads.download(downloadOptions, done),
                120000
              ).then((downloadId) => {
                eraseDownloadHistoryWhenFinished(downloadId);
                sendResponse({ ok: true, downloadId });
              }, (error) => {
                sendResponse({ ok: false, error: error.message || String(error) });
              });
            });
            return true;
          }
          return false;
        });
      }
      api.tabs?.onRemoved?.addListener?.((tabId) => {
        hydrate().then(() => clearTabState(tabId, { stopContent: false })).catch(() => {});
      });
      api.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
        if (changeInfo?.status === "complete") resumeTabCapture(tabId).catch(() => {});
      });
      api.alarms?.onAlarm?.addListener?.((alarm) => {
        if (!alarm || alarm.name === CLEANUP_ALARM || String(alarm.name || "").startsWith(CLEANUP_ALARM_PREFIX)) cleanupExpired().catch(() => {});
      });
      if (api.alarms?.create) {
        try { api.alarms.create(CLEANUP_ALARM, { periodInMinutes: 1 }); } catch (_error) {}
      }
      hydrate().then(cleanupExpired).catch(() => {});
    }

    async function flushForTest() {
      await Promise.resolve();
      if (persistScheduled) await persistNow();
      await Promise.allSettled(pendingFetches.map((task) => new Promise((resolve) => {
        const originalResolve = task.resolve;
        const originalReject = task.reject;
        task.resolve = (value) => { originalResolve(value); resolve(); };
        task.reject = (error) => { originalReject(error); resolve(); };
      })));
    }

    return {
      install,
      hydrate,
      persistNow,
      flushForTest,
      startDetection,
      processContentBatch,
      recordFromRequest,
      cleanupExpired,
      sortedItems,
      tabDiagnostics,
      isCaptureActive,
      validatePrivilegedFetchUrl,
      limits: LIMITS
    };
  }

  function installBackground(options) {
    const core = createBackgroundCore(options || {});
    core.install();
    return core;
  }

  return {
    CLEANUP_ALARM,
    LIMITS,
    SESSION_KEY,
    createBackgroundCore,
    createDiagnostics,
    installBackground,
    privateHostReason,
    validatePrivilegedFetchUrl
  };
});
