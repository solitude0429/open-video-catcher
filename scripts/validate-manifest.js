#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const packagePath = path.join(root, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const errors = [];
const warnings = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function mustExist(relativePath) {
  assert(fs.existsSync(path.join(root, relativePath)), `${relativePath} must exist`);
}

assert(manifest.manifest_version === 3, "manifest_version must be 3");
assert(typeof manifest.name === "string" && manifest.name.length > 0, "name is required");
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "version must be SemVer-like x.y.z");
assert(manifest.version === pkg.version, "manifest.version must match package.json version");
assert(manifest.background?.service_worker, "background.service_worker is required for Chrome/Edge source build");
assert(Array.isArray(manifest.permissions), "permissions must be an array");
assert(!manifest.permissions.includes("cookies"), "cookies permission is intentionally forbidden");
assert(!manifest.permissions.includes("debugger"), "debugger permission is intentionally forbidden");
assert(!manifest.permissions.includes("declarativeNetRequest"), "static request rewriting is intentionally not used");
assert(manifest.permissions.includes("downloads"), "downloads permission is required");
assert(manifest.permissions.includes("activeTab"), "activeTab permission is required for click-initiated active-tab detection");
assert(manifest.permissions.includes("scripting"), "scripting permission is required for click-initiated content script injection");
assert(manifest.permissions.includes("webRequest"), "webRequest permission is required for media detection");
assert(!manifest.content_scripts, "content_scripts must not auto-run; detection is click-initiated only");
assert(Array.isArray(manifest.host_permissions), "host_permissions must be an array");
if (manifest.host_permissions?.includes("<all_urls>")) {
  warnings.push("Uses <all_urls> so it can detect media on arbitrary sites; keep this visible in README.");
}

for (const [size, iconPath] of Object.entries(manifest.icons || {})) {
  assert(/^\d+$/.test(size), `icon key ${size} must be numeric`);
  mustExist(iconPath);
}
for (const iconPath of Object.values(manifest.action?.default_icon || {})) {
  mustExist(iconPath);
}

const gecko = manifest.browser_specific_settings?.gecko;
assert(gecko?.id, "Firefox gecko.id is required");
assert(gecko?.id === "open-video-catcher@solitude0429.github.io", "Firefox gecko.id must stay stable");
assert(/^https:\/\//.test(gecko?.update_url || ""), "Firefox update_url must be HTTPS for self-hosted updates");
assert(gecko?.data_collection_permissions?.required?.includes("none"), "Firefox data_collection_permissions.required must include none");

for (const script of manifest.content_scripts || []) {
  assert(script.js?.[0] === "src/media-utils.js", "content script must load shared utilities first");
}

const resources = manifest.web_accessible_resources || [];
assert(resources.some((entry) => (entry.resources || []).includes("page/page-hook.js")), "page/page-hook.js must be web-accessible for page-world fetch/XHR hooks");

function scanForRemoteScripts(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const remoteScript = /<script[^>]+src=["']https?:\/\//i.test(text);
  assert(!remoteScript, `${path.relative(root, filePath)} must not load remote scripts`);
}

scanForRemoteScripts(path.join(root, "popup", "popup.html"));

if (warnings.length) console.warn(warnings.map((warning) => `WARN: ${warning}`).join("\n"));
if (errors.length) {
  console.error(errors.map((error) => `ERROR: ${error}`).join("\n"));
  process.exit(1);
}
console.log("manifest validation passed");
