const test = require("node:test");
const assert = require("node:assert/strict");
const utils = require("../src/media-utils.js");

test("classifies direct MP4 URLs", () => {
  const result = utils.classifyMediaUrl("https://cdn.example/video/movie.mp4?token=secret");
  assert.equal(result.kind, "video");
  assert.equal(result.ext, "mp4");
});

test("classifies HLS playlists", () => {
  const result = utils.classifyMediaUrl("https://cdn.example/live/master.m3u8");
  assert.equal(result.kind, "hls-playlist");
  assert.equal(result.ext, "m3u8");
});

test("classifies media by content-type even without extension", () => {
  const result = utils.classifyMediaUrl("https://cdn.example/videoplayback?id=1", { contentType: "video/mp4; charset=binary" });
  assert.equal(result.kind, "video");
  assert.equal(result.ext, "mp4");
});

test("sniffs extensionless HLS and DASH responses", () => {
  const hls = utils.createMediaItem({
    url: "https://cdn.example/api/playback?id=1",
    sniffedText: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunklist"
  });
  assert.equal(hls.kind, "hls-playlist");
  assert.equal(hls.ext, "m3u8");

  const dash = utils.createMediaItem({
    url: "https://cdn.example/manifest?id=2",
    sniffedText: "<?xml version=\"1.0\"?><MPD><Period/></MPD>"
  });
  assert.equal(dash.kind, "dash-manifest");
  assert.equal(dash.ext, "mpd");
});

test("sniffs extensionless MP4 init bytes", () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const item = utils.createMediaItem({
    url: "https://cdn.example/range/segment?id=3",
    mimeType: "application/octet-stream",
    sniffedBytes: bytes
  });
  assert.equal(item.kind, "video");
  assert.equal(item.ext, "mp4");
});

test("recognizes extensionless media URLs worth sniffing during manual capture", () => {
  assert.equal(utils.shouldSniffMediaUrl("https://cdn.example/hls/master?id=1", { requestType: "xmlhttprequest" }), true);
  assert.equal(utils.shouldSniffMediaUrl("https://cdn.example/assets/app.js", { requestType: "script" }), false);
});

test("MIME type overrides misleading playlist-looking URL extension", () => {
  const result = utils.classifyMediaUrl("https://cdn.example/video/master.m3u8?download=1", { contentType: "video/mp4" });
  assert.equal(result.kind, "video");
  assert.equal(result.ext, "mp4");
  const item = utils.createMediaItem({ url: "https://cdn.example/video/master.m3u8?download=1", mimeType: "video/mp4" });
  assert.equal(item.kind, "video");
  assert.equal(item.fileName, "master.mp4");
  assert.equal(item.downloadable, true);
});

test("transport and fragmented MP4 MIME types remain stream segments", () => {
  const transport = utils.createMediaItem({ url: "https://cdn.example/chunk.ts", mimeType: "video/mp2t", source: "network" });
  const fragment = utils.createMediaItem({ url: "https://cdn.example/chunk.m4s", mimeType: "video/iso.segment", source: "network" });
  const genericFragment = utils.createMediaItem({ url: "https://cdn.example/segment.m4s", mimeType: "video/mp4", source: "network" });
  assert.equal(transport.kind, "stream-segment");
  assert.equal(transport.ext, "ts");
  assert.equal(fragment.kind, "stream-segment");
  assert.equal(fragment.ext, "m4s");
  assert.equal(genericFragment.kind, "stream-segment");
});

test("HLS and DASH manifests are not advertised as direct browser video downloads", () => {
  const hls = utils.createMediaItem({ url: "https://cdn.example/live/master.m3u8" });
  const dash = utils.createMediaItem({ url: "https://cdn.example/live/manifest.mpd" });
  assert.equal(hls.kind, "hls-playlist");
  assert.equal(dash.kind, "dash-manifest");
  assert.equal(hls.downloadable, false);
  assert.equal(dash.downloadable, false);
});

test("Content-Disposition filename wins and is sanitized", () => {
  const item = utils.createMediaItem({
    url: "https://cdn.example/media?id=123",
    mimeType: "video/mp4",
    contentDisposition: 'attachment; filename="bad/name?.bin"'
  });
  assert.equal(item.fileName, "bad-name-.mp4");
});

test("RFC5987 Content-Disposition filename is decoded", () => {
  const name = utils.filenameFromContentDisposition("attachment; filename*=UTF-8''%EC%98%81%EC%83%81.mp4");
  assert.equal(name, "영상.mp4");
});

test("Content-Disposition classifies extensionless MKV and HLS URLs without MIME spoofing", () => {
  const mkv = utils.createMediaItem({
    url: "https://cdn.example/download?id=movie",
    contentDisposition: 'attachment; filename="movie.mkv"'
  });
  assert.equal(mkv.kind, "video");
  assert.equal(mkv.ext, "mkv");
  assert.equal(mkv.mimeType, "");
  assert.equal(mkv.fileName, "movie.mkv");

  const hls = utils.createMediaItem({
    url: "https://cdn.example/download?id=playlist",
    contentDisposition: 'attachment; filename="master.m3u8"'
  });
  assert.equal(hls.kind, "hls-playlist");
  assert.equal(hls.ext, "m3u8");
  assert.equal(hls.downloadable, false);
});

test("classification records conflicts while trusted MIME keeps priority", () => {
  const item = utils.createMediaItem({
    url: "https://cdn.example/master.m3u8",
    mimeType: "video/mp4",
    contentDisposition: 'attachment; filename="movie.mkv"'
  });
  assert.equal(item.kind, "video");
  assert.equal(item.ext, "mp4");
  assert.equal(item.classificationConflict, true);
  assert.deepEqual(item.classificationEvidence, {
    mimeExt: "mp4",
    dispositionExt: "mkv",
    urlExt: "m3u8"
  });
});

test("Content-Disposition parser unescapes quoted-pair filenames", () => {
  assert.equal(
    utils.filenameFromContentDisposition('attachment; filename="my\\\"video.mp4"'),
    'my"video.mp4'
  );
});

test("preserves signed URL tails for download while redacting display URL", () => {
  const item = utils.createMediaItem({
    url: "https://cdn.example/path/movie.mp4?Policy=secret&Signature=top#frag",
    source: "network"
  });
  assert.equal(item.url, "https://cdn.example/path/movie.mp4?Policy=secret&Signature=top#frag");
  assert.equal(item.displayUrl, "https://cdn.example/path/movie.mp4?…#…");
});

test("media item identity uses the full URL and kind instead of a 32-bit hash", () => {
  const url = "https://cdn.example/path/movie.mp4?Policy=secret&Signature=top";
  const item = utils.createMediaItem({ url });
  assert.equal(item.id, `video|${url}`);
});

test("detection and analysis enrichment counters are tracked separately", () => {
  const url = "https://cdn.example/live/master.m3u8";
  const first = utils.createMediaItem({ url, now: 1 });
  const second = utils.createMediaItem({ url, now: 2 });
  const detectedTwice = utils.mergeMediaItems(first, second);
  assert.equal(detectedTwice.detectionCount, 2);
  assert.equal(detectedTwice.enrichmentCount, 0);

  const enriched = utils.mergeMediaItems(
    detectedTwice,
    Object.assign({}, detectedTwice, { analysis: { type: "hls" }, lastSeen: 3 }),
    { enrichment: true }
  );
  assert.equal(enriched.detectionCount, 2);
  assert.equal(enriched.enrichmentCount, 1);
});

test("kind labels are consistently localized and unknown candidates stay explicit", () => {
  assert.equal(utils.kindLabel("video"), "비디오");
  assert.equal(utils.kindLabel("audio"), "오디오");
  assert.equal(utils.kindLabel("unknown-candidate"), "미분류 후보");
});

test("blob media is only accepted from DOM scans and is not directly downloadable", () => {
  assert.equal(utils.classifyMediaUrl("blob:https://example.com/123"), null);
  const item = utils.createMediaItem({ url: "blob:https://example.com/123", fromDom: true });
  assert.equal(item.kind, "blob-media");
  assert.equal(item.downloadable, false);
});

test("guessFilename sanitizes unsafe names and adds extension from MIME", () => {
  const filename = utils.guessFilename("https://cdn.example/video/play", { kind: "video", mimeType: "video/mp4", ext: "mp4" }, "my / title");
  assert.match(filename, /\.mp4$/);
  assert.doesNotMatch(filename, /[\\/:*?"<>|]/);
});

test("formatBytes uses human-readable units", () => {
  assert.equal(utils.formatBytes(1536), "1.5 KB");
});

test("ffmpegCommand quotes URL and output", () => {
  const command = utils.ffmpegCommand("https://cdn.example/live/master.m3u8?x=1", "master.m3u8");
  assert.equal(command, 'ffmpeg -hide_banner -nostdin -i "https://cdn.example/live/master.m3u8?x=1" -map 0 -c copy "master.mkv"');
});

test("ffmpeg plans preserve direct media containers and avoid double extensions", () => {
  const cases = [
    ["video", "flv", "sample.flv"],
    ["video", "mp4", "sample.mp4"],
    ["video", "webm", "sample.webm"],
    ["audio", "mp3", "sample.mp3"],
    ["audio", "flac", "sample.flac"]
  ];
  for (const [kind, ext, expectedOutput] of cases) {
    const plan = utils.ffmpegPlan({
      url: `https://cdn.example/sample.${ext}`,
      fileName: `sample.${ext}`,
      kind,
      ext,
      codecs: ""
    });
    assert.equal(plan.outputFile, expectedOutput);
    assert.match(plan.command, /-map 0 -c copy/);
    assert.doesNotMatch(plan.outputFile, new RegExp(`\\.${ext}\\.`));
  }
});

test("ffmpeg playlist container policy uses codec evidence and explains fallbacks", () => {
  const mp4 = utils.ffmpegPlan({
    url: "https://cdn.example/master.m3u8",
    fileName: "master.m3u8",
    kind: "hls-playlist",
    ext: "m3u8",
    codecs: "avc1.640028,mp4a.40.2"
  });
  assert.equal(mp4.outputFile, "master.mp4");
  assert.match(mp4.command, /-map ['"]0:v\?['"] -map ['"]0:a\?['"]/);

  const webmCodecs = utils.ffmpegPlan({
    url: "https://cdn.example/master.m3u8",
    fileName: "master.m3u8",
    kind: "hls-playlist",
    ext: "m3u8",
    codecs: "vp09.00.51.08,opus"
  });
  assert.equal(webmCodecs.outputFile, "master.mkv");
  assert.match(webmCodecs.warning, /Matroska|MKV/i);

  const unknown = utils.ffmpegPlan({
    url: "https://cdn.example/manifest.mpd",
    fileName: "manifest.mpd",
    kind: "dash-manifest",
    ext: "mpd",
    codecs: ""
  });
  assert.equal(unknown.outputFile, "manifest.mkv");
  assert.match(unknown.warning, /codec/i);
});

test("PowerShell command quoting is distinct from POSIX shell quoting", () => {
  const plan = utils.ffmpegPlan({
    url: "https://cdn.example/live/master.m3u8?name=O'Reilly",
    fileName: "O'Reilly.m3u8",
    kind: "hls-playlist",
    ext: "m3u8"
  }, { shell: "powershell" });
  assert.match(plan.command, /'O''Reilly/);
  assert.doesNotMatch(plan.command, /\\\$/);
});

test("parseHlsPlaylist resolves variants and quality labels", () => {
  const hls = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3500000,AVERAGE-BANDWIDTH=3200000,RESOLUTION=1920x1080,FRAME-RATE=60.0,CODECS="avc1"\n1080/main.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\nhttps://cdn.example/720.m3u8`;
  const parsed = utils.parseHlsPlaylist(hls, "https://cdn.example/live/master.m3u8?token=x");
  assert.equal(parsed.isMaster, true);
  assert.equal(parsed.variantCount, 2);
  assert.equal(parsed.variants[0].url, "https://cdn.example/live/1080/main.m3u8");
  assert.match(parsed.variants[0].qualityLabel, /1920x1080/);
  assert.match(parsed.variants[0].qualityLabel, /3.5 Mbps/);
});

test("parseHlsPlaylist detects encrypted media playlists", () => {
  const hls = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:5.5,\nseg1.ts`;
  const parsed = utils.parseHlsPlaylist(hls, "https://cdn.example/path/index.m3u8");
  assert.equal(parsed.encrypted, true);
  assert.deepEqual(parsed.encryptionMethods, ["AES-128"]);
  assert.equal(parsed.segmentCount, 2);
  assert.equal(parsed.sampleSegments[0].url, "https://cdn.example/path/seg0.ts");
});

test("parseDashManifest detects ContentProtection and representations", () => {
  const dash = `<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:test"/><Representation id="v1" bandwidth="4500000" width="1920" height="1080" codecs="avc1"/></AdaptationSet></Period></MPD>`;
  const parsed = utils.parseDashManifest(dash, "https://cdn.example/manifest.mpd");
  assert.equal(parsed.protectedContent, true);
  assert.equal(parsed.representationCount, 1);
  assert.equal(parsed.representations[0].resolution, "1920x1080");
});

test("curl and yt-dlp commands quote values", () => {
  assert.equal(utils.curlCommand("https://cdn.example/a video.mp4?x=1", "a video.mp4"), 'curl -L --fail --output "a video.mp4" "https://cdn.example/a video.mp4?x=1"');
  assert.equal(utils.ytDlpCommand("https://example.com/watch?v=1", "video.mp4"), 'yt-dlp --no-warnings -o "video.mp4" "https://example.com/watch?v=1"');
});

test("curl and yt-dlp expose PowerShell-safe variants", () => {
  assert.equal(
    utils.curlCommand("https://cdn.example/O'Reilly.mp4", "O'Reilly.mp4", { shell: "powershell" }),
    "curl.exe -L --fail --output 'O''Reilly.mp4' 'https://cdn.example/O''Reilly.mp4'"
  );
  assert.equal(
    utils.ytDlpCommand("https://example.com/watch?name=O'Reilly", "video.mp4", { shell: "powershell" }),
    "yt-dlp --no-warnings -o 'video.mp4' 'https://example.com/watch?name=O''Reilly'"
  );
});

test("HLS analysis bounds expansion and never uses a signed URL as a quality label", () => {
  const lines = ["#EXTM3U"];
  for (let index = 0; index < 1000; index += 1) {
    lines.push("#EXT-X-STREAM-INF:CODECS=\"avc1.4d401f\"");
    lines.push(`variant-${index}.m3u8?Policy=secret&Signature=value`);
  }
  const analysis = utils.parseHlsPlaylist(lines.join("\n"), "https://cdn.example/master.m3u8");
  assert.ok(analysis.variants.length <= 100);
  assert.equal(analysis.variantCount, 1000);
  assert.doesNotMatch(analysis.variants[0].qualityLabel, /https?:|Policy|Signature/i);
});

test("RFC5987 filenames support a language component", () => {
  assert.equal(utils.filenameFromContentDisposition("attachment; filename*=UTF-8'en'%E2%82%ACvideo.mp4"), "€video.mp4");
});

test("POSIX ffmpeg optional stream selectors are quoted against glob expansion", () => {
  const plan = utils.ffmpegPlan({
    url: "https://cdn.example/master.m3u8",
    kind: "hls-playlist",
    fileName: "master.m3u8",
    codecs: "avc1.4d401f,mp4a.40.2"
  }, { shell: "posix" });
  assert.match(plan.command, /-map ['"]0:v\?['"] -map ['"]0:a\?['"]/);
});
