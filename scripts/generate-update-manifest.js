#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("signed XPI is not a valid ZIP archive");
}

function readZipEntry(input, targetName) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length < 22) throw new Error("signed XPI is not a valid ZIP archive");
  const eocd = findEndOfCentralDirectory(bytes);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  let match = null;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("signed XPI central directory is invalid");
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) throw new Error("signed XPI entry name is truncated");
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");

    if (name === targetName) {
      if (match) throw new Error(`signed XPI contains duplicate ${targetName} entries`);
      if (uncompressedSize > MAX_MANIFEST_BYTES) throw new Error(`${targetName} exceeds the size limit`);
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`signed XPI ${targetName} local header is invalid`);
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) throw new Error(`signed XPI ${targetName} data is truncated`);
      const compressed = bytes.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) match = Buffer.from(compressed);
      else if (compressionMethod === 8) match = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
      else throw new Error(`signed XPI ${targetName} uses unsupported ZIP compression method ${compressionMethod}`);
      if (match.length !== uncompressedSize) throw new Error(`signed XPI ${targetName} size does not match its directory entry`);
    }

    offset = nameEnd + extraLength + commentLength;
  }

  if (!match) throw new Error(`signed XPI does not contain ${targetName}`);
  return match;
}

function buildUpdateManifest({ xpiBytes, updateLink, expectedVersion = "", expectedAddonId = "" }) {
  let parsedLink;
  try { parsedLink = new URL(String(updateLink || "")); } catch (_error) { throw new Error("UPDATE_LINK must be a valid HTTPS URL"); }
  if (parsedLink.protocol !== "https:") throw new Error("UPDATE_LINK must be a valid HTTPS URL");

  let manifest;
  try {
    manifest = JSON.parse(readZipEntry(xpiBytes, "manifest.json").toString("utf8"));
  } catch (error) {
    if (/manifest\.json/i.test(error.message)) throw error;
    throw new Error(`signed XPI manifest.json is invalid: ${error.message}`);
  }
  const version = String(manifest?.version || "");
  if (!STRICT_SEMVER.test(version)) throw new Error(`signed XPI manifest version is not strict SemVer: ${version || "<missing>"}`);
  if (expectedVersion && version !== expectedVersion) throw new Error(`signed XPI version ${version} does not match expected version ${expectedVersion}`);

  const gecko = manifest?.browser_specific_settings?.gecko || manifest?.applications?.gecko || {};
  const addonId = String(gecko.id || "");
  if (!addonId || addonId.length > 255 || /[\s\u0000-\u001f]/.test(addonId)) throw new Error("signed XPI manifest.json is missing a valid Gecko add-on id");
  if (expectedAddonId && addonId !== expectedAddonId) throw new Error(`signed XPI add-on ID ${addonId} does not match expected add-on ID ${expectedAddonId}`);
  const strictMinVersion = String(gecko.strict_min_version || "115.0");
  const xpi = Buffer.isBuffer(xpiBytes) ? xpiBytes : Buffer.from(xpiBytes || []);
  const sha512 = crypto.createHash("sha512").update(xpi).digest("hex");

  return {
    addons: {
      [addonId]: {
        updates: [{
          version,
          update_link: parsedLink.href,
          update_hash: `sha512:${sha512}`,
          applications: { gecko: { strict_min_version: strictMinVersion } }
        }]
      }
    }
  };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const xpiPath = path.resolve(root, process.env.XPI_PATH || "dist/amo/open-video-catcher-firefox.xpi");
  const outputPath = path.resolve(root, process.env.OUTPUT_PATH || "public/updates.json");
  const xpiBytes = fs.readFileSync(xpiPath);
  const updates = buildUpdateManifest({
    xpiBytes,
    updateLink: process.env.UPDATE_LINK || "https://solitude0429.github.io/open-video-catcher/open-video-catcher-firefox.xpi",
    expectedVersion: process.env.EXPECTED_VERSION || "",
    expectedAddonId: process.env.EXPECTED_ADDON_ID || ""
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(updates, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${outputPath}\n`);
}

if (require.main === module) main();

module.exports = { buildUpdateManifest, readZipEntry };
