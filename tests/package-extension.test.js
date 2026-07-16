const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { unzipSync } = require("fflate");

const repositoryRoot = path.resolve(__dirname, "..");
const packager = require(path.join(repositoryRoot, "scripts", "package-extension.js"));

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyRuntimeFixture(targetRoot) {
  for (const relativePath of packager.RUNTIME_FILES) {
    const sourcePath = path.join(repositoryRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function zipMetadata(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, "ZIP end-of-central-directory record");
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < totalEntries; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const dosTime = buffer.readUInt16LE(offset + 12);
    const dosDate = buffer.readUInt16LE(offset + 14);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, versionMadeBy, dosTime, dosDate, extraLength, commentLength, externalAttributes });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("packager creates byte-reproducible exact-runtime ZIPs with normalized metadata", () => {
  assert.equal(typeof packager.buildPackages, "function");
  assert.ok(Array.isArray(packager.RUNTIME_FILES));
  assert.deepEqual(packager.RUNTIME_FILES, [...packager.RUNTIME_FILES].sort());

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovc-package-"));
  const fixtureRoot = path.join(tempRoot, "source");
  const firstOut = path.join(tempRoot, "first");
  const secondOut = path.join(tempRoot, "second");
  copyRuntimeFixture(fixtureRoot);

  const firstTime = new Date("2022-02-03T04:05:06Z");
  for (const relativePath of packager.RUNTIME_FILES) {
    const filePath = path.join(fixtureRoot, relativePath);
    fs.chmodSync(filePath, 0o600);
    fs.utimesSync(filePath, firstTime, firstTime);
  }
  const first = packager.buildPackages({ root: fixtureRoot, outDir: firstOut });

  const secondTime = new Date("2026-07-15T12:34:56Z");
  for (const relativePath of [...packager.RUNTIME_FILES].reverse()) {
    const filePath = path.join(fixtureRoot, relativePath);
    fs.chmodSync(filePath, 0o644);
    fs.utimesSync(filePath, secondTime, secondTime);
  }
  const second = packager.buildPackages({ root: fixtureRoot, outDir: secondOut });

  assert.equal(sha256(first.chromeZip), sha256(second.chromeZip));
  assert.equal(sha256(first.firefoxZip), sha256(second.firefoxZip));

  for (const zipPath of [first.chromeZip, first.firefoxZip]) {
    const bytes = fs.readFileSync(zipPath);
    const names = Object.keys(unzipSync(bytes));
    assert.deepEqual(names, packager.RUNTIME_FILES);
    const metadata = zipMetadata(bytes);
    assert.deepEqual(metadata.map((entry) => entry.name), packager.RUNTIME_FILES);
    for (const entry of metadata) {
      assert.equal(entry.versionMadeBy >>> 8, 3, `${entry.name}: Unix origin`);
      assert.equal(entry.dosTime, 0, `${entry.name}: fixed time`);
      assert.equal(entry.dosDate, 33, `${entry.name}: 1980-01-01`);
      assert.equal(entry.extraLength, 0, `${entry.name}: no extra fields`);
      assert.equal(entry.commentLength, 0, `${entry.name}: no comments`);
      assert.equal(entry.externalAttributes >>> 16, 0o100644, `${entry.name}: normalized mode`);
    }
  }

  const firefoxFiles = unzipSync(fs.readFileSync(first.firefoxZip));
  const firefoxManifest = JSON.parse(Buffer.from(firefoxFiles["manifest.json"]).toString("utf8"));
  assert.deepEqual(firefoxManifest.background.scripts, [
    "src/media-utils.js",
    "background/core.js",
    "background/service-worker.js"
  ]);
});

test("packager fails closed on unexpected runtime files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovc-package-extra-"));
  const fixtureRoot = path.join(tempRoot, "source");
  copyRuntimeFixture(fixtureRoot);
  fs.writeFileSync(path.join(fixtureRoot, "popup", "private.pem"), "not-runtime\n");
  assert.throws(
    () => packager.buildPackages({ root: fixtureRoot, outDir: path.join(tempRoot, "out") }),
    /unexpected runtime file.*popup\/private\.pem/i
  );
});

test("packager rejects traversal, platform-dependent separators, and duplicate runtime paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovc-package-paths-"));
  const fixtureRoot = path.join(tempRoot, "source");
  copyRuntimeFixture(fixtureRoot);
  const outDir = path.join(tempRoot, "out");
  assert.throws(() => packager.buildPackages({ root: fixtureRoot, outDir, runtimeFiles: ["../secret"] }), /unsafe runtime path/);
  assert.throws(() => packager.buildPackages({ root: fixtureRoot, outDir, runtimeFiles: ["popup\\popup.js"] }), /unsafe runtime path/);
  assert.throws(() => packager.buildPackages({ root: fixtureRoot, outDir, runtimeFiles: ["manifest.json", "manifest.json"] }), /duplicate runtime path/);
});

test("repository checkout normalizes runtime text bytes across operating systems", () => {
  const attributes = fs.readFileSync(path.join(repositoryRoot, ".gitattributes"), "utf8");
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.png binary$/m);
});
