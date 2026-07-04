(() => {
  "use strict";

  const utils = window.OpenVideoCatcherUtils;
  if (!utils || window.__openVideoCatcherInstalled) return;
  window.__openVideoCatcherInstalled = true;

  const CAPTURE_DEFAULT_MS = 90000;
  const MEDIA_INITIATORS = new Set(["video", "audio", "source", "media", "fetch", "xmlhttprequest", "other"]);
  const seen = new Map();
  let scanTimer = 0;
  let stopTimer = 0;
  let captureUntil = 0;
  let pageHookInjected = false;
  let observer = null;

  function isCaptureActive() {
    const active = Date.now() <= captureUntil;
    if (!active && observer) {
      observer.disconnect();
      observer = null;
    }
    return active;
  }

  function injectPageHook() {
    if (pageHookInjected) return true;
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page/page-hook.js");
      script.async = false;
      script.onload = () => script.remove();
      (document.documentElement || document.head || document.body).appendChild(script);
      pageHookInjected = true;
      return true;
    } catch (_error) {
      return false;
    }
  }

  function resolveUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    try { return new URL(rawUrl, document.baseURI).href; } catch (_error) { return ""; }
  }

  function candidateFromUrl(rawUrl, label, mimeType, source, requestType) {
    const url = resolveUrl(rawUrl);
    if (!url) return null;
    const item = utils.createMediaItem({
      url,
      source: source || "dom",
      fromDom: true,
      requestType: requestType || "",
      mimeType: mimeType || "",
      pageUrl: location.href,
      pageTitle: document.title,
      label: label || ""
    });
    if (!item) return null;
    return {
      url: item.url,
      displayUrl: item.displayUrl,
      label: item.label,
      mimeType: item.mimeType,
      pageUrl: location.href,
      pageTitle: document.title,
      source: source || "dom",
      requestType: requestType || ""
    };
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

  function collectCandidates() {
    const candidates = [];
    for (const element of document.querySelectorAll("video,audio")) collectFromMediaElement(element, candidates);
    for (const source of document.querySelectorAll("source[src]")) {
      const candidate = candidateFromUrl(source.getAttribute("src"), source.getAttribute("label") || "source", source.getAttribute("type") || "", "dom-source", "source");
      if (candidate) candidates.push(candidate);
    }
    for (const link of document.querySelectorAll("a[href]")) {
      const candidate = candidateFromUrl(link.getAttribute("href"), link.textContent?.trim().slice(0, 80) || link.getAttribute("download") || "link", "", "dom-link", "link");
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  function collectPerformanceCandidates() {
    const candidates = [];
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const initiator = String(entry.initiatorType || "").toLowerCase();
        if (!MEDIA_INITIATORS.has(initiator) && !utils.extensionFromUrl(entry.name)) continue;
        const candidate = candidateFromUrl(entry.name, initiator || "resource", "", `performance-${initiator || "resource"}`, initiator);
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
      const now = Date.now();
      if (seen.has(key) && now - seen.get(key) < 5000) continue;
      seen.set(key, now);
      fresh.push(candidate);
    }
    if (fresh.length === 0) return;
    chrome.runtime.sendMessage({ type: "OVC_MEDIA_FOUND_BATCH", items: fresh.slice(0, 100) }, () => {
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

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href"]
    });
  }

  function armCapture(durationMs) {
    const ms = Number(durationMs || CAPTURE_DEFAULT_MS) || CAPTURE_DEFAULT_MS;
    captureUntil = Math.max(captureUntil, Date.now() + ms);
    const hookInjected = injectPageHook();
    startObserver();
    if (stopTimer) window.clearTimeout(stopTimer);
    stopTimer = window.setTimeout(() => {
      if (!isCaptureActive() && observer) {
        observer.disconnect();
        observer = null;
      }
    }, ms + 500);
    scheduleScan();
    return { hookInjected, captureUntil };
  }

  window.addEventListener("__OVC_MEDIA_CANDIDATE", (event) => {
    if (!isCaptureActive()) return;
    const detail = event.detail || {};
    const candidate = candidateFromUrl(detail.url, detail.label || detail.source || "page", detail.mimeType || "", detail.source || "page-hook", detail.requestType || "");
    if (candidate) sendCandidates([candidate]);
  });

  document.addEventListener("loadedmetadata", scheduleScan, true);
  document.addEventListener("play", scheduleScan, true);
  document.addEventListener("loadstart", scheduleScan, true);
  window.addEventListener("pageshow", scheduleScan);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OVC_SCAN_NOW") {
      const result = armCapture(message.durationMs);
      scanNow();
      sendResponse({ ok: true, captureUntil: result.captureUntil, pageHookInjected: result.hookInjected });
      return true;
    }
    return false;
  });
})();
