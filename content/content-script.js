(() => {
  "use strict";

  const utils = window.OpenVideoCatcherUtils;
  if (!utils || window.__openVideoCatcherInstalled) return;
  window.__openVideoCatcherInstalled = true;

  const seen = new Map();
  let scanTimer = 0;

  function injectPageHook() {
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page/page-hook.js");
      script.async = false;
      script.onload = () => script.remove();
      (document.documentElement || document.head || document.body).appendChild(script);
    } catch (_error) {
      // Some restricted pages reject injection; DOM + webRequest detection still works.
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

  function sendCandidates(candidates) {
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
    sendCandidates(collectCandidates());
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(scanNow, 250);
  }

  window.addEventListener("__OVC_MEDIA_CANDIDATE", (event) => {
    const detail = event.detail || {};
    const candidate = candidateFromUrl(detail.url, detail.label || detail.source || "page", detail.mimeType || "", detail.source || "page-hook", detail.requestType || "");
    if (candidate) sendCandidates([candidate]);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OVC_SCAN_NOW") {
      scanNow();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  injectPageHook();
  document.addEventListener("loadedmetadata", scheduleScan, true);
  document.addEventListener("play", scheduleScan, true);
  document.addEventListener("loadstart", scheduleScan, true);
  window.addEventListener("pageshow", scheduleScan);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href"]
  });

  scheduleScan();
})();
