(function attachContentCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OpenVideoCatcherContentCore = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function contentCoreFactory() {
  "use strict";

  const LIMITS = Object.freeze({
    maxEventPayloadBytes: 8192,
    maxUrlLength: 4096,
    maxTextLength: 256,
    maxMimeLength: 256,
    maxSourceLength: 64,
    maxBatchItems: 50,
    maxBatchPayloadBytes: 64 * 1024
  });

  const ALLOWED_PAGE_KEYS = new Set(["url", "source", "label", "requestType", "mimeType", "force"]);
  const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

  function byteLength(value) {
    const text = String(value || "");
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function truncate(value, max) {
    return String(value || "").slice(0, max);
  }

  function resolveUrl(rawUrl, baseUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > LIMITS.maxUrlLength) return "";
    try {
      const parsed = new URL(rawUrl, baseUrl || "https://example.invalid/");
      if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return "";
      if (parsed.href.length > LIMITS.maxUrlLength) return "";
      return parsed.href;
    } catch (_error) {
      return "";
    }
  }

  function parsePageCandidatePayload(detail, context) {
    if (typeof detail !== "string") return null;
    if (byteLength(detail) > LIMITS.maxEventPayloadBytes) return null;
    let parsed;
    try {
      parsed = JSON.parse(detail);
    } catch (_error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const key of Object.keys(parsed)) {
      if (!ALLOWED_PAGE_KEYS.has(key)) return null;
    }
    const url = resolveUrl(parsed.url, context?.baseUrl);
    if (!url) return null;
    return {
      url,
      pageUrl: resolveUrl(context?.pageUrl || "", context?.baseUrl),
      pageTitle: truncate(context?.pageTitle || "", LIMITS.maxTextLength),
      label: truncate(parsed.label || parsed.source || "page", LIMITS.maxTextLength),
      source: `page-${truncate(parsed.source || "hook", LIMITS.maxSourceLength)}`,
      requestType: truncate(parsed.requestType || "", LIMITS.maxSourceLength),
      mimeType: truncate(parsed.mimeType || "", LIMITS.maxMimeLength),
      force: parsed.force === true,
      sniff: parsed.force === true,
      lowConfidence: true,
      untrustedPageHint: true
    };
  }

  function boundBatch(items) {
    const batch = Array.isArray(items) ? items.slice(0, LIMITS.maxBatchItems) : [];
    let text = "[]";
    try {
      text = JSON.stringify(batch);
    } catch (_error) {
      return [];
    }
    if (byteLength(text) <= LIMITS.maxBatchPayloadBytes) return batch;
    const bounded = [];
    for (const item of batch) {
      const candidate = bounded.concat([item]);
      if (byteLength(JSON.stringify(candidate)) <= LIMITS.maxBatchPayloadBytes) bounded.push(item);
    }
    return bounded;
  }

  return {
    LIMITS,
    boundBatch,
    parsePageCandidatePayload,
    resolveUrl
  };
});
