const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { strToU8, zipSync } = require("fflate");

const { buildUpdateManifest } = require("../scripts/generate-update-manifest.js");

function signedXpiManifest(overrides = {}) {
  const manifest = {
    manifest_version: 3,
    version: "1.2.3",
    browser_specific_settings: {
      gecko: {
        id: "test-addon@example.invalid",
        strict_min_version: "128.0"
      }
    },
    ...overrides
  };
  return Buffer.from(zipSync({
    "manifest.json": [strToU8(`${JSON.stringify(manifest)}\n`), { mtime: new Date(1980, 0, 1) }],
    "background/service-worker.js": [strToU8("// signed payload\n"), { mtime: new Date(1980, 0, 1) }]
  }));
}

test("Firefox update metadata is derived from the exact signed XPI bytes", () => {
  const xpiBytes = signedXpiManifest();
  const result = buildUpdateManifest({
    xpiBytes,
    updateLink: "https://downloads.example/open-video-catcher-firefox.xpi"
  });
  const update = result.addons["test-addon@example.invalid"].updates[0];
  assert.equal(update.version, "1.2.3");
  assert.equal(update.update_link, "https://downloads.example/open-video-catcher-firefox.xpi");
  assert.throws(() => buildUpdateManifest({
    xpiBytes,
    updateLink: "https://updates.example/open-video-catcher-firefox.xpi",
    expectedAddonId: "different@example.invalid"
  }), /add-on ID/i);
  assert.equal(update.update_hash, `sha512:${crypto.createHash("sha512").update(xpiBytes).digest("hex")}`);
  assert.equal(update.applications.gecko.strict_min_version, "128.0");
});

test("Firefox update metadata rejects an XPI without a valid embedded manifest", () => {
  const emptyXpi = Buffer.from(zipSync({ "README": strToU8("missing") }));
  assert.throws(() => buildUpdateManifest({ xpiBytes: emptyXpi, updateLink: "https://downloads.example/addon.xpi" }), /manifest\.json/i);
  assert.throws(() => buildUpdateManifest({ xpiBytes: signedXpiManifest({ version: "not-semver" }), updateLink: "https://downloads.example/addon.xpi" }), /version/i);
});
