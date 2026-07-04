(() => {
  "use strict";

  const utils = window.OpenVideoCatcherUtils;
  const content = document.getElementById("content");
  const countBadge = document.getElementById("countBadge");
  const refreshButton = document.getElementById("refreshButton");
  const clearButton = document.getElementById("clearButton");
  const hideSegments = document.getElementById("hideSegments");
  const template = document.getElementById("itemTemplate");
  let activeTab = null;
  let currentItems = [];

  function promisifyChrome(call) {
    return new Promise((resolve) => {
      call((result) => {
        const error = chrome.runtime.lastError;
        if (error) resolve({ ok: false, error: error.message });
        else resolve({ ok: true, result });
      });
    });
  }

  async function getActiveTab() {
    const response = await promisifyChrome((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
    if (!response.ok) throw new Error(response.error);
    return response.result[0];
  }

  function sendRuntimeMessage(message) {
    return promisifyChrome((done) => chrome.runtime.sendMessage(message, done));
  }

  function sendTabMessage(tabId, message) {
    return promisifyChrome((done) => chrome.tabs.sendMessage(tabId, message, done));
  }

  function setStatus(text) {
    content.innerHTML = "";
    const div = document.createElement("div");
    div.className = "status";
    div.textContent = text;
    content.append(div);
  }

  function hintForItem(item) {
    if (item.kind === "blob-media") return "blob: URL은 원본 주소가 아니라 브라우저 메모리 객체입니다. page-hook/network에서 원본 또는 playlist도 같이 잡히는지 확인하세요.";
    if (item.kind === "hls-playlist") return item.analysis?.encrypted ? "암호화 표시가 있는 HLS입니다. 브라우저 직접 저장은 영상 병합이 아니므로 ffmpeg/yt-dlp 명령을 사용하세요." : "HLS playlist입니다. 브라우저 직접 저장은 .m3u8 파일 저장일 뿐이라 비활성화했습니다. ffmpeg 또는 yt-dlp 명령을 사용하세요.";
    if (item.kind === "dash-manifest") return item.analysis?.protectedContent ? "ContentProtection이 있는 DASH manifest입니다. 브라우저 직접 저장은 영상 병합이 아니므로 ffmpeg/yt-dlp 명령을 사용하세요." : "DASH manifest입니다. 브라우저 직접 저장은 .mpd 파일 저장일 뿐이라 비활성화했습니다. ffmpeg 또는 yt-dlp 명령을 사용하세요.";
    if (item.kind === "stream-segment") return "스트리밍 조각 파일입니다. playlist/manifest가 있으면 그쪽을 우선 사용하세요.";
    return "";
  }

  function analysisText(item) {
    const analysis = item.analysis;
    if (!analysis) return "";
    if (analysis.error) return `분석 실패: ${analysis.error}`;
    if (analysis.type === "hls") {
      const parts = [];
      parts.push(analysis.isMaster ? "HLS master" : "HLS media");
      if (analysis.variantCount) parts.push(`variants ${analysis.variantCount}`);
      if (analysis.segmentCount) parts.push(`segments ${analysis.segmentCount}`);
      if (analysis.totalDuration) parts.push(`duration ${Math.round(analysis.totalDuration)}s`);
      if (analysis.encrypted) parts.push(`encrypted ${analysis.encryptionMethods.join("/")}`);
      if (analysis.variants?.length) parts.push(`best ${analysis.variants[0].qualityLabel}`);
      return parts.join(" · ");
    }
    if (analysis.type === "dash") {
      const parts = ["DASH manifest"];
      if (analysis.representationCount) parts.push(`representations ${analysis.representationCount}`);
      if (analysis.protectedContent) parts.push("ContentProtection");
      if (analysis.representations?.length) parts.push(`top ${analysis.representations[0].qualityLabel}`);
      return parts.join(" · ");
    }
    return "";
  }

  function commandUrl(item, preferPage) {
    return preferPage && item.pageUrl ? item.pageUrl : item.url;
  }

  async function copyText(button, text, originalLabel) {
    await navigator.clipboard.writeText(text);
    button.textContent = "복사됨";
    window.setTimeout(() => { button.textContent = originalLabel; }, 1400);
  }

  function render() {
    const visible = hideSegments.checked ? currentItems.filter((item) => item.kind !== "stream-segment") : currentItems;
    countBadge.textContent = String(visible.length);
    content.innerHTML = "";

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = currentItems.length === 0 ? "아직 감지된 미디어가 없습니다. 페이지에서 영상을 재생한 뒤 다시 스캔하세요." : "조각 파일만 감지되었습니다. '조각 파일 숨김'을 끄면 볼 수 있습니다.";
      content.append(empty);
      return;
    }

    for (const item of visible) {
      const node = template.content.firstElementChild.cloneNode(true);
      node.querySelector(".filename").textContent = item.fileName || "media";
      node.querySelector(".kind").textContent = utils.kindLabel(item.kind);
      const quality = utils.displayQuality(item);
      const qualityNode = node.querySelector(".quality");
      qualityNode.textContent = quality ? `품질: ${quality}` : "";
      qualityNode.hidden = !quality;

      const meta = [
        item.source,
        item.mimeType,
        item.sizeText,
        item.requestType,
        item.count > 1 ? `${item.count}회 감지` : ""
      ].filter(Boolean).join(" · ");
      node.querySelector(".meta").textContent = meta || "metadata 없음";
      node.querySelector(".url").textContent = item.displayUrl || "";
      node.querySelector(".analysis").textContent = analysisText(item);

      const hint = hintForItem(item);
      const hintNode = node.querySelector(".hint");
      hintNode.textContent = hint;
      hintNode.hidden = !hint;

      const downloadButton = node.querySelector(".download");
      const canBrowserDownload = item.downloadable && (item.kind === "video" || item.kind === "audio");
      downloadButton.disabled = !canBrowserDownload;
      downloadButton.textContent = canBrowserDownload ? "파일 다운로드" : (item.kind === "hls-playlist" || item.kind === "dash-manifest" ? "명령 사용" : "다운로드 불가");
      downloadButton.addEventListener("click", async () => {
        if (!canBrowserDownload) return;
        downloadButton.disabled = true;
        downloadButton.textContent = "요청 중…";
        const response = await sendRuntimeMessage({ type: "OVC_DOWNLOAD", tabId: activeTab.id, id: item.id });
        const payload = response.result || response;
        if (!payload.ok) {
          downloadButton.textContent = "실패";
          hintNode.textContent = `다운로드 실패: ${payload.error || "브라우저 다운로드 API가 거부했습니다."}`;
          hintNode.hidden = false;
          window.setTimeout(() => {
            downloadButton.textContent = "파일 다운로드";
            downloadButton.disabled = false;
          }, 2200);
          return;
        }
        downloadButton.textContent = "다운로드 시작";
        window.setTimeout(() => {
          downloadButton.textContent = "파일 다운로드";
          downloadButton.disabled = false;
        }, 1800);
      });

      const analyzeButton = node.querySelector(".analyze");
      analyzeButton.hidden = !(item.kind === "hls-playlist" || item.kind === "dash-manifest");
      analyzeButton.addEventListener("click", async () => {
        analyzeButton.disabled = true;
        analyzeButton.textContent = "분석 중…";
        const response = await sendRuntimeMessage({ type: "OVC_ANALYZE_PLAYLIST", tabId: activeTab.id, id: item.id });
        const payload = response.result || response;
        if (payload.items) currentItems = payload.items;
        render();
      });

      node.querySelector(".copy").addEventListener("click", (event) => copyText(event.currentTarget, item.url, "URL 복사"));

      const ffmpegButton = node.querySelector(".copyFfmpeg");
      ffmpegButton.hidden = !(item.kind === "hls-playlist" || item.kind === "dash-manifest" || item.kind === "video" || item.kind === "audio");
      ffmpegButton.addEventListener("click", (event) => copyText(event.currentTarget, utils.ffmpegCommand(item.url, item.fileName), "ffmpeg"));

      const curlButton = node.querySelector(".copyCurl");
      curlButton.hidden = item.protocol === "blob:";
      curlButton.addEventListener("click", (event) => copyText(event.currentTarget, utils.curlCommand(item.url, item.fileName), "curl"));

      const ytdlpButton = node.querySelector(".copyYtdlp");
      ytdlpButton.hidden = item.protocol === "blob:";
      ytdlpButton.addEventListener("click", (event) => copyText(event.currentTarget, utils.ytDlpCommand(commandUrl(item, false), item.fileName), "yt-dlp"));

      content.append(node);
    }
  }

  async function loadItems({ triggerScan } = { triggerScan: false }) {
    if (!activeTab?.id) return;
    if (triggerScan) {
      await sendTabMessage(activeTab.id, { type: "OVC_SCAN_NOW" });
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    const response = await sendRuntimeMessage({ type: "OVC_GET_TAB_MEDIA", tabId: activeTab.id });
    const payload = response.result || response;
    currentItems = payload.ok ? payload.items || [] : [];
    render();
  }

  refreshButton.addEventListener("click", () => loadItems({ triggerScan: true }));
  clearButton.addEventListener("click", async () => {
    if (!activeTab?.id) return;
    await sendRuntimeMessage({ type: "OVC_CLEAR_TAB", tabId: activeTab.id });
    currentItems = [];
    render();
  });
  hideSegments.addEventListener("change", render);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "OVC_TAB_MEDIA_UPDATED" && message.tabId === activeTab?.id) {
      loadItems({ triggerScan: false });
    }
  });

  async function init() {
    try {
      activeTab = await getActiveTab();
      await loadItems({ triggerScan: true });
    } catch (error) {
      setStatus(`초기화 실패: ${error.message}`);
    }
  }

  init();
})();
