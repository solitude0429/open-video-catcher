const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("manifest uses click-initiated detection permissions instead of automatic content scripts", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("webRequest"));
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
});

test("content script does not inject page hook until scan message arms capture", () => {
  const source = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  assert.match(source, /message\?\.type === "OVC_SCAN_NOW"/);
  assert.match(source, /function armCapture/);
  assert.doesNotMatch(source, /\n\s*injectPageHook\(\);\n\s*document\.addEventListener\("loadedmetadata"/);
});

test("background filters network and page candidates behind active tab capture", () => {
  const source = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");
  assert.match(source, /captureUntilByTab/);
  assert.match(source, /OVC_START_DETECTION/);
  assert.match(source, /function recordRawMedia[\s\S]*!isCaptureActive\(tabId\)/);
  assert.match(source, /function recordFromRequest[\s\S]*!isCaptureActive\(details\.tabId\)/);
});

test("background injects page hook in the main world and exposes diagnostics", () => {
  const source = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");
  assert.match(source, /function createDiagnostics/);
  assert.match(source, /networkSeen/);
  assert.match(source, /pageCandidatesSeen/);
  assert.match(source, /function injectPageHookMainWorld/);
  assert.match(source, /world:\s*"MAIN"/);
  assert.match(source, /diagnostics: diag/);
  assert.match(source, /api\.permissions\.contains\(\{ origins: \["<all_urls>"\] \}/);
});

test("background prefers promise-style extension APIs so detection start cannot hang", () => {
  const source = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");
  assert.match(source, /function extensionApiCall\(promiseInvoke, callbackInvoke/);
  assert.match(source, /const result = promiseInvoke\(\)/);
  assert.match(source, /\(\) => api\.scripting\.executeScript\(details\),\s*\(done\) => api\.scripting\.executeScript\(details, done\)/);
  assert.match(source, /\(\) => api\.tabs\.sendMessage\(tabId, message\),\s*\(done\) => api\.tabs\.sendMessage\(tabId, message, done\)/);
});

test("popup also uses promise-style extension APIs for tab query and runtime messages", () => {
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(source, /function extensionApiCall\(promiseInvoke, callbackInvoke/);
  assert.match(source, /\(\) => chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\),\s*\(done\) => chrome\.tabs\.query\(\{ active: true, currentWindow: true \}, done\)/);
  assert.match(source, /\(\) => chrome\.runtime\.sendMessage\(message\),\s*\(done\) => chrome\.runtime\.sendMessage\(message, done\)/);
});

test("popup renders empty-state diagnostics", () => {
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(source, /function diagnosticText/);
  assert.match(source, /site access=/);
  assert.match(source, /pageCandidatesSeen/);
  assert.match(source, /networkSeen/);
  assert.match(source, /className = "diagnostics"/);
});

test("manual capture forwards extensionless page candidates for background sniffing", () => {
  const source = fs.readFileSync(path.join(root, "content", "content-script.js"), "utf8");
  assert.match(source, /keepUnclassified/);
  assert.match(source, /sniff: true/);
  assert.match(source, /collectPerformanceCandidates/);
});

test("background sniffs unclassified manual-capture candidates", () => {
  const source = fs.readFileSync(path.join(root, "background", "service-worker.js"), "utf8");
  assert.match(source, /function sniffAndRecordCandidate/);
  assert.match(source, /Range": "bytes=0-16383"/);
  assert.match(source, /sniffedText/);
  assert.match(source, /sniffRecorded/);
});
