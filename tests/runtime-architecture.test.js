const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundCore = require("../background/core.js");
const contentCore = require("../content/content-core.js");
const utils = require("../src/media-utils.js");
const packageExtension = require("../scripts/package-extension.js");

const root = path.resolve(__dirname, "..");

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    }
  };
}

function createFakeApi(sharedSession = {}) {
  const runtimeOnMessage = createEvent();
  const api = {
    outboundMessages: [],
    tabMessages: [],
    executedScripts: [],
    alarmsCreated: [],
    downloadsStarted: [],
    runtime: {
      id: "open-video-catcher-test-id",
      lastError: null,
      onMessage: runtimeOnMessage,
      getURL(relative = "") {
        return `chrome-extension://open-video-catcher-test-id/${relative}`;
      },
      sendMessage(message, callback) {
        api.outboundMessages.push(message);
        if (callback) callback();
        return Promise.resolve();
      }
    },
    action: {
      setBadgeBackgroundColor() { return Promise.resolve(); },
      setBadgeText() { return Promise.resolve(); }
    },
    storage: {
      session: {
        data: sharedSession,
        get(key, callback) {
          let result = {};
          if (typeof key === "string") result = { [key]: sharedSession[key] };
          else if (Array.isArray(key)) {
            for (const item of key) result[item] = sharedSession[item];
          } else if (key && typeof key === "object") {
            result = Object.assign({}, key);
            for (const item of Object.keys(key)) {
              if (Object.prototype.hasOwnProperty.call(sharedSession, item)) result[item] = sharedSession[item];
            }
          } else {
            result = Object.assign({}, sharedSession);
          }
          if (callback) callback(result);
          return Promise.resolve(result);
        },
        set(value, callback) {
          Object.assign(sharedSession, value);
          if (callback) callback();
          return Promise.resolve();
        },
        remove(key, callback) {
          for (const item of Array.isArray(key) ? key : [key]) delete sharedSession[item];
          if (callback) callback();
          return Promise.resolve();
        }
      }
    },
    scripting: {
      executeScript(details, callback) {
        api.executedScripts.push(details);
        const result = [{ frameId: 0 }];
        if (callback) callback(result);
        return Promise.resolve(result);
      }
    },
    permissions: {
      contains(_query, callback) {
        if (callback) callback(true);
        return Promise.resolve(true);
      }
    },
    tabs: {
      sendMessage(tabId, message, callback) {
        api.tabMessages.push({ tabId, message });
        const result = message.type === "OVC_SCAN_NOW" ? { ok: true, pageHookInjected: true } : { ok: true };
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      onRemoved: createEvent(),
      onUpdated: createEvent()
    },
    webRequest: {
      onBeforeRequest: createEvent(),
      onHeadersReceived: createEvent()
    },
    alarms: {
      onAlarm: createEvent(),
      create(name, info) {
        api.alarmsCreated.push({ name, info });
      }
    },
    downloads: {
      download(details, callback) {
        api.downloadsStarted.push(details);
        if (callback) callback(1);
      }
    }
  };

  api.extensionSender = {
    id: api.runtime.id,
    url: api.runtime.getURL("popup/popup.html")
  };

  api.dispatchRuntimeMessage = (message, sender = api.extensionSender) => new Promise((resolve) => {
    let responded = false;
    const sendResponse = (response) => {
      responded = true;
      resolve(response);
    };
    for (const listener of runtimeOnMessage.listeners) {
      const keepAlive = listener(message, sender, sendResponse);
      if (responded) return;
      if (!keepAlive) continue;
      return;
    }
    if (!responded) resolve(undefined);
  });

  return api;
}

function makeHeaders(headers) {
  const normalized = new Map();
  for (const [key, value] of Object.entries(headers || {})) normalized.set(key.toLowerCase(), String(value));
  return {
    get(name) {
      return normalized.get(String(name || "").toLowerCase()) || "";
    }
  };
}

function makeResponse(options = {}) {
  const body = options.body || "";
  const bytes = options.bytes || new TextEncoder().encode(body);
  const status = options.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(options.headers || {}),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return body;
    }
  };
}

async function startDetection(api, tabId = 1) {
  const response = await api.dispatchRuntimeMessage({ type: "OVC_START_DETECTION", tabId });
  assert.equal(response.ok, true);
  return response;
}

test("generated manifests use the shared core and no monkey-patch wrapper", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.deepEqual(packageExtension.firefoxBackgroundScripts(), ["src/media-utils.js", "background/core.js", "background/service-worker.js"]);
  assert.deepEqual(packageExtension.firefoxManifestFor(manifest).background.scripts, packageExtension.firefoxBackgroundScripts());
  assert.equal(fs.existsSync(path.join(root, "background", "service-worker-detection-fixes.js")), false);
});

test("content bridge accepts only bounded JSON string page hints", () => {
  const context = {
    baseUrl: "https://page.example/watch",
    pageUrl: "https://page.example/watch?token=secret",
    pageTitle: "Example"
  };
  const accepted = contentCore.parsePageCandidatePayload(JSON.stringify({
    url: "/media/video.mp4",
    source: "fetch",
    label: "fetch",
    requestType: "fetch",
    mimeType: "video/mp4",
    force: true
  }), context);
  assert.equal(accepted.url, "https://page.example/media/video.mp4");
  assert.equal(accepted.lowConfidence, true);
  assert.equal(accepted.untrustedPageHint, true);

  assert.equal(contentCore.parsePageCandidatePayload({ url: "https://cdn.example/video.mp4" }, context), null);
  assert.equal(contentCore.parsePageCandidatePayload(JSON.stringify({ url: "file:///tmp/video.mp4" }), context), null);
  assert.equal(contentCore.parsePageCandidatePayload(JSON.stringify({ url: "https://cdn.example/video.mp4", unknown: true }), context), null);
  assert.equal(contentCore.parsePageCandidatePayload(JSON.stringify({ url: `https://cdn.example/${"x".repeat(5000)}.mp4` }), context), null);
  assert.equal(contentCore.parsePageCandidatePayload("x".repeat(contentCore.LIMITS.maxEventPayloadBytes + 1), context), null);
});

test("forged or unobserved page candidates cannot trigger privileged fetch", async () => {
  const api = createFakeApi();
  const fetchCalls = [];
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return makeResponse({ bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) });
    }
  });
  await startDetection(api, 7);

  const response = await api.dispatchRuntimeMessage({
    type: "OVC_MEDIA_FOUND_BATCH",
    tabId: 999,
    items: [{
      url: "https://attacker.example/videoplayback?id=1",
      source: "page-fetch",
      requestType: "fetch",
      force: true,
      sniff: true,
      lowConfidence: true,
      untrustedPageHint: true
    }]
  }, { tab: { id: 7 } });
  await delay(10);

  assert.equal(response.ok, true);
  assert.equal(response.recorded, 0);
  assert.equal(fetchCalls.length, 0);
  const diagnostics = (await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 7 })).diagnostics;
  assert.equal(diagnostics.limits.unobservedSniffDrops, 1);
});

test("tab senders cannot invoke popup-only privileged commands", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => makeResponse()
  });

  const response = await api.dispatchRuntimeMessage(
    { type: "OVC_START_DETECTION", tabId: 7 },
    { id: api.runtime.id, tab: { id: 7 }, url: "https://attacker.example/" }
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /extension page/i);
  assert.equal(api.executedScripts.length, 0);

  const extensionTabResponse = await api.dispatchRuntimeMessage(
    { type: "OVC_START_DETECTION", tabId: 7 },
    { id: api.runtime.id, tab: { id: 99 }, url: api.runtime.getURL("popup/popup.html") }
  );
  assert.equal(extensionTabResponse.ok, true);
  assert.ok(api.executedScripts.length > 0);
});

test("download commands reject untrusted hints and private-network URLs", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({ api, utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 29);

  await api.dispatchRuntimeMessage({
    type: "OVC_MEDIA_FOUND_BATCH",
    items: [{ url: "https://cdn.example/untrusted.mp4", source: "dom-media", requestType: "video" }]
  }, { id: api.runtime.id, tab: { id: 29 }, url: "https://page.example/watch" });
  let payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 29 });
  let response = await api.dispatchRuntimeMessage({ type: "OVC_DOWNLOAD", tabId: 29, id: payload.items[0].id });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "UNTRUSTED_MEDIA");

  api.webRequest.onBeforeRequest.emit({ tabId: 29, url: "http://127.0.0.1/private.mp4", type: "media" });
  await delay(20);
  payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 29 });
  const privateItem = payload.items.find((item) => item.url.includes("127.0.0.1"));
  assert.equal(privateItem.downloadable, false);
  response = await api.dispatchRuntimeMessage({ type: "OVC_DOWNLOAD", tabId: 29, id: privateItem.id });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "URL_POLICY");
  assert.equal(api.downloadsStarted.length, 0);
});

test("content hints stay non-downloadable until the same tab observes the URL", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => makeResponse()
  });
  await startDetection(api, 18);

  await api.dispatchRuntimeMessage({
    type: "OVC_MEDIA_FOUND_BATCH",
    items: [{ url: "https://cdn.example/movie.mp4", source: "dom-media", requestType: "video" }]
  }, { id: api.runtime.id, tab: { id: 18 }, url: "https://page.example/watch" });

  let payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 18 });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].lowConfidence, true);
  assert.equal(payload.items[0].downloadable, false);

  api.webRequest.onBeforeRequest.emit({
    tabId: 18,
    url: "https://cdn.example/movie.mp4",
    type: "media"
  });
  await delay(20);

  payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 18 });
  assert.equal(payload.items[0].lowConfidence, false);
  assert.equal(payload.items[0].downloadable, true);
});

test("later untrusted page hints cannot demote a trusted network observation", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({ api, utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 19);

  api.webRequest.onBeforeRequest.emit({
    tabId: 19,
    url: "https://cdn.example/trusted/movie.mp4?token=secret",
    type: "media"
  });
  await delay(20);
  await api.dispatchRuntimeMessage({
    type: "OVC_MEDIA_FOUND_BATCH",
    items: [{ url: "https://cdn.example/trusted/movie.mp4?token=secret", source: "page-fetch", requestType: "fetch" }]
  }, { id: api.runtime.id, tab: { id: 19 }, url: "https://page.example/watch" });

  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 19 });
  assert.equal(payload.items[0].lowConfidence, false);
  assert.equal(payload.items[0].downloadable, true);
});

test("observed same-tab network candidates are sniffed with fail-closed fetch options", async () => {
  const api = createFakeApi();
  const fetchCalls = [];
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return makeResponse({
        headers: { "content-type": "application/octet-stream" },
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      });
    }
  });
  await startDetection(api, 3);

  api.webRequest.onBeforeRequest.emit({
    tabId: 3,
    url: "https://cdn.example/videoplayback?id=observed",
    type: "xmlhttprequest"
  });
  await delay(25);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.credentials, "omit");
  assert.equal(fetchCalls[0].options.redirect, "error");
  assert.equal(fetchCalls[0].options.referrerPolicy, "no-referrer");
  assert.equal(fetchCalls[0].options.headers.Range, "bytes=0-16383");
  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 3 });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].kind, "video");
});

test("privileged fetch policy rejects local, private, credentialed, and non-http URLs", () => {
  for (const url of [
    "http://localhost/video",
    "http://127.0.0.1/video",
    "http://10.0.0.7/video",
    "http://172.16.0.7/video",
    "http://192.168.1.7/video",
    "http://169.254.1.7/video",
    "http://[::1]/video",
    "http://[fc00::1]/video",
    "http://[fe80::1]/video",
    "http://[::ffff:127.0.0.1]/video",
    "https://user:pass@example.com/video",
    "ftp://example.com/video"
  ]) {
    assert.equal(backgroundCore.validatePrivilegedFetchUrl(url).ok, false, url);
  }
  assert.equal(backgroundCore.validatePrivilegedFetchUrl("https://cdn.example/video").ok, true);
});

test("header observations are scoped to active capture and tab id", async () => {
  const api = createFakeApi();
  const fetchCalls = [];
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return makeResponse({
        headers: { "content-type": "application/octet-stream" },
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      });
    }
  });
  await startDetection(api, 1);

  api.webRequest.onHeadersReceived.emit({
    tabId: 2,
    url: "https://cdn.example/media?id=same-url",
    type: "xmlhttprequest",
    statusCode: 206,
    responseHeaders: [
      { name: "content-type", value: "application/octet-stream" },
      { name: "content-range", value: "bytes 0-99/500000" }
    ]
  });
  await api.dispatchRuntimeMessage({
    type: "OVC_MEDIA_FOUND_BATCH",
    items: [{ url: "https://cdn.example/media?id=same-url", requestType: "fetch", sniff: true }]
  }, { tab: { id: 1 } });
  await delay(10);
  assert.equal(fetchCalls.length, 0);

  api.webRequest.onHeadersReceived.emit({
    tabId: 1,
    url: "https://cdn.example/media?id=same-url",
    type: "xmlhttprequest",
    statusCode: 206,
    responseHeaders: [
      { name: "content-type", value: "application/octet-stream" },
      { name: "content-range", value: "bytes 0-99/500000" }
    ]
  });
  await delay(25);
  assert.equal(fetchCalls.length, 1);
});

test("session storage restores active capture and bounded media after worker restart", async () => {
  const session = {};
  let currentTime = Date.now();
  const now = () => currentTime;
  const firstApi = createFakeApi(session);
  backgroundCore.installBackground({
    api: firstApi,
    utils,
    now,
    fetchImpl: async () => makeResponse()
  });
  await startDetection(firstApi, 5);
  firstApi.webRequest.onBeforeRequest.emit({
    tabId: 5,
    url: "https://cdn.example/movie.mp4",
    type: "media"
  });
  await delay(20);
  assert.ok(session[backgroundCore.SESSION_KEY], "state persisted to chrome.storage.session");

  const secondApi = createFakeApi(session);
  const fetchCalls = [];
  backgroundCore.installBackground({
    api: secondApi,
    utils,
    now,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return makeResponse({
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      });
    }
  });
  const restored = await secondApi.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 5 });
  assert.equal(restored.captureActive, true);
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0].url, "https://cdn.example/movie.mp4");

  secondApi.webRequest.onBeforeRequest.emit({
    tabId: 5,
    url: "https://cdn.example/videoplayback?id=after-restart",
    type: "xmlhttprequest"
  });
  await delay(25);
  assert.equal(fetchCalls.length, 1);
  currentTime += 91000;
  secondApi.alarms.onAlarm.emit({ name: backgroundCore.CLEANUP_ALARM });
  await delay(10);
  assert.equal(secondApi.tabMessages.some((entry) => entry.message.type === "OVC_CAPTURE_STOP"), true);
});

test("expired captures purge full media URLs from session storage", async () => {
  const session = {};
  let currentTime = Date.now();
  const api = createFakeApi(session);
  const core = backgroundCore.installBackground({
    api,
    utils,
    now: () => currentTime,
    fetchImpl: async () => makeResponse()
  });
  await startDetection(api, 15);
  api.webRequest.onBeforeRequest.emit({
    tabId: 15,
    url: "https://cdn.example/private/movie.mp4?token=secret",
    type: "media"
  });
  await delay(20);
  assert.match(JSON.stringify(session[backgroundCore.SESSION_KEY]), /token=secret/);

  currentTime += 91000;
  await core.cleanupExpired();
  await core.persistNow();

  const serialized = JSON.stringify(session[backgroundCore.SESSION_KEY]);
  assert.doesNotMatch(serialized, /token=secret/);
  assert.equal(session[backgroundCore.SESSION_KEY].tabs["15"], undefined);
});

test("each active tab gets an independent capture-expiry alarm", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => makeResponse()
  });

  await startDetection(api, 21);
  await startDetection(api, 22);

  const oneShotAlarms = api.alarmsCreated.filter((entry) => Number.isFinite(entry.info?.when));
  assert.equal(oneShotAlarms.length, 2);
  assert.equal(new Set(oneShotAlarms.map((entry) => entry.name)).size, 2);
});

test("candidate rate, batch, and playlist body limits are exposed in diagnostics", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => makeResponse({
      headers: { "content-length": String(backgroundCore.LIMITS.maxPlaylistBytes + 1) },
      body: "#EXTM3U\n"
    })
  });
  await startDetection(api, 8);

  const noisyItems = Array.from({ length: 20 }, (_, index) => ({
    url: `https://cdn.example/videoplayback?id=${index}`,
    source: "page-fetch",
    requestType: "fetch",
    sniff: true
  }));
  await api.dispatchRuntimeMessage({ type: "OVC_MEDIA_FOUND_BATCH", items: noisyItems }, { tab: { id: 8 } });

  const overBatchItems = Array.from({ length: backgroundCore.LIMITS.maxBatchItems + 5 }, (_, index) => ({
    url: `https://cdn.example/video${index}.mp4`,
    source: "dom-link"
  }));
  await api.dispatchRuntimeMessage({ type: "OVC_MEDIA_FOUND_BATCH", items: overBatchItems }, { tab: { id: 8 } });

  api.webRequest.onBeforeRequest.emit({
    tabId: 8,
    url: "https://cdn.example/live/master.m3u8",
    type: "xmlhttprequest"
  });
  await delay(25);

  const beforeAnalysis = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 8 });
  const playlist = beforeAnalysis.items.find((item) => item.kind === "hls-playlist");
  const analysisResponse = await api.dispatchRuntimeMessage({
    type: "OVC_ANALYZE_PLAYLIST",
    tabId: 8,
    id: playlist.id
  });
  assert.equal(analysisResponse.ok, false);

  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 8 });
  assert.ok(payload.diagnostics.limits.pageRateDrops > 0);
  assert.equal(payload.diagnostics.limits.batchDrops, 5);
  assert.equal(payload.diagnostics.limits.bodyLimitDrops, 1);
});

test("playlist analysis runs only after an extension-page request", async () => {
  const api = createFakeApi();
  const fetchCalls = [];
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return makeResponse({
        headers: { "content-type": "application/vnd.apple.mpegurl" },
        body: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n"
      });
    }
  });
  await startDetection(api, 25);
  api.webRequest.onBeforeRequest.emit({
    tabId: 25,
    url: "https://cdn.example/live/master.m3u8",
    type: "xmlhttprequest"
  });
  await delay(20);
  assert.equal(fetchCalls.length, 0);

  const before = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 25 });
  const response = await api.dispatchRuntimeMessage({
    type: "OVC_ANALYZE_PLAYLIST",
    tabId: 25,
    id: before.items[0].id
  });
  assert.equal(response.ok, true);
  assert.equal(fetchCalls.length, 1);
});

test("playlist authentication failures return a stable non-secret error code", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => makeResponse({ status: 403 })
  });
  await startDetection(api, 26);
  api.webRequest.onBeforeRequest.emit({
    tabId: 26,
    url: "https://cdn.example/private/master.m3u8?token=secret",
    type: "xmlhttprequest"
  });
  await delay(20);
  const before = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 26 });
  const response = await api.dispatchRuntimeMessage({
    type: "OVC_ANALYZE_PLAYLIST",
    tabId: 26,
    id: before.items[0].id
  });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "AUTH_REQUIRED");
  assert.match(response.error, /인증|로그인/);
  assert.doesNotMatch(JSON.stringify({ error: response.error, errorCode: response.errorCode, status: response.status }), /token=secret/);
});

test("playlist analysis has a per-capture total request budget", async () => {
  const api = createFakeApi();
  let fetchCount = 0;
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => {
      fetchCount += 1;
      return makeResponse({ body: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n" });
    }
  });
  await startDetection(api, 27);
  api.webRequest.onBeforeRequest.emit({
    tabId: 27,
    url: "https://cdn.example/live/bounded.m3u8",
    type: "xmlhttprequest"
  });
  await delay(20);
  const before = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 27 });
  const itemId = before.items[0].id;
  for (let index = 0; index < backgroundCore.LIMITS.maxPlaylistAnalysesPerTab; index += 1) {
    const result = await api.dispatchRuntimeMessage({ type: "OVC_ANALYZE_PLAYLIST", tabId: 27, id: itemId });
    assert.equal(result.ok, true);
  }
  const blocked = await api.dispatchRuntimeMessage({ type: "OVC_ANALYZE_PLAYLIST", tabId: 27, id: itemId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, "ANALYSIS_LIMIT");
  assert.equal(fetchCount, backgroundCore.LIMITS.maxPlaylistAnalysesPerTab);
  assert.equal(blocked.items[0].detectionCount, 1);
});

test("global and per-tab privileged fetch concurrency is bounded", async () => {
  const api = createFakeApi();
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const resolvers = [];
  backgroundCore.installBackground({
    api,
    utils,
    fetchImpl: async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => resolvers.push(resolve));
      active -= 1;
      return makeResponse({
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      });
    }
  });
  await startDetection(api, 9);
  for (let index = 0; index < 8; index += 1) {
    api.webRequest.onBeforeRequest.emit({
      tabId: 9,
      url: `https://cdn.example/videoplayback?id=${index}`,
      type: "xmlhttprequest"
    });
  }
  await delay(25);
  assert.equal(maxActive, backgroundCore.LIMITS.maxFetchesPerTab);
  for (let round = 0; round < 10 && (started < 8 || active > 0 || resolvers.length > 0); round += 1) {
    while (resolvers.length) resolvers.shift()();
    await delay(10);
  }
  assert.equal(started, 8);
});

test("page hook auto-starts a bounded capture, emits JSON strings, and restores safely", async () => {
  const source = fs.readFileSync(path.join(root, "page", "page-hook.js"), "utf8");
  const emitted = [];
  const listeners = new Map();
  const timers = [];
  const originalFetch = async () => ({
    url: "https://cdn.example/video.mp4",
    headers: { get: () => "video/mp4" }
  });
  function FakeXHR() {}
  FakeXHR.prototype.open = function open() {};
  const originalCreateObjectURL = () => "blob:https://page.example/id";
  const sandbox = {
    Date,
    Promise,
    TextEncoder,
    document: { baseURI: "https://page.example/watch" },
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout(callback, delayMs) {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    clearTimeout() {},
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
  };
  sandbox.window = {
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener));
    },
    dispatchEvent(event) {
      if (event.type === "__OVC_MEDIA_CANDIDATE") emitted.push(event.detail);
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
    }
  };
  sandbox.URL = class TestURL extends URL {};
  sandbox.URL.createObjectURL = originalCreateObjectURL;
  sandbox.XMLHttpRequest = FakeXHR;

  vm.runInNewContext(source, sandbox, { filename: "page/page-hook.js" });
  assert.notEqual(sandbox.window.fetch, originalFetch);
  const activeWrapper = sandbox.window.fetch;
  const initialTimerCount = timers.length;
  vm.runInNewContext(source, sandbox, { filename: "page/page-hook.js" });
  assert.equal(sandbox.window.fetch, activeWrapper);
  assert.ok(timers.length > initialTimerCount);
  assert.doesNotMatch(source, /__OVC_CAPTURE_START/);
  assert.ok(timers[0].delayMs <= 90500);
  await sandbox.window.fetch("https://cdn.example/video.mp4");
  assert.equal(typeof emitted[0], "string");
  assert.equal(JSON.parse(emitted[0]).url, "https://cdn.example/video.mp4");

  const externalWrapper = async () => ({ url: "", headers: { get: () => "" } });
  sandbox.window.fetch = externalWrapper;
  sandbox.window.dispatchEvent(new sandbox.CustomEvent("__OVC_CAPTURE_STOP", { detail: "" }));
  assert.equal(sandbox.window.fetch, externalWrapper);

  sandbox.window.dispatchEvent(new sandbox.CustomEvent("__OVC_CAPTURE_START", { detail: "{}" }));
  assert.equal(sandbox.window.fetch, externalWrapper);
  vm.runInNewContext(source, sandbox, { filename: "page/page-hook.js" });
  assert.notEqual(sandbox.window.fetch, externalWrapper);
  timers.at(-1).callback();
  assert.equal(sandbox.window.fetch, externalWrapper);
});

test("callback-only WebExtension APIs execute each side effect exactly once", async () => {
  const api = createFakeApi();
  api.scripting.executeScript = (details, callback) => {
    api.executedScripts.push(details);
    callback([{ frameId: 0 }]);
  };
  api.tabs.sendMessage = (tabId, message, callback) => {
    api.tabMessages.push({ tabId, message });
    callback({ ok: true });
  };
  api.permissions.contains = (_query, callback) => callback(true);
  backgroundCore.installBackground({ api, apiMode: "callback", utils, fetchImpl: async () => makeResponse() });

  const response = await api.dispatchRuntimeMessage({ type: "OVC_START_DETECTION", tabId: 41 });
  assert.equal(response.ok, true);
  assert.equal(api.executedScripts.length, 4);
  assert.equal(api.tabMessages.filter(({ message }) => message.type === "OVC_SCAN_NOW").length, 1);
});

test("promise-only Firefox downloads resolve without a callback", async () => {
  const api = createFakeApi();
  api.downloads.download = function promiseDownload(details) {
    assert.equal(arguments.length, 1);
    api.downloadsStarted.push(details);
    return Promise.resolve(73);
  };
  backgroundCore.installBackground({ api, apiMode: "promise", utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 42);
  api.webRequest.onBeforeRequest.emit({ tabId: 42, requestId: "download-1", url: "https://cdn.example/movie.mp4", type: "media" });
  await delay(20);
  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 42 });
  const response = await api.dispatchRuntimeMessage({ type: "OVC_DOWNLOAD", tabId: 42, id: payload.items[0].id });
  assert.equal(response.ok, true);
  assert.equal(response.downloadId, 73);
  assert.equal(api.downloadsStarted.length, 1);
});

test("weaker observations cannot erase trusted network metadata", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({ api, utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 43);
  const details = { tabId: 43, url: "https://cdn.example/videoplayback", type: "media", statusCode: 200 };
  api.webRequest.onHeadersReceived.emit(Object.assign({}, details, {
    requestId: "meta-1",
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Disposition", value: "attachment; filename=movie.mp4" }
    ]
  }));
  await delay(20);
  api.webRequest.onBeforeRequest.emit(Object.assign({}, details, { requestId: "meta-2" }));
  await delay(20);
  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 43 });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].kind, "video");
  assert.equal(payload.items[0].mimeType, "video/mp4");
  assert.equal(payload.items[0].fileName, "movie.mp4");
});

test("page-controlled MIME cannot replace a trusted network classification", async () => {
  const api = createFakeApi();
  backgroundCore.installBackground({ api, utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 44);
  const url = "https://cdn.example/master.m3u8";
  api.webRequest.onHeadersReceived.emit({
    tabId: 44,
    requestId: "hls-1",
    url,
    type: "xmlhttprequest",
    statusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }]
  });
  await delay(20);
  await api.dispatchRuntimeMessage({
    type: "OVC_MEDIA_FOUND_BATCH",
    items: [{ url, source: "page-fetch", requestType: "fetch", mimeType: "video/mp4" }]
  }, { id: api.runtime.id, tab: { id: 44 }, url: "https://page.example/watch" });
  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 44 });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].kind, "hls-playlist");
  assert.equal(payload.items[0].mimeType, "application/vnd.apple.mpegurl");
  assert.equal(payload.items[0].downloadable, false);
});

test("privileged downloads require an active capture and fresh same-generation observation", async () => {
  let clock = 1000;
  const api = createFakeApi();
  backgroundCore.installBackground({ api, utils, now: () => clock, fetchImpl: async () => makeResponse() });
  await startDetection(api, 45);
  api.webRequest.onBeforeRequest.emit({ tabId: 45, requestId: "fresh-1", url: "https://cdn.example/movie.mp4", type: "media" });
  await delay(20);
  const payload = await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 45 });
  clock += backgroundCore.LIMITS.observationTtlMs + 1;
  let response = await api.dispatchRuntimeMessage({ type: "OVC_DOWNLOAD", tabId: 45, id: payload.items[0].id });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "OBSERVATION_EXPIRED");
  clock += 100000;
  response = await api.dispatchRuntimeMessage({ type: "OVC_DOWNLOAD", tabId: 45, id: payload.items[0].id });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "CAPTURE_INACTIVE");
  assert.equal(api.downloadsStarted.length, 0);
});

test("late fetch results from an old capture generation cannot mutate a replacement capture", async () => {
  const api = createFakeApi();
  let resolveFetch;
  backgroundCore.installBackground({ api, utils, fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  await startDetection(api, 46);
  api.webRequest.onHeadersReceived.emit({
    tabId: 46, requestId: "old-1", url: "https://cdn.example/videoplayback?id=old", type: "xmlhttprequest", statusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/octet-stream" }]
  });
  await delay(10);
  await startDetection(api, 46);
  resolveFetch(makeResponse({ bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) }));
  await delay(30);
  assert.equal((await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 46 })).items.some((item) => item.url.includes("id=old")), false);
});

test("one webRequest requestId consumes at most one sniff attempt", async () => {
  const api = createFakeApi();
  const fetchCalls = [];
  backgroundCore.installBackground({ api, utils, fetchImpl: async (...args) => {
    fetchCalls.push(args);
    return makeResponse({ headers: { "content-type": "application/octet-stream" }, bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]) });
  } });
  await startDetection(api, 47);
  const details = { tabId: 47, requestId: "paired-1", url: "https://cdn.example/videoplayback?id=paired", type: "xmlhttprequest", statusCode: 200 };
  api.webRequest.onBeforeRequest.emit(details);
  api.webRequest.onHeadersReceived.emit(Object.assign({}, details, { responseHeaders: [{ name: "Content-Type", value: "application/octet-stream" }] }));
  await delay(40);
  assert.equal(fetchCalls.length, 1);
  assert.equal((await api.dispatchRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: 47 })).diagnostics.sniffAttempts, 1);
});

test("privileged URL policy rejects all common special-use address ranges", () => {
  for (const url of [
    "http://100.64.0.1/media", "http://198.18.0.1/media", "http://224.0.0.1/media",
    "http://192.0.2.1/media", "http://example.local/media", "http://[fec0::1]/media", "http://[ff02::1]/media"
  ]) assert.equal(backgroundCore.validatePrivilegedFetchUrl(url).ok, false, url);
});

test("session persistence is byte-bounded even with many long signed URLs", async () => {
  const sessionStore = {};
  const api = createFakeApi(sessionStore);
  backgroundCore.installBackground({ api, utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 48);
  for (let index = 0; index < 180; index += 1) {
    api.webRequest.onBeforeRequest.emit({
      tabId: 48,
      requestId: `large-${index}`,
      url: `https://cdn.example/video-${index}.mp4?token=${"x".repeat(3000)}`,
      type: "media"
    });
  }
  await delay(150);
  const state = sessionStore[backgroundCore.SESSION_KEY];
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= backgroundCore.LIMITS.maxSessionBytes);
});

test("a failed state write triggers a best-effort empty-state purge", async () => {
  const sessionStore = {};
  const api = createFakeApi(sessionStore);
  sessionStore[backgroundCore.SESSION_KEY] = {
    version: 1,
    tabs: { 49: { captureUntil: Date.now() + 60000, items: [{ id: "secret", url: "https://cdn.example/video.mp4?token=secret" }] } }
  };
  let writes = 0;
  api.storage.session.set = async (value) => {
    writes += 1;
    if (writes === 1) throw new Error("quota");
    Object.assign(sessionStore, value);
  };
  backgroundCore.installBackground({ api, utils, fetchImpl: async () => makeResponse() });
  await startDetection(api, 49);
  await delay(40);
  assert.ok(writes >= 2);
  assert.doesNotMatch(JSON.stringify(sessionStore), /token=secret/);
});
