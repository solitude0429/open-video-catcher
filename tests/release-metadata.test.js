const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyReleaseMetadata } = require("../scripts/verify-release.js");

function fixture(overrides = {}) {
  const version = overrides.version || "0.2.7";
  return {
    tag: overrides.tag || `v${version}`,
    pkg: { version: overrides.packageVersion || version },
    lock: {
      version: overrides.lockVersion || version,
      packages: { "": { version: overrides.lockRootVersion || version } }
    },
    manifest: { version: overrides.manifestVersion || version }
  };
}

test("release metadata requires one strict SemVer across tag and package manifests", () => {
  assert.equal(verifyReleaseMetadata(fixture()), "0.2.7");
  assert.throws(() => verifyReleaseMetadata(fixture({ tag: "v0.2" })), /strict SemVer tag/i);
  assert.throws(() => verifyReleaseMetadata(fixture({ tag: "v00.2.7" })), /strict SemVer tag/i);
  assert.throws(() => verifyReleaseMetadata(fixture({ version: "1.2.3-beta.1" })), /strict SemVer tag/i);
  assert.throws(() => verifyReleaseMetadata(fixture({ packageVersion: "0.2.8" })), /package\.json/i);
  assert.throws(() => verifyReleaseMetadata(fixture({ lockRootVersion: "0.2.8" })), /package-lock root/i);
  assert.throws(() => verifyReleaseMetadata(fixture({ manifestVersion: "0.2.8" })), /manifest\.json/i);
});
