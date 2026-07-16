const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const workflowsDir = path.join(root, ".github", "workflows");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

test("release tooling and GitHub Actions are immutable inputs", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const webExtVersion = pkg.devDependencies?.["web-ext"];

  assert.match(webExtVersion || "", /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages?.["node_modules/web-ext"]?.version, webExtVersion);
  assert.match(lock.packages?.["node_modules/web-ext"]?.integrity || "", /^sha512-/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /@latest|npx\s+--yes/);

  for (const filename of fs.readdirSync(workflowsDir).filter((name) => name.endsWith(".yml")).sort()) {
    const source = fs.readFileSync(path.join(workflowsDir, filename), "utf8");
    for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) {
      assert.match(match[1], /^[^@\s]+@[0-9a-f]{40}$/, `${filename}: ${match[1]}`);
    }
    assert.doesNotMatch(source, /@latest|npx\s+--yes/, filename);
  }
});

test("Firefox signing isolates AMO secrets behind verified artifact digests", () => {
  const source = fs.readFileSync(path.join(workflowsDir, "sign-firefox.yml"), "utf8");
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "sign", "assemble", "publish-release", "deploy"]);

  const buildText = JSON.stringify(workflow.jobs.build);
  const signText = JSON.stringify(workflow.jobs.sign);
  const assembleText = JSON.stringify(workflow.jobs.assemble);
  const publishText = JSON.stringify(workflow.jobs["publish-release"]);
  const deployText = JSON.stringify(workflow.jobs.deploy);
  assert.match(buildText, /verify-release\.js/);
  assert.match(buildText, /sha256sum[^\n]*scripts\/generate-update-manifest\.js[^\n]*SOURCE\.json/);
  assert.doesNotMatch(buildText, /secrets\./);
  assert.equal(workflow.jobs.sign.environment.name, "amo-signing");
  assert.match(signText, /secrets\.AMO_JWT_ISSUER/);
  assert.match(signText, /secrets\.AMO_JWT_SECRET/);
  assert.match(signText, /sha256sum -c/);
  assert.match(signText, /SIGNED_FILES/);
  assert.match(signText, /\$\{#SIGNED_FILES\[@\]\}.*-eq 1/);
  assert.doesNotMatch(signText, /actions\/checkout|actions\/setup-node|npm\s+(ci|install)|npx/);

  assert.doesNotMatch(assembleText, /secrets\./);
  assert.match(assembleText, /sha256sum -c/);
  assert.deepEqual(workflow.jobs["publish-release"].permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
    "artifact-metadata": "write"
  });
  assert.match(publishText, /actions\/attest@[0-9a-f]{40}/);
  assert.match(publishText, /subject-checksums/);
  assert.match(publishText, /FIREFOX-UPDATE-SHA256SUMS/);
  assert.match(publishText, /git\/ref\/tags/);
  assert.match(publishText, /cmp/);
  assert.doesNotMatch(publishText, /--clobber|secrets\.|actions\/checkout|actions\/setup-node|npm\s+(ci|install)|npx/);
  assert.doesNotMatch(deployText, /secrets\.|actions\/checkout|actions\/setup-node|npm\s+(ci|install)|npx/);
  assert.deepEqual(workflow.jobs.deploy.permissions, { pages: "write", "id-token": "write" });
});

test("tag releases verify version, attest checksums, and publish without rebuilding", () => {
  const source = fs.readFileSync(path.join(workflowsDir, "release.yml"), "utf8");
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "attest", "publish"]);
  assert.doesNotMatch(source, /workflow_dispatch|--clobber/);

  const buildText = JSON.stringify(workflow.jobs.build);
  const attestText = JSON.stringify(workflow.jobs.attest);
  const publishText = JSON.stringify(workflow.jobs.publish);
  assert.match(buildText, /verify-release\.js/);
  assert.match(buildText, /SHA256SUMS/);
  assert.deepEqual(workflow.jobs.attest.permissions, {
    contents: "read",
    "id-token": "write",
    attestations: "write",
    "artifact-metadata": "write"
  });
  assert.match(attestText, /actions\/attest@[0-9a-f]{40}/);
  assert.match(attestText, /subject-checksums/);
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "write" });
  assert.match(publishText, /sha256sum -c/);
  assert.doesNotMatch(publishText, /actions\/checkout|actions\/setup-node|npm\s+(ci|install)|npx/);
});

test("CI builds the deterministic packages on Linux and Windows", () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(workflowsDir, "ci.yml"), "utf8"));
  assert.deepEqual(workflow.jobs.verify.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
  assert.equal(workflow.jobs.verify["runs-on"], "${{ matrix.os }}");
  const compareJob = workflow.jobs["compare-packages"];
  assert.match(JSON.stringify(compareJob), /cmp .*open-video-catcher-chrome-edge\.zip/);
  assert.match(JSON.stringify(compareJob), /cmp .*open-video-catcher-firefox\.zip/);
  const browserJob = workflow.jobs["browser-smoke"];
  assert.equal(browserJob["runs-on"], "ubuntu-latest");
  assert.equal(browserJob.needs, "compare-packages");
  assert.match(JSON.stringify(browserJob), /playwright-core install --with-deps chromium/);
  assert.match(JSON.stringify(browserJob), /npm run test:browser/);
});

test("stale gh-pages checkout cannot overwrite the signed update channel", () => {
  assert.equal(fs.existsSync(path.join(workflowsDir, "deploy-pages-static.yml")), false);
});
