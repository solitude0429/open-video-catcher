(() => {
  "use strict";

  const utils = window.OpenVideoCatcherUtils;
  const contentCore = window.OpenVideoCatcherContentCore;
  if (!utils || !contentCore || window.__openVideoCatcherInstalled) return;
  window.__openVideoCatcherInstalled = true;

  const CAPTURE_DEFAULT_MS = 90000;
  const PAGE_EVENT_NAME = "__OVC_MEDIA_CANDIDATE";
  const PAGE_STOP_EVENT = "__OVC_CAPTURE_STOP";
  const MEDIA_INITIATORS = new Set(["video", "audio", "source", "media", "fetch", "xmlhttprequest", "other"]);
  const MEDIA_LINK_EXTENSIONS = ["m3u8", "mpd", "mp4", "m4v", "webm", "mov", "avi", "mkv", "flv", "ogv", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"];
  const TARGET_SELECTOR = [
    "video",
    "audio",
    "source[src]",
    "a[download]",
    ...MEDIA_LINK_EXTENSIONS.map((ext) => `a[href*=".${ext}" i]`)
  ].join(",");
  const seen = new Map();
  const MAX_SEEN = 600;
  let scanTimer = 0;
  let stopTimer = 0;
  let captureUntil = 0;
  let observer = null;
  let performanceObserver = null;
  let pageEventWindow = 0;
  let pageEventsInWindow = 0;
  let pageEventsTotal = 0;

  function pruneSeen() {
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  }

  function isCaptureActive() {
    const active = Date.now() <= captureUntil;
    if (!active) stopCapture();
    return active;
  }

  function pageContext() {
    return {
      baseUrl: document.baseURI,
      pageUrl: location.href,
      pageTitle: String(document.title || "").slice(0, contentCore.LIMITS.maxTextLength)
    };
  }

  function consumePageEventBudget(detail) {
    if (typeof detail !== "string" || detail.length > contentCore.LIMITS.maxEventPayloadBytes || pageEventsTotal >= 400) return false;
    const second = Math.floor(Date.now() / 1000);
    if (second !== pageEventWindow) {
      pageEventWindow = second;
      pageEventsInWindow = 0;
    }
    if (pageEventsInWindow >= 20) return false;
    pageEventsInWindow += 1;
    pageEventsTotal += 1;
    return true;
  }

  function dispatchPageStop() {
    window.dispatchEvent(new CustomEvent(PAGE_STOP_EVENT, { detail: "" }));
  }

  function resolveUrl(rawUrl) {
    return contentCore.resolveUrl(rawUrl, document.baseURI);
  }

  function candidateFromUrl(rawUrl, label, mimeType, source, requestType, options) {
    const opts = options || {};
    const url = resolveUrl(rawUrl);
    if (!url) return null;
    const base = {
      url,
      label: String(label || "").slice(0, contentCore.LIMITS.maxTextLength),
      mimeType: String(mimeType || "").slice(0, contentCore.LIMITS.maxMimeLength),
      pageUrl: location.href,
      pageTitle: String(document.title || "").slice(0, contentCore.LIMITS.maxTextLength),
      source: source || "dom",
      requestType: requestType || "",
      lowConfidence: Boolean(opts.lowConfidence),
      untrustedPageHint: Boolean(opts.untrustedPageHint)
    };
    const item = utils.createMediaItem(Object.assign({}, base, { fromDom: true }));
    if (item) {
      return {
        url: item.url,
        displayUrl: item.displayUrl,
        label: item.label,
        mimeType: item.mimeType,
        pageUrl: location.href,
        pageTitle: String(document.title || "").slice(0, contentCore.LIMITS.maxTextLength),
        source: source || "dom",
        requestType: requestType || "",
        lowConfidence: Boolean(opts.lowConfidence),
        untrustedPageHint: Boolean(opts.untrustedPageHint)
      };
    }
    if (!opts.keepUnclassified && !utils.shouldSniffMediaUrl(url, { requestType, mimeType })) return null;
    return Object.assign({}, base, {
      displayUrl: utils.redactUrl(url),
      sniff: true,
      candidateHint: "unclassified"
    });
  }

  function collectFromMediaElement(element, out) {
    const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.id || element.tagName.toLowerCase();
    const mimeType = element.getAttribute("type") || "";
    for (const rawUrl of [element.currentSrc, element.src]) {
      const candidate = candidateFromUrl(rawUrl, label, mimeType, "dom-media", element.tagName.toLowerCase());
      if (candidate) out.push(candidate);
    }
    for (const source of element.querySelectorAll("source[src]")) {
      const candidate = candidateFromUrl(source.getAttribute("src"), source.getAttribute("label") || label, source.getAttribute("type") || "", "dom-source", "source");
      if (candidate) out.push(candidate);
    }
  }

  function collectElement(element, out) {
    if (!element || typeof element.matches !== "function") return;
    if (element.matches("video,audio")) collectFromMediaElement(element, out);
    if (element.matches("source[src]")) {
      const candidate = candidateFromUrl(element.getAttribute("src"), element.getAttribute("label") || "source", element.getAttribute("type") || "", "dom-source", "source");
      if (candidate) out.push(candidate);
    }
    if (element.matches("a[download],a[href]")) {
      const label = element.textContent?.trim().slice(0, 80) || element.getAttribute("download") || "link";
      const candidate = candidateFromUrl(element.getAttribute("href"), label, "", "dom-link", "link");
      if (candidate) out.push(candidate);
    }
  }

  function collectFromNode(node, out) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    collectElement(element, out);
    for (const child of element.querySelectorAll(TARGET_SELECTOR)) collectElement(child, out);
  }

  function collectCandidates() {
    const candidates = [];
    collectFromNode(document.documentElement, candidates);
    return candidates;
  }

  function candidateFromPerformanceEntry(entry) {
    const initiator = String(entry.initiatorType || "").toLowerCase();
    const shouldKeep = MEDIA_INITIATORS.has(initiator) || Boolean(utils.extensionFromUrl(entry.name)) || utils.shouldSniffMediaUrl(entry.name, { requestType: initiator });
    if (!shouldKeep) return null;
    return candidateFromUrl(entry.name, initiator || "resource", "", `performance-${initiator || "resource"}`, initiator, { keepUnclassified: true });
  }

  function collectPerformanceCandidates() {
    const candidates = [];
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const candidate = candidateFromPerformanceEntry(entry);
        if (candidate) candidates.push(candidate);
      }
    } catch (_error) {}
    return candidates;
  }

  function sendCandidates(candidates) {
    if (!isCaptureActive()) return;
    const fresh = [];
    for (const candidate of candidates) {
      const key = `${candidate.source || ""}|${candidate.url}|${candidate.mimeType || ""}`;
      const current = Date.now();
      if (seen.has(key) && current - seen.get(key) < 5000) continue;
      seen.delete(key);
      seen.set(key, current);
      fresh.push(candidate);
    }
    pruneSeen();
    const bounded = contentCore.boundBatch(fresh);
    if (bounded.length === 0) return;
    chrome.runtime.sendMessage({ type: "OVC_MEDIA_FOUND_BATCH", items: bounded }, () => {
      void chrome.runtime.lastError;
    });
  }

  function scanNow() {
    scanTimer = 0;
    if (!isCaptureActive()) return;
    sendCandidates(collectCandidates().concat(collectPerformanceCandidates()));
  }

  function scheduleScan() {
    if (!isCaptureActive() || scanTimer) return;
    scanTimer = window.setTimeout(scanNow, 250);
  }

  function scanEventTarget(event) {
    if (!isCaptureActive()) return;
    const candidates = [];
    collectFromNode(event?.target, candidates);
    sendCandidates(candidates);
  }

  function startObserver() {
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        if (!isCaptureActive()) return;
        const candidates = [];
        for (const mutation of mutations) {
          if (mutation.type === "attributes") collectFromNode(mutation.target, candidates);
          for (const node of mutation.addedNodes || []) collectFromNode(node, candidates);
        }
        sendCandidates(candidates);
      });
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "href"]
      });
    }
    if (!performanceObserver && typeof PerformanceObserver === "function") {
      try {
        performanceObserver = new PerformanceObserver((list) => {
          if (!isCaptureActive()) return;
          const candidates = [];
          for (const entry of list.getEntries()) {
            const candidate = candidateFromPerformanceEntry(entry);
            if (candidate) candidates.push(candidate);
          }
          sendCandidates(candidates);
        });
        performanceObserver.observe({ type: "resource", buffered: false });
      } catch (_error) {
        performanceObserver = null;
      }
    }
  }

  function stopCapture() {
    if (scanTimer) {
      window.clearTimeout(scanTimer);
      scanTimer = 0;
    }
    if (stopTimer) {
      window.clearTimeout(stopTimer);
      stopTimer = 0;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (performanceObserver) {
      performanceObserver.disconnect();
      performanceObserver = null;
    }
    seen.clear();
    pageEventWindow = 0;
    pageEventsInWindow = 0;
    pageEventsTotal = 0;
    if (captureUntil) {
      captureUntil = 0;
      dispatchPageStop();
    }
  }

  function armCapture(durationMs) {
    const requestedMs = Number(durationMs || CAPTURE_DEFAULT_MS) || CAPTURE_DEFAULT_MS;
    const ms = Math.max(1000, Math.min(CAPTURE_DEFAULT_MS, requestedMs));
    captureUntil = Math.max(captureUntil, Date.now() + ms);
    startObserver();
    if (stopTimer) window.clearTimeout(stopTimer);
    stopTimer = window.setTimeout(stopCapture, Math.max(0, captureUntil - Date.now()) + 500);
    scheduleScan();
    return { captureUntil };
  }

  window.addEventListener(PAGE_EVENT_NAME, (event) => {
    if (!isCaptureActive()) return;
    if (!consumePageEventBudget(event.detail)) return;
    const parsed = contentCore.parsePageCandidatePayload(event.detail, pageContext());
    if (!parsed) return;
    const candidate = candidateFromUrl(parsed.url, parsed.label, parsed.mimeType, parsed.source, parsed.requestType, {
      keepUnclassified: parsed.force || utils.shouldSniffMediaUrl(parsed.url, { requestType: parsed.requestType || "", mimeType: parsed.mimeType || "" }),
      lowConfidence: true,
      untrustedPageHint: true
    });
    if (candidate) sendCandidates([candidate]);
  });

  document.addEventListener("loadedmetadata", scanEventTarget, true);
  document.addEventListener("play", scanEventTarget, true);
  document.addEventListener("loadstart", scanEventTarget, true);
  window.addEventListener("pageshow", scheduleScan);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OVC_SCAN_NOW") {
      const result = armCapture(message.durationMs);
      scanNow();
      sendResponse({ ok: true, captureUntil: result.captureUntil });
      return true;
    }
    if (message?.type === "OVC_CAPTURE_STOP") {
      stopCapture();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
