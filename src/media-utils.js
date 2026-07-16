/*
 * Open Video Catcher shared utilities.
 * UMD-style module so the same tested code works in Node tests,
 * the MV3 service worker, popup pages, and classic content scripts.
 */
(function attachMediaUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.OpenVideoCatcherUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function mediaUtilsFactory() {
  "use strict";

  const DIRECT_MEDIA_EXTENSIONS = new Map([
    ["mp4", "video"], ["m4v", "video"], ["webm", "video"], ["mov", "video"],
    ["avi", "video"], ["mkv", "video"], ["flv", "video"], ["ogv", "video"],
    ["mp3", "audio"], ["m4a", "audio"], ["aac", "audio"], ["ogg", "audio"],
    ["oga", "audio"], ["opus", "audio"], ["wav", "audio"], ["flac", "audio"]
  ]);

  const PLAYLIST_EXTENSIONS = new Map([
    ["m3u8", "hls-playlist"],
    ["mpd", "dash-manifest"]
  ]);

  const SEGMENT_EXTENSIONS = new Map([
    ["ts", "stream-segment"], ["m4s", "stream-segment"],
    ["cmfv", "stream-segment"], ["cmfa", "stream-segment"]
  ]);

  const MIME_EXTENSION_HINTS = new Map([
    ["video/mp4", "mp4"], ["video/webm", "webm"], ["video/quicktime", "mov"],
    ["video/ogg", "ogv"], ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"],
    ["audio/aac", "aac"], ["audio/ogg", "ogg"], ["audio/wav", "wav"],
    ["audio/flac", "flac"], ["application/vnd.apple.mpegurl", "m3u8"],
    ["application/x-mpegurl", "m3u8"], ["audio/mpegurl", "m3u8"],
    ["application/dash+xml", "mpd"], ["video/mp2t", "ts"],
    ["video/iso.segment", "m4s"], ["audio/iso.segment", "m4s"]
  ]);

  const SAFE_NAME_FALLBACK = "media";
  const SNIFFABLE_REQUEST_TYPES = new Set(["media", "video", "audio", "source", "fetch", "xmlhttprequest", "object", "other", ""]);
  const GENERIC_SNIFFABLE_MIME = /^(|application\/octet-stream|binary\/octet-stream|application\/x-binary|text\/plain)$/i;
  const MEDIA_URL_HINT_PATTERN = /(?:^|[/?&._=-])(m3u8|mpd|hls|dash|manifest|playlist|master|chunklist|videoplayback|video|audio|media|stream|playback|segment|fragment|frag|fmp4|m4s|init)(?:[/?&._=-]|$)/i;

  function normalizeMime(value) {
    if (!value || typeof value !== "string") return "";
    return value.split(";")[0].trim().toLowerCase();
  }

  function parseUrl(url, baseUrl) {
    if (!url || typeof url !== "string") return null;
    try {
      return new URL(url, baseUrl || "https://example.invalid/");
    } catch (_error) {
      return null;
    }
  }

  function resolveUrl(url, baseUrl) {
    const parsed = parseUrl(url, baseUrl);
    return parsed ? parsed.href : "";
  }

  function isSupportedProtocol(protocol) {
    return protocol === "http:" || protocol === "https:" || protocol === "blob:";
  }

  function isNetworkProtocol(protocol) {
    return protocol === "http:" || protocol === "https:";
  }

  function extensionFromPathname(pathname) {
    if (!pathname || typeof pathname !== "string") return "";
    const clean = pathname.toLowerCase();
    const match = clean.match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : "";
  }

  function extensionFromUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) return "";
    return extensionFromPathname(parsed.pathname);
  }

  function extensionKind(ext) {
    const clean = String(ext || "").toLowerCase();
    return DIRECT_MEDIA_EXTENSIONS.get(clean) || PLAYLIST_EXTENSIONS.get(clean) || SEGMENT_EXTENSIONS.get(clean) || "";
  }

  function filenameFromContentDisposition(value) {
    const text = String(value || "");
    if (!text) return "";
    const filenameStar = text.match(/filename\*\s*=\s*([^;]+)/i);
    if (filenameStar) {
      const raw = filenameStar[1].trim().replace(/^"|"$/g, "");
      const match = raw.match(/^([^']*)'([^']*)'(.*)$/);
      const encoded = match ? match[3] : raw;
      try { return decodeURIComponent(encoded); } catch (_error) { return encoded; }
    }
    const filename = text.match(/filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i);
    if (!filename) return "";
    const raw = filename[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return raw;
  }

  function preferredExtensionForMime(mime, urlExt, mimeKind) {
    const cleanMime = normalizeMime(mime);
    const cleanExt = String(urlExt || "").toLowerCase();
    const hinted = MIME_EXTENSION_HINTS.get(cleanMime) || "";
    const extKind = extensionKind(cleanExt);
    if (cleanExt && extKind && extKind === mimeKind) return cleanExt;
    return hinted || (cleanExt && !extKind ? cleanExt : "");
  }

  function replaceOrAppendExtension(base, ext) {
    const target = String(ext || "").toLowerCase();
    if (!target) return base;
    const lower = String(base || "").toLowerCase();
    if (lower.endsWith(`.${target}`)) return base;
    const existing = lower.match(/\.([a-z0-9]{2,5})$/);
    if (existing) {
      return `${base.slice(0, -existing[0].length)}.${target}`;
    }
    return `${base}.${target}`;
  }

  function isMediaMime(mime) {
    return mime.startsWith("video/") || mime.startsWith("audio/");
  }

  function kindFromMime(mime) {
    if (mime === "application/vnd.apple.mpegurl" || mime === "application/x-mpegurl" || mime === "audio/mpegurl") return "hls-playlist";
    if (mime === "application/dash+xml") return "dash-manifest";
    if (mime === "video/mp2t" || mime === "video/iso.segment" || mime === "audio/iso.segment") return "stream-segment";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "";
  }

  function bytesView(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    return null;
  }

  function sniffMediaInfo(url, options) {
    const opts = options || {};
    const mime = normalizeMime(opts.mimeType || opts.contentType || "");
    const mimeKind = kindFromMime(mime);
    if (mimeKind) {
      const ext = preferredExtensionForMime(mime, extensionFromUrl(url), mimeKind) || (mimeKind === "hls-playlist" ? "m3u8" : mimeKind === "dash-manifest" ? "mpd" : "");
      return { kind: mimeKind, ext, mimeType: mime };
    }

    const text = String(opts.sniffedText || opts.text || "").replace(/^\uFEFF/, "").trimStart();
    if (text.startsWith("#EXTM3U")) return { kind: "hls-playlist", ext: "m3u8", mimeType: "application/vnd.apple.mpegurl" };
    if (/<MPD\b/i.test(text.slice(0, 8192))) return { kind: "dash-manifest", ext: "mpd", mimeType: "application/dash+xml" };

    const bytes = bytesView(opts.sniffedBytes || opts.bytes);
    if (bytes && bytes.length >= 12) {
      const brand = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
      if (brand === "ftyp") return { kind: "video", ext: "mp4", mimeType: "video/mp4" };
      if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: "video", ext: "webm", mimeType: "video/webm" };
    }

    return null;
  }

  function shouldSniffMediaUrl(url, options) {
    const opts = options || {};
    const parsed = parseUrl(url, opts.baseUrl);
    if (!parsed || !isNetworkProtocol(parsed.protocol)) return false;
    const ext = extensionFromPathname(parsed.pathname);
    if (extensionKind(ext)) return false;
    const requestType = String(opts.requestType || "").toLowerCase();
    if (!SNIFFABLE_REQUEST_TYPES.has(requestType)) return false;
    const mime = normalizeMime(opts.mimeType || opts.contentType || "");
    if (mime && kindFromMime(mime)) return false;
    if (mime && !GENERIC_SNIFFABLE_MIME.test(mime)) return false;
    return requestType === "media" || MEDIA_URL_HINT_PATTERN.test(`${parsed.pathname}${parsed.search}`.toLowerCase());
  }

  function classifyMediaUrl(url, options) {
    const opts = options || {};
    const parsed = parseUrl(url, opts.baseUrl);
    if (!parsed || !isSupportedProtocol(parsed.protocol)) return null;

    const mime = normalizeMime(opts.mimeType || opts.contentType || "");
    const ext = extensionFromPathname(parsed.pathname);
    const dispositionExt = extensionFromPathname(filenameFromContentDisposition(opts.contentDisposition).replace(/[?#].*$/, ""));
    const mimeExt = MIME_EXTENSION_HINTS.get(mime) || "";
    const evidence = { mimeExt, dispositionExt, urlExt: ext };
    const finish = (classification) => Object.assign({}, classification, {
      classificationEvidence: evidence,
      classificationConflict: new Set(Object.values(evidence).filter((value) => extensionKind(value))).size > 1
    });

    if (mime) {
      const mimeKind = kindFromMime(mime);
      if (mimeKind) {
        const dispositionKind = extensionKind(dispositionExt);
        const urlKind = extensionKind(ext);
        const explicitSegmentExt = dispositionKind === "stream-segment" ? dispositionExt : (urlKind === "stream-segment" ? ext : "");
        if (explicitSegmentExt && (mimeKind === "video" || mimeKind === "audio")) {
          return finish({ kind: "stream-segment", ext: explicitSegmentExt, mimeType: mime, protocol: parsed.protocol });
        }
        const selectedExt = mimeExt
          || (dispositionKind === mimeKind ? dispositionExt : "")
          || (urlKind === mimeKind ? ext : "")
          || preferredExtensionForMime(mime, ext, mimeKind);
        return finish({ kind: mimeKind, ext: selectedExt, mimeType: mime, protocol: parsed.protocol });
      }
    }

    if (PLAYLIST_EXTENSIONS.has(dispositionExt)) return finish({ kind: PLAYLIST_EXTENSIONS.get(dispositionExt), ext: dispositionExt, mimeType: mime, protocol: parsed.protocol });
    if (DIRECT_MEDIA_EXTENSIONS.has(dispositionExt)) return finish({ kind: DIRECT_MEDIA_EXTENSIONS.get(dispositionExt), ext: dispositionExt, mimeType: mime, protocol: parsed.protocol });
    if (SEGMENT_EXTENSIONS.has(dispositionExt)) return finish({ kind: SEGMENT_EXTENSIONS.get(dispositionExt), ext: dispositionExt, mimeType: mime, protocol: parsed.protocol });

    if (PLAYLIST_EXTENSIONS.has(ext)) return finish({ kind: PLAYLIST_EXTENSIONS.get(ext), ext, mimeType: mime, protocol: parsed.protocol });
    if (DIRECT_MEDIA_EXTENSIONS.has(ext)) return finish({ kind: DIRECT_MEDIA_EXTENSIONS.get(ext), ext, mimeType: mime, protocol: parsed.protocol });
    if (SEGMENT_EXTENSIONS.has(ext)) return finish({ kind: SEGMENT_EXTENSIONS.get(ext), ext, mimeType: mime, protocol: parsed.protocol });

    const sniffed = sniffMediaInfo(parsed.href, opts);
    if (sniffed) return finish({ kind: sniffed.kind, ext: sniffed.ext, mimeType: sniffed.mimeType, protocol: parsed.protocol });

    if (parsed.protocol === "blob:" && opts.fromDom) return finish({ kind: "blob-media", ext: "", mimeType: mime, protocol: parsed.protocol });

    if ((opts.requestType === "media" || opts.requestType === "video" || opts.requestType === "audio") && isNetworkProtocol(parsed.protocol)) {
      return finish({ kind: mime.startsWith("audio/") ? "audio" : "video", ext: mimeExt || dispositionExt || ext, mimeType: mime, protocol: parsed.protocol });
    }

    return null;
  }

  function hashString(input) {
    const text = String(input || "");
    let hash = 5381;
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    return (hash >>> 0).toString(36);
  }

  function safeFilename(name, fallback) {
    const base = String(name || fallback || SAFE_NAME_FALLBACK)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s-]+/, "")
      .trim();
    const cleaned = base || fallback || SAFE_NAME_FALLBACK;
    return cleaned.slice(0, 120);
  }

  function decodePathSegment(segment) {
    try { return decodeURIComponent(segment); } catch (_error) { return segment; }
  }

  function guessFilename(url, classification, fallbackTitle, contentDisposition) {
    const info = classification || classifyMediaUrl(url) || {};
    const parsed = parseUrl(url);
    const ext = info.ext || MIME_EXTENSION_HINTS.get(normalizeMime(info.mimeType)) || (info.kind === "hls-playlist" ? "m3u8" : info.kind === "dash-manifest" ? "mpd" : "");
    let base = filenameFromContentDisposition(contentDisposition);

    if (!base && parsed && parsed.protocol !== "blob:") {
      const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
      base = decodePathSegment(last).replace(/[?#].*$/, "");
    }

    if (!base || base.length > 160 || !/[a-z0-9]/i.test(base)) {
      const titlePart = fallbackTitle ? String(fallbackTitle).slice(0, 80) : SAFE_NAME_FALLBACK;
      base = `${safeFilename(titlePart, SAFE_NAME_FALLBACK)}-${hashString(url).slice(0, 6)}`;
    }

    base = replaceOrAppendExtension(base, ext);
    return safeFilename(base, `${SAFE_NAME_FALLBACK}.${ext || "bin"}`);
  }

  function redactUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) return String(url || "").replace(/[?#].*$/, "?…");
    if (parsed.protocol === "blob:") {
      const originMatch = parsed.href.match(/^blob:([^/]+\/\/[^/]+)\//i);
      return originMatch ? `blob:${originMatch[1]}/…` : "blob:…";
    }
    const hadSearch = parsed.search.length > 0;
    const hadHash = parsed.hash.length > 0;
    parsed.username = parsed.username ? "…" : "";
    parsed.password = parsed.password ? "…" : "";
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.toString()}${hadSearch ? "?…" : ""}${hadHash ? "#…" : ""}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = value;
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1) { scaled /= 1024; unitIndex += 1; }
    const decimals = unitIndex === 0 || scaled >= 10 ? 0 : 1;
    return `${scaled.toFixed(decimals)} ${units[unitIndex]}`;
  }

  function humanBitrate(bitsPerSecond) {
    const value = Number(bitsPerSecond || 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)} Mbps`;
    return `${Math.round(value / 1000)} kbps`;
  }

  function parseAttributeList(input) {
    const attrs = {};
    const text = String(input || "");
    const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let match;
    while ((match = regex.exec(text))) {
      const key = match[1].toUpperCase();
      let value = match[2] || "";
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      attrs[key] = value;
    }
    return attrs;
  }

  function parseXmlAttributes(input) {
    const attrs = {};
    const text = String(input || "");
    const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
    let match;
    while ((match = regex.exec(text))) attrs[match[1]] = match[3];
    return attrs;
  }

  function qualityLabelForVariant(variant) {
    if (!variant) return "";
    const parts = [];
    if (variant.resolution) parts.push(variant.resolution);
    if (variant.frameRate) parts.push(`${variant.frameRate}fps`);
    if (variant.bandwidth) parts.push(humanBitrate(variant.bandwidth));
    return parts.join(" · ") || "variant";
  }

  function parseHlsPlaylist(text, playlistUrl) {
    const MAX_HLS_LINES = 20000;
    const MAX_HLS_VARIANTS = 100;
    const MAX_HLS_MEDIA = 100;
    const MAX_HLS_SEGMENTS = 100;
    const allLines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    const lines = allLines.slice(0, MAX_HLS_LINES).map((line) => line.trim());
    const variants = [];
    const media = [];
    const segments = [];
    let variantCount = 0;
    let mediaCount = 0;
    let segmentCount = 0;
    let totalDuration = 0;
    let encrypted = false;
    let encryptionMethods = [];
    let pendingStreamInf = null;
    let pendingExtinf = null;
    let targetDuration = 0;
    let isMaster = false;

    for (const line of lines) {
      if (!line) continue;
      if (pendingStreamInf && !line.startsWith("#")) {
        const url = resolveUrl(line, playlistUrl);
        const variant = {
          url,
          displayUrl: redactUrl(url),
          bandwidth: Number(pendingStreamInf.BANDWIDTH || 0) || 0,
          averageBandwidth: Number(pendingStreamInf["AVERAGE-BANDWIDTH"] || 0) || 0,
          resolution: pendingStreamInf.RESOLUTION || "",
          frameRate: pendingStreamInf["FRAME-RATE"] || "",
          codecs: pendingStreamInf.CODECS || ""
        };
        variant.qualityLabel = qualityLabelForVariant(variant);
        variantCount += 1;
        if (variants.length < MAX_HLS_VARIANTS) variants.push(variant);
        pendingStreamInf = null;
        continue;
      }
      if (pendingExtinf && !line.startsWith("#")) {
        const url = resolveUrl(line, playlistUrl);
        segmentCount += 1;
        totalDuration += pendingExtinf.duration || 0;
        if (segments.length < MAX_HLS_SEGMENTS) segments.push({ url, displayUrl: redactUrl(url), duration: pendingExtinf.duration, title: pendingExtinf.title });
        pendingExtinf = null;
        continue;
      }
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        isMaster = true;
        pendingStreamInf = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      } else if (line.startsWith("#EXT-X-MEDIA:")) {
        mediaCount += 1;
        if (media.length < MAX_HLS_MEDIA) media.push(parseAttributeList(line.slice("#EXT-X-MEDIA:".length)));
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttributeList(line.slice("#EXT-X-KEY:".length));
        const method = String(attrs.METHOD || "").toUpperCase();
        if (method && method !== "NONE") {
          encrypted = true;
          if (!encryptionMethods.includes(method)) encryptionMethods.push(method);
        }
      } else if (line.startsWith("#EXTINF:")) {
        const rest = line.slice("#EXTINF:".length);
        const commaIndex = rest.indexOf(",");
        pendingExtinf = {
          duration: Number(commaIndex >= 0 ? rest.slice(0, commaIndex) : rest) || 0,
          title: commaIndex >= 0 ? rest.slice(commaIndex + 1).trim() : ""
        };
      } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      }
    }

    return {
      type: "hls",
      isMaster,
      encrypted,
      encryptionMethods,
      targetDuration,
      variantCount,
      segmentCount,
      totalDuration,
      mediaCount,
      truncated: allLines.length > MAX_HLS_LINES || variantCount > variants.length || mediaCount > media.length || segmentCount > segments.length,
      variants,
      media,
      sampleSegments: segments.slice(0, 5)
    };
  }

  function parseDashManifest(text, manifestUrl) {
    const xml = String(text || "");
    const protectedContent = /<ContentProtection\b/i.test(xml);
    const representations = [];
    const regex = /<Representation\b([^>]*)>/gi;
    let match;
    while ((match = regex.exec(xml))) {
      const attrs = parseXmlAttributes(match[1]);
      const representation = {
        id: attrs.id || "",
        bandwidth: Number(attrs.bandwidth || 0) || 0,
        resolution: attrs.width && attrs.height ? `${attrs.width}x${attrs.height}` : "",
        codecs: attrs.codecs || "",
        mimeType: attrs.mimeType || attrs.contentType || "",
        frameRate: attrs.frameRate || ""
      };
      representation.qualityLabel = qualityLabelForVariant(representation) || representation.id;
      representations.push(representation);
    }
    return {
      type: "dash",
      manifestUrl,
      protectedContent,
      representationCount: representations.length,
      representations: representations.slice(0, 20)
    };
  }

  function createMediaItem(input) {
    const data = input || {};
    const classification = classifyMediaUrl(data.url, data);
    if (!classification) return null;

    const url = data.url;
    const now = data.now || Date.now();
    const downloadable = isNetworkProtocol(classification.protocol) && (classification.kind === "video" || classification.kind === "audio");
    const fileName = guessFilename(url, classification, data.pageTitle || data.label || data.qualityLabel, data.contentDisposition);

    return {
      id: `${classification.kind}|${url}`,
      url,
      displayUrl: redactUrl(url),
      pageUrl: data.pageUrl ? redactUrl(data.pageUrl) : "",
      pageTitle: data.pageTitle || "",
      label: data.label || "",
      source: data.source || "unknown",
      requestType: data.requestType || "",
      kind: classification.kind,
      ext: classification.ext || "",
      mimeType: classification.mimeType || "",
      protocol: classification.protocol,
      fileName,
      size: Number(data.size || 0) || 0,
      sizeText: formatBytes(data.size),
      downloadable,
      qualityLabel: data.qualityLabel || "",
      bandwidth: Number(data.bandwidth || 0) || 0,
      averageBandwidth: Number(data.averageBandwidth || 0) || 0,
      resolution: data.resolution || "",
      frameRate: data.frameRate || "",
      codecs: data.codecs || "",
      parentPlaylistUrl: data.parentPlaylistUrl ? redactUrl(data.parentPlaylistUrl) : "",
      encrypted: Boolean(data.encrypted),
      analysis: data.analysis || null,
      lowConfidence: Boolean(data.lowConfidence),
      classificationConflict: Boolean(classification.classificationConflict),
      classificationEvidence: classification.classificationEvidence || { mimeExt: "", dispositionExt: "", urlExt: "" },
      firstSeen: now,
      lastSeen: now,
      detectionCount: Number.isFinite(Number(data.detectionCount)) ? Math.max(0, Number(data.detectionCount)) : 1,
      enrichmentCount: Number.isFinite(Number(data.enrichmentCount)) ? Math.max(0, Number(data.enrichmentCount)) : 0,
      count: Number.isFinite(Number(data.detectionCount)) ? Math.max(0, Number(data.detectionCount)) : 1
    };
  }

  function mergeMediaItems(existing, incoming, options = {}) {
    if (!existing) return Object.assign({}, incoming);
    const existingDetections = Number(existing.detectionCount ?? existing.count ?? 1) || 0;
    const incomingDetections = Number(incoming.detectionCount ?? incoming.count ?? 1) || 0;
    const existingEnrichments = Number(existing.enrichmentCount || 0) || 0;
    const incomingEnrichments = Number(incoming.enrichmentCount || 0) || 0;
    const detectionCount = options.enrichment ? existingDetections : existingDetections + incomingDetections;
    const enrichmentCount = options.enrichment ? existingEnrichments + 1 : existingEnrichments + incomingEnrichments;
    const merged = Object.assign({}, existing, incoming, {
      firstSeen: Math.min(existing.firstSeen || incoming.firstSeen, incoming.firstSeen || existing.firstSeen),
      lastSeen: Math.max(existing.lastSeen || incoming.lastSeen, incoming.lastSeen || existing.lastSeen),
      detectionCount,
      enrichmentCount,
      count: detectionCount
    });
    if (existing.source && incoming.source && existing.source !== incoming.source && !existing.source.includes(incoming.source)) merged.source = `${existing.source}+${incoming.source}`;
    const strength = (item) => {
      const evidence = item?.classificationEvidence || {};
      return (evidence.mimeExt ? 8 : 0) + (evidence.dispositionExt ? 4 : 0) + (evidence.urlExt ? 2 : 0) + (item?.mimeType ? 1 : 0);
    };
    if (strength(incoming) < strength(existing)) {
      for (const key of ["kind", "ext", "mimeType", "fileName", "downloadable", "classificationConflict", "classificationEvidence"]) merged[key] = existing[key];
    }
    for (const key of ["ext", "mimeType", "fileName", "size", "sizeText", "qualityLabel", "bandwidth", "averageBandwidth", "resolution", "frameRate", "codecs", "parentPlaylistUrl", "analysis", "classificationEvidence"]) {
      if ((incoming[key] === undefined || incoming[key] === "" || incoming[key] === 0 || incoming[key] === null) && existing[key]) merged[key] = existing[key];
    }
    if (!incoming.classificationConflict && existing.classificationConflict) merged.classificationConflict = true;
    return merged;
  }

  function kindLabel(kind) {
    const labels = {
      video: "비디오",
      audio: "오디오",
      "hls-playlist": "HLS 재생목록",
      "dash-manifest": "DASH 매니페스트",
      "stream-segment": "스트리밍 조각",
      "blob-media": "Blob 미디어"
    };
    return labels[kind] || "미분류 후보";
  }

  function quoteForShell(value) {
    return `"${String(value || "").replace(/(["\\$`])/g, "\\$1")}"`;
  }

  function quoteForPowerShell(value) {
    return `'${String(value || "").replace(/'/g, "''")}'`;
  }

  function withOutputExtension(filename, ext) {
    const base = safeFilename(filename || `media.${ext}`, `media.${ext}`);
    return safeFilename(replaceOrAppendExtension(base, ext), `media.${ext}`);
  }

  function codecsSupportMp4(codecs) {
    const values = String(codecs || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) return false;
    return values.every((value) => /^(avc1|avc3|hvc1|hev1|av01|mp4a|ac-3|ec-3)/.test(value));
  }

  function ffmpegPlan(input, filenameOrOptions, maybeOptions) {
    const item = typeof input === "object" && input !== null
      ? Object.assign({}, input)
      : Object.assign({ url: String(input || ""), fileName: String(filenameOrOptions || "") }, classifyMediaUrl(String(input || "")) || {});
    const options = typeof input === "object" && input !== null ? (filenameOrOptions || {}) : (maybeOptions || {});
    const quote = options.shell === "powershell" ? quoteForPowerShell : quoteForShell;
    const isPlaylist = item.kind === "hls-playlist" || item.kind === "dash-manifest";
    let outputExt = String(item.ext || extensionFromUrl(item.url) || "").toLowerCase();
    let mapArgs = "-map 0";
    let warning = "";

    if (isPlaylist) {
      if (codecsSupportMp4(item.codecs)) {
        outputExt = "mp4";
        mapArgs = `-map ${quote("0:v?")} -map ${quote("0:a?")}`;
        warning = "MP4 was selected from codec evidence; subtitle and data streams are intentionally omitted.";
      } else {
        outputExt = "mkv";
        warning = item.codecs
          ? "Matroska (MKV) is used because the observed codecs are not a conservative MP4 stream-copy match."
          : "Codec evidence is missing; Matroska (MKV) is the safer stream-copy container.";
      }
    } else if (!DIRECT_MEDIA_EXTENSIONS.has(outputExt)) {
      outputExt = item.kind === "audio" ? "mka" : "mkv";
      warning = "The original direct-media container is unknown; a Matroska-family output is used for stream copy.";
    } else {
      warning = "Direct files are usually better saved with the browser download or curl; ffmpeg preserves the original container.";
    }

    const outputFile = withOutputExtension(item.fileName || guessFilename(item.url), outputExt);
    const command = `ffmpeg -hide_banner -nostdin -i ${quote(item.url)} ${mapArgs} -c copy ${quote(outputFile)}`;
    return {
      command,
      container: outputExt,
      outputFile,
      shell: options.shell === "powershell" ? "powershell" : "posix",
      streamCopy: true,
      warning
    };
  }

  function ffmpegCommand(input, filenameOrOptions, maybeOptions) {
    return ffmpegPlan(input, filenameOrOptions, maybeOptions).command;
  }

  function curlCommand(url, filename, options = {}) {
    const powershell = options.shell === "powershell";
    const quote = powershell ? quoteForPowerShell : quoteForShell;
    const executable = powershell ? "curl.exe" : "curl";
    return `${executable} -L --fail --output ${quote(safeFilename(filename || guessFilename(url), "media.bin"))} ${quote(url)}`;
  }

  function ytDlpCommand(url, filename, options = {}) {
    const quote = options.shell === "powershell" ? quoteForPowerShell : quoteForShell;
    const output = safeFilename(String(filename || "%(title)s.%(ext)s").replace(/\.(m3u8|mpd)$/i, ".%(ext)s"), "%(title)s.%(ext)s");
    return `yt-dlp --no-warnings -o ${quote(output)} ${quote(url)}`;
  }

  function displayQuality(item) {
    if (!item) return "";
    if (item.qualityLabel) return item.qualityLabel;
    return qualityLabelForVariant(item);
  }

  return {
    DIRECT_MEDIA_EXTENSIONS,
    PLAYLIST_EXTENSIONS,
    SEGMENT_EXTENSIONS,
    MIME_EXTENSION_HINTS,
    classifyMediaUrl,
    createMediaItem,
    curlCommand,
    displayQuality,
    extensionFromUrl,
    filenameFromContentDisposition,
    ffmpegCommand,
    ffmpegPlan,
    formatBytes,
    guessFilename,
    hashString,
    humanBitrate,
    isMediaMime,
    kindLabel,
    mergeMediaItems,
    normalizeMime,
    parseAttributeList,
    parseDashManifest,
    parseHlsPlaylist,
    qualityLabelForVariant,
    redactUrl,
    resolveUrl,
    safeFilename,
    shouldSniffMediaUrl,
    sniffMediaInfo,
    ytDlpCommand
  };
});
