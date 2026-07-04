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

test("preserves signed URL tails for download while redacting display URL", () => {
  const item = utils.createMediaItem({
    url: "https://cdn.example/path/movie.mp4?Policy=secret&Signature=top#frag",
    source: "network"
  });
  assert.equal(item.url, "https://cdn.example/path/movie.mp4?Policy=secret&Signature=top#frag");
  assert.equal(item.displayUrl, "https://cdn.example/path/movie.mp4?…#…");
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
  assert.equal(command, 'ffmpeg -hide_banner -nostdin -i "https://cdn.example/live/master.m3u8?x=1" -c copy "master.mp4"');
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
