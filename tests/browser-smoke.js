#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { unzipSync } = require("fflate");

function extractRuntimeArchive(archivePath, outputDirectory) {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(archivePath)));
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name || name.endsWith("/") || path.isAbsolute(name) || name.split("/").includes("..")) {
      throw new Error(`unsafe archive entry: ${name}`);
    }
    const destination = path.join(outputDirectory, ...name.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { mode: 0o644 });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const archivePath = path.join(root, "dist", "open-video-catcher-chrome-edge.zip");
  assert(fs.existsSync(archivePath), "run npm run build before browser smoke testing");

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovc-browser-smoke-"));
  const extensionPath = path.join(temporaryRoot, "extension");
  const profilePath = path.join(temporaryRoot, "profile");
  fs.mkdirSync(extensionPath, { recursive: true });
  extractRuntimeArchive(archivePath, extensionPath);

  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/video.mp4")) {
      const body = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
      response.writeHead(200, { "content-type": "video/mp4", "content-length": body.length });
      response.end(body);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>OVC smoke</title><video id=player></video>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const pageOrigin = `http://media.test:${port}`;

  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath: process.env.OVC_CHROMIUM_PATH || chromium.executablePath(),
      headless: true,
      args: [
        "--no-sandbox",
        "--no-proxy-server",
        "--host-resolver-rules=MAP media.test 127.0.0.1",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    let unobservedRequests = 0;
    context.on("request", (request) => {
      if (request.url().startsWith("https://unobserved.example/")) unobservedRequests += 1;
    });

    let workers = context.serviceWorkers();
    if (!workers.length) workers = [await context.waitForEvent("serviceworker", { timeout: 15000 })];
    const worker = workers.find((candidate) => candidate.url().startsWith("chrome-extension://"));
    assert(worker, `extension service worker missing: ${workers.map((item) => item.url()).join(", ")}`);
    const workerUrl = new URL(worker.url());
    const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`;

    const mediaPage = await context.newPage();
    await mediaPage.goto(`${pageOrigin}/`, { waitUntil: "domcontentloaded" });
    const tabId = await worker.evaluate(async (origin) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      return tab?.id;
    }, pageOrigin);
    assert(Number.isInteger(tabId), "test tab id was not visible to the extension");

    const extensionPage = await context.newPage();
    await extensionPage.goto(`${extensionOrigin}/popup/popup.html`, { waitUntil: "domcontentloaded" });
    const started = await extensionPage.evaluate(async (targetTabId) => chrome.runtime.sendMessage({
      type: "OVC_START_DETECTION",
      tabId: targetTabId
    }), tabId);
    assert(started?.ok, `capture failed: ${JSON.stringify(started)}`);

    await mediaPage.bringToFront();
    await mediaPage.evaluate(async () => {
      window.dispatchEvent(new CustomEvent("__OVC_MEDIA_CANDIDATE", {
        detail: JSON.stringify({
          url: "https://unobserved.example/videoplayback?id=forged",
          source: "fetch",
          requestType: "fetch",
          force: true
        })
      }));
      await fetch("/video.mp4?token=secret");
    });
    await mediaPage.waitForTimeout(500);

    const payload = await extensionPage.evaluate(async (targetTabId) => chrome.runtime.sendMessage({
      type: "OVC_GET_TAB_MEDIA",
      tabId: targetTabId
    }), tabId);
    const observed = payload?.items?.find((item) => item.url.includes("/video.mp4?token=secret"));
    const forged = payload?.items?.find((item) => item.url.includes("unobserved.example"));
    assert(payload?.captureActive, "capture did not remain active");
    assert(observed?.kind === "video" && observed.downloadable && !observed.lowConfidence,
      `trusted network video was not promoted correctly: ${JSON.stringify(observed)}`);
    assert(observed.displayUrl.includes("?…"), `signed URL was not redacted: ${observed.displayUrl}`);
    assert(!forged?.downloadable, `forged page hint became downloadable: ${JSON.stringify(forged)}`);
    assert(unobservedRequests === 0, `forged page hint triggered ${unobservedRequests} network request(s)`);

    process.stdout.write("browser smoke passed: packaged MV3 runtime detected trusted media and rejected forged fetch authority\n");
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
