const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const contentCore = require("../content/content-core.js");

const root = path.resolve(__dirname, "..");

test("manifest uses click-initiated detection permissions instead of automatic content scripts", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("webRequest"));
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
});

test("content script arms a bounded capture only after the background scan command", () => {
  const source = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  assert.match(source, /message\?\.type === "OVC_SCAN_NOW"/);
  assert.match(source, /function armCapture/);
  assert.match(source, /Math\.min\(CAPTURE_DEFAULT_MS/);
  assert.doesNotMatch(source, /injectPageHook|__OVC_CAPTURE_START/);
});

test("background filters network and page candidates behind active tab capture", () => {
  const source = fs.readFileSync(path.join(root, "background", "core.js"), "utf8");
  assert.match(source, /captureUntilByTab/);
  assert.match(source, /OVC_START_DETECTION/);
  assert.match(source, /function recordRawMedia[\s\S]*await isCaptureActive\(tabId\)/);
  assert.match(source, /function recordFromRequest[\s\S]*await isCaptureActive\(details\.tabId\)/);
});

test("background injects page hook in the main world and exposes diagnostics", () => {
  const source = fs.readFileSync(path.join(root, "background", "core.js"), "utf8");
  assert.match(source, /function createDiagnostics/);
  assert.match(source, /networkSeen/);
  assert.match(source, /pageCandidatesSeen/);
  assert.match(source, /function injectPageHookMainWorld/);
  assert.match(source, /world:\s*"MAIN"/);
  assert.match(source, /diagnostics: diag/);
  assert.match(source, /api\.permissions\.contains\(\{ origins: \["<all_urls>"\] \}/);
});

test("page hook is injected only by the extension MAIN-world API", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const contentSource = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  const backgroundSource = fs.readFileSync(path.join(root, "background", "core.js"), "utf8");
  const resources = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
  assert.equal(resources.includes("page/page-hook.js"), false);
  assert.doesNotMatch(contentSource, /createElement\(["']script["']\)|injectPageHook/);
  assert.match(backgroundSource, /world:\s*["']MAIN["']/);
});

test("content capture scans each changed subtree once instead of rescanning the document", () => {
  const source = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  assert.match(source, /for \(const child of element\.querySelectorAll\(TARGET_SELECTOR\)\) collectElement\(child, out\)/);
  assert.doesNotMatch(source, /for \(const child of element\.querySelectorAll\([^)]*\)\)\s*\{?\s*collectFromNode\(child/);
  assert.match(source, /function scanEventTarget/);
  assert.doesNotMatch(source, /addEventListener\(["'](?:loadedmetadata|play|loadstart)["'], scheduleScan/);
});

test("background dispatches promise and callback APIs exactly once", () => {
  const source = fs.readFileSync(path.join(root, "background", "core.js"), "utf8");
  assert.match(source, /function extensionApiCall\(api, apiMode, promiseInvoke, callbackInvoke/);
  assert.match(source, /if \(apiMode === "callback"\)/);
  assert.match(source, /const result = promiseInvoke\(\)/);
  assert.match(source, /\(\) => api\.scripting\.executeScript\(details\),\s*\(done\) => api\.scripting\.executeScript\(details, done\)/);
  assert.match(source, /\(\) => api\.tabs\.sendMessage\(tabId, message\),\s*\(done\) => api\.tabs\.sendMessage\(tabId, message, done\)/);
});

test("service worker is a thin adapter that installs the shared core", () => {
  const source = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");
  assert.match(source, /importScripts\("core\.js"\)/);
  assert.match(source, /core\.installBackground\(\{ api, apiMode, utils \}\)/);
  assert.doesNotMatch(source, /onHeadersReceived\.addListener/);
  assert.doesNotMatch(source, /createMediaItem\s*=/);
});

test("popup selects the Firefox browser namespace and dispatches APIs exactly once", () => {
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(source, /globalThis\.browser \|\| globalThis\.chrome/);
  assert.match(source, /function extensionApiCall\(promiseInvoke, callbackInvoke/);
  assert.match(source, /\(\) => extensionApi\.tabs\.query\(\{ active: true, currentWindow: true \}\),\s*\(done\) => extensionApi\.tabs\.query\(\{ active: true, currentWindow: true \}, done\)/);
  assert.match(source, /\(\) => extensionApi\.runtime\.sendMessage\(message\),\s*\(done\) => extensionApi\.runtime\.sendMessage\(message, done\)/);
});

test("popup renders empty-state diagnostics", () => {
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(source, /function diagnosticText/);
  assert.match(source, /site access=/);
  assert.match(source, /pageCandidatesSeen/);
  assert.match(source, /networkSeen/);
  assert.match(source, /className = "diagnostics"/);
});

test("popup exposes explicit POSIX and PowerShell command generation", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(html, /id="commandShell"/);
  assert.match(html, /value="posix"/);
  assert.match(html, /value="powershell"/);
  assert.match(source, /utils\.ffmpegPlan\(item, \{ shell: commandShell\.value \}\)/);
  assert.match(source, /utils\.curlCommand\(item\.url, item\.fileName, \{ shell: commandShell\.value \}\)/);
  assert.match(source, /utils\.ytDlpCommand\([\s\S]*\{ shell: commandShell\.value \}\)/);
  assert.match(html, /브라우저 로그인 쿠키[^<]*포함되지 않습니다/);
});

test("popup keeps media URLs behind an explicit disclosure by default", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  assert.match(html, /<details class="urlDisclosure">[\s\S]*<summary>URL 표시<\/summary>[\s\S]*class="url"[\s\S]*<\/details>/);
});

test("popup distinguishes detections, enrichment, and classification conflicts", () => {
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(source, /item\.detectionCount/);
  assert.match(source, /item\.enrichmentCount/);
  assert.match(source, /item\.classificationConflict/);
});

test("manual capture forwards extensionless page candidates for background sniffing", () => {
  const source = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  assert.match(source, /keepUnclassified/);
  assert.match(source, /sniff: true/);
  assert.match(source, /collectPerformanceCandidates/);
});

test("background sniffs unclassified manual-capture candidates", () => {
  const source = fs.readFileSync(path.join(root, "background", "core.js"), "utf8");
  assert.match(source, /function sniffAndRecordCandidate/);
  assert.match(source, /Range: "bytes=0-16383"/);
  assert.match(source, /sniffedText/);
  assert.match(source, /sniffRecorded/);
});

test("content batching skips an oversized first item instead of dropping later valid candidates", () => {
  const bounded = contentCore.boundBatch([
    { url: "https://cdn.example/oversized.mp4", pageTitle: "x".repeat(contentCore.LIMITS.maxBatchPayloadBytes) },
    { url: "https://cdn.example/valid.mp4", pageTitle: "valid" }
  ]);
  assert.deepEqual(bounded.map((item) => item.url), ["https://cdn.example/valid.mp4"]);
});

test("DOM and MAIN-world extension lists include AVI", () => {
  const contentSource = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  const pageSource = fs.readFileSync(path.join(root, "page", "page-hook.js"), "utf8");
  assert.match(contentSource, /\bavi\b/);
  assert.match(pageSource, /\bavi\b/);
});

test("popup preserves visible state on errors, confirms browser downloads, and updates countdown without rerendering", () => {
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /if \(!response\.ok \|\| !payload\.ok\)/);
  assert.match(source, /setInterval\(\(\) => \{\s*if \(captureUntil\) updateNotice\(\)/);
  assert.doesNotMatch(source, /setInterval\(\(\) => \{\s*if \(captureUntil\) render\(\)/);
});
