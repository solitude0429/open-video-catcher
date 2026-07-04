#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const runtimePaths = [
  "manifest.json",
  "icons",
  "src",
  "background",
  "content",
  "page",
  "popup",
  "LICENSE",
  "NOTICE"
];

fs.mkdirSync(dist, { recursive: true });

function copyRuntime(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const relative of runtimePaths) {
    fs.cpSync(path.join(root, relative), path.join(targetDir, relative), { recursive: true });
  }
}

function zipDirectory(sourceDir, zipPath) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  const entries = fs.readdirSync(sourceDir);
  const result = spawnSync("zip", ["-qr", zipPath, ...entries], {
    cwd: sourceDir,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

const chromeDir = path.join(dist, "build", "chrome-edge");
const firefoxDir = path.join(dist, "build", "firefox");
copyRuntime(chromeDir);
copyRuntime(firefoxDir);

const firefoxManifestPath = path.join(firefoxDir, "manifest.json");
const firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, "utf8"));
firefoxManifest.background = {
  scripts: ["src/media-utils.js", "background/service-worker.js"]
};
fs.writeFileSync(firefoxManifestPath, `${JSON.stringify(firefoxManifest, null, 2)}
`);

const chromeZip = path.join(dist, "open-video-catcher-chrome-edge.zip");
const firefoxZip = path.join(dist, "open-video-catcher-firefox.zip");
zipDirectory(chromeDir, chromeZip);
zipDirectory(firefoxDir, firefoxZip);

console.log(chromeZip);
console.log(firefoxZip);
