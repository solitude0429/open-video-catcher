#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { zipSync } = require("fflate");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const RUNTIME_FILES = Object.freeze(JSON.parse(
  fs.readFileSync(path.join(__dirname, "runtime-files.json"), "utf8")
));
const ZIP_EPOCH_SECONDS = 315532800;
const ZIP_FILE_ATTRIBUTES = 0o100644 * 0x10000;

function byteSort(values) {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

function firefoxBackgroundScripts() {
  return ["src/media-utils.js", "background/core.js", "background/service-worker.js"];
}

function firefoxManifestFor(sourceManifest) {
  const firefoxManifest = JSON.parse(JSON.stringify(sourceManifest));
  firefoxManifest.background = { scripts: firefoxBackgroundScripts() };
  return firefoxManifest;
}

function normalizedZipDate(sourceDateEpoch = process.env.SOURCE_DATE_EPOCH) {
  const parsed = Number(sourceDateEpoch);
  const epochSeconds = Number.isFinite(parsed) ? Math.max(ZIP_EPOCH_SECONDS, Math.floor(parsed)) : ZIP_EPOCH_SECONDS;
  const utc = new Date(epochSeconds * 1000);
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds(),
    0
  );
}

function expectedDirectorySet(runtimeFiles) {
  const directories = new Set();
  for (const relativePath of runtimeFiles) {
    let directory = path.posix.dirname(relativePath);
    while (directory && directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return directories;
}

function walkRuntimeDirectory(root, relativeDirectory, expectedDirectories, actualFiles) {
  const directoryPath = path.join(root, ...relativeDirectory.split("/"));
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directoryPath, entry.name);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`unsupported runtime symlink: ${relativePath}`);
    if (stat.isDirectory()) {
      if (!expectedDirectories.has(relativePath)) throw new Error(`unexpected runtime directory: ${relativePath}`);
      walkRuntimeDirectory(root, relativePath, expectedDirectories, actualFiles);
      continue;
    }
    if (!stat.isFile()) throw new Error(`unsupported runtime node: ${relativePath}`);
    actualFiles.push(relativePath);
  }
}

function validateRuntimeTree(root, runtimeFiles = RUNTIME_FILES) {
  const expected = byteSort(runtimeFiles);
  if (new Set(expected).size !== expected.length) throw new Error("runtime-files.json contains duplicate runtime path entries");
  for (const relativePath of expected) {
    if (relativePath.includes("\\") || path.posix.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error(`unsafe runtime path: ${relativePath}`);
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile()) throw new Error(`runtime path is not a regular file: ${relativePath}`);
  }

  const expectedDirectories = expectedDirectorySet(expected);
  const actualFiles = expected.filter((relativePath) => path.posix.dirname(relativePath) === ".");
  const topDirectories = byteSort([...expectedDirectories].filter((directory) => !directory.includes("/")));
  for (const directory of topDirectories) {
    walkRuntimeDirectory(root, directory, expectedDirectories, actualFiles);
  }

  const actual = byteSort(actualFiles);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unexpected = actual.filter((relativePath) => !expectedSet.has(relativePath));
  if (unexpected.length) throw new Error(`unexpected runtime file: ${unexpected[0]}`);
  const missing = expected.filter((relativePath) => !actualSet.has(relativePath));
  if (missing.length) throw new Error(`missing runtime file: ${missing[0]}`);
  return expected;
}

function runtimeContents(root, browser, runtimeFiles = RUNTIME_FILES) {
  const files = {};
  for (const relativePath of validateRuntimeTree(root, runtimeFiles)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    let bytes = fs.readFileSync(absolutePath);
    if (browser === "firefox" && relativePath === "manifest.json") {
      const sourceManifest = JSON.parse(bytes.toString("utf8"));
      bytes = Buffer.from(`${JSON.stringify(firefoxManifestFor(sourceManifest), null, 2)}\n`, "utf8");
    }
    files[relativePath] = bytes;
  }
  return files;
}

function writeStagingDirectory(targetDir, files) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  for (const relativePath of byteSort(Object.keys(files))) {
    const targetPath = path.join(targetDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    fs.writeFileSync(targetPath, files[relativePath], { mode: 0o644 });
    try { fs.chmodSync(targetPath, 0o644); } catch (_error) {}
  }
}

function createZip(files, zipPath, options = {}) {
  const mtime = normalizedZipDate(options.sourceDateEpoch);
  const archive = {};
  for (const relativePath of byteSort(Object.keys(files))) {
    archive[relativePath] = [new Uint8Array(files[relativePath]), {
      attrs: ZIP_FILE_ATTRIBUTES,
      level: 9,
      mtime,
      os: 3
    }];
  }
  const bytes = zipSync(archive, { level: 9 });
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, bytes, { mode: 0o644 });
  return zipPath;
}

function buildPackages(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const outDir = path.resolve(options.outDir || path.join(root, "dist"));
  const chromeDir = path.join(outDir, "build", "chrome-edge");
  const firefoxDir = path.join(outDir, "build", "firefox");
  const chromeFiles = runtimeContents(root, "chrome", options.runtimeFiles || RUNTIME_FILES);
  const firefoxFiles = runtimeContents(root, "firefox", options.runtimeFiles || RUNTIME_FILES);

  writeStagingDirectory(chromeDir, chromeFiles);
  writeStagingDirectory(firefoxDir, firefoxFiles);

  const chromeZip = createZip(chromeFiles, path.join(outDir, "open-video-catcher-chrome-edge.zip"), options);
  const firefoxZip = createZip(firefoxFiles, path.join(outDir, "open-video-catcher-firefox.zip"), options);
  return { chromeDir, firefoxDir, chromeZip, firefoxZip };
}

function packageExtension() {
  const result = buildPackages();
  console.log(result.chromeZip);
  console.log(result.firefoxZip);
  return result;
}

if (require.main === module) packageExtension();

module.exports = {
  RUNTIME_FILES,
  buildPackages,
  createZip,
  firefoxBackgroundScripts,
  firefoxManifestFor,
  normalizedZipDate,
  packageExtension,
  validateRuntimeTree
};
