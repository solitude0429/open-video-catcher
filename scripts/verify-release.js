#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function verifyReleaseMetadata({ tag, pkg, lock, manifest }) {
  const releaseTag = String(tag || "");
  const tagVersion = releaseTag.startsWith("v") ? releaseTag.slice(1) : "";
  if (!STRICT_SEMVER.test(tagVersion)) throw new Error(`release value is not a strict SemVer tag: ${releaseTag || "<empty>"}`);

  const checks = [
    ["package.json", pkg?.version],
    ["package-lock root", lock?.packages?.[""]?.version],
    ["package-lock top-level", lock?.version],
    ["manifest.json", manifest?.version]
  ];
  for (const [source, value] of checks) {
    if (value !== tagVersion) throw new Error(`${source} version ${value || "<missing>"} does not match ${releaseTag}`);
  }
  return tagVersion;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const root = path.resolve(__dirname, "..");
  const version = verifyReleaseMetadata({
    tag: process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME,
    pkg: readJson(path.join(root, "package.json")),
    lock: readJson(path.join(root, "package-lock.json")),
    manifest: readJson(path.join(root, "manifest.json"))
  });
  process.stdout.write(`${version}\n`);
}

if (require.main === module) main();

module.exports = { STRICT_SEMVER, verifyReleaseMetadata };
