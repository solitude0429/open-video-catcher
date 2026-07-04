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
