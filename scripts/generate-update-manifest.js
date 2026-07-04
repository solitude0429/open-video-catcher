#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const addonId = manifest.browser_specific_settings.gecko.id;
const version = process.env.VERSION || pkg.version;
const xpiPath = path.resolve(root, process.env.XPI_PATH || "dist/amo/open-video-catcher-firefox.xpi");
const outputPath = path.resolve(root, process.env.UPDATE_MANIFEST_PATH || "public/updates.json");
const updateLink = process.env.UPDATE_LINK || "https://solitude0429.github.io/open-video-catcher/open-video-catcher-firefox.xpi";

if (!fs.existsSync(xpiPath)) {
  console.error(`XPI not found: ${xpiPath}`);
  process.exit(1);
}

const hash = crypto.createHash("sha256").update(fs.readFileSync(xpiPath)).digest("hex");
const updates = {
  addons: {
    [addonId]: {
      updates: [
        {
          version,
          update_link: updateLink,
          update_hash: `sha256:${hash}`,
          applications: {
            gecko: {
              strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version
            }
          }
        }
      ]
    }
  }
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(updates, null, 2)}\n`);
console.log(`${outputPath}\nsha256:${hash}`);
