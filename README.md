# Open Video Catcher

CocoCut처럼 현재 탭에서 로드되는 비디오/오디오 리소스를 최대한 많이 감지하고 다운로드/외부 도구 명령을 제공하는 Manifest V3 브라우저 확장 프로그램입니다.

## 기능

- **감지 시작** 버튼을 누른 경우에만 현재 탭을 일정 시간 감지
- 페이지의 `<video>`, `<audio>`, `<source>`, 직접 미디어 링크 감지
- 감지 창이 열린 동안 브라우저 네트워크 요청에서 `mp4`, `webm`, `m4v`, `mov`, `mp3`, `m4a`, `m3u8`, `mpd` 등 감지
- 감지 창이 열린 동안 페이지 내부 `fetch`, `XMLHttpRequest`, `URL.createObjectURL`, Performance resource entry hook으로 동적 플레이어 URL 추가 감지
- page hook은 `scripting.executeScript(..., world: "MAIN")`로 먼저 주입하고, 실패 시 content script fallback을 사용
- 빈 결과일 때 site access, content/main-world hook, page/network 후보 수를 팝업 진단으로 표시
- HLS `.m3u8` playlist 자동 분석: master/media playlist, variant 품질, bandwidth, segment 수, 암호화 표시 감지
- DASH `.mpd` manifest 분석: representation 수, 해상도/bitrate, ContentProtection 표시 감지
- 팝업에서 감지된 항목 목록, MIME/크기/출처/품질/분석 결과 표시
- 일반 HTTP(S) 비디오/오디오 파일 직접 다운로드
- HLS/DASH는 `.m3u8`/`.mpd` 파일을 영상으로 오인해 저장하지 않도록 직접 다운로드를 막고 `ffmpeg`/`yt-dlp` 명령 복사 제공
- MIME type과 `Content-Disposition`을 반영한 파일명/확장자 추정
- `URL`, `ffmpeg`, `curl`, `yt-dlp` 명령 복사
- 민감한 CDN 쿼리스트링은 화면 표시에서 `?…`로 마스킹하면서 실제 다운로드 URL은 보존
- 아이콘 포함: 16/32/48/96/128 PNG + SVG 원본
- 외부 서버/텔레메트리 없음

## 동작 범위

다운로더로서 브라우저 확장이 할 수 있는 감지 경로는 최대한 켰습니다. 이 프로젝트는 현재 브라우저 세션이 실제로 로드하는 미디어 URL과 playlist를 찾아내는 방식입니다. v0.2.3부터는 항상 감시하지 않고, 사용자가 팝업에서 **감지 시작**을 누른 현재 탭만 짧은 시간 감지합니다.

- 정적 `<video src>`/`<source src>`/직접 링크는 재생 전에도 감지될 수 있습니다.
- HLS/DASH/MSE 플레이어는 실제 playlist·segment URL을 재생/seek 시점에 만드는 경우가 많아, **감지 시작 후 재생 또는 seek**가 필요할 수 있습니다.
- `blob:` URL은 원본 주소가 아니라 브라우저 메모리 객체입니다. page-hook이 `fetch`/`XHR`/network 쪽 원본 URL을 같이 잡도록 보강했습니다.
- HLS/DASH는 playlist/manifest를 분석하고 `ffmpeg`/`yt-dlp` 명령을 복사할 수 있습니다. 브라우저 다운로드 버튼은 `.m3u8`/`.mpd`를 최종 영상 파일처럼 저장하지 않도록 비활성화합니다.
- 암호화/ContentProtection 표시는 분석 결과에 보여줍니다.

## 설치: Chrome / Edge

1. GitHub Release 또는 빌드 결과의 `open-video-catcher-chrome-edge.zip`을 압축 해제합니다.
2. `chrome://extensions` 또는 `edge://extensions`로 이동합니다.
3. **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램 로드**를 누르고 압축 해제한 폴더를 선택합니다.

## 설치: Firefox 임시 로드

1. GitHub Release 또는 빌드 결과의 `open-video-catcher-firefox.zip`을 압축 해제합니다.
2. `about:debugging#/runtime/this-firefox`로 이동합니다.
3. **임시 부가 기능 로드**를 누르고 압축 해제한 폴더의 `manifest.json`을 선택합니다.

정식 Firefox 배포/업데이트 채널은 `docs/AMO_SIGNING.md`를 따릅니다. Firefox ESR/Release 140 이상에서 설치되도록 manifest 호환 버전을 맞춥니다.

## 사용법

1. 다운로드하려는 페이지를 엽니다.
2. 툴바의 **Open Video Catcher** 아이콘을 누릅니다.
3. **감지 시작**을 누릅니다.
4. 정적 파일/링크는 바로 잡힐 수 있습니다. 플레이어가 URL을 늦게 만드는 사이트는 감지 시작 후 영상을 재생하거나 seek 합니다.
5. 목록에서 `파일 다운로드`, `URL 복사`, `ffmpeg`, `curl`, `yt-dlp`, `playlist 분석`을 사용합니다.
6. 항목이 없으면 페이지를 새로고침한 뒤 **감지 시작 → 재생/seek** 순서로 다시 시도합니다.

## 개발 명령

```bash
npm ci
npm run verify
```

개별 명령:

```bash
npm run validate:manifest
npm run lint
npm test
npm run build
npm run lint:webext
npm audit --audit-level=moderate
```

빌드 결과는 `dist/open-video-catcher-chrome-edge.zip`과 `dist/open-video-catcher-firefox.zip`에 생성됩니다.

## Firefox 업데이트 채널

Firefox manifest에는 안정적인 add-on ID와 self-hosted update URL이 들어 있습니다.

```text
open-video-catcher@solitude0429.github.io
https://solitude0429.github.io/open-video-catcher/updates.json
```

AMO unlisted signing과 GitHub Pages 업데이트 배포는 `.github/workflows/sign-firefox.yml`에서 처리합니다. AMO 계정 등록과 `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` repository secrets 추가는 사용자가 직접 해야 합니다.

## 권한 설명

- `activeTab`: 사용자가 확장 아이콘/팝업을 연 현재 탭에 수동 감지 스크립트를 주입
- `scripting`: **감지 시작**을 누른 순간에만 content/page hook 스크립트 주입
- `webRequest`: 감지 창이 열린 현재 탭에서 로드되는 미디어/playlist 요청 감지. 요청/응답 URL과 MIME/크기/파일명 헤더를 확장 내부 목록에만 사용합니다.
- `downloads`: 사용자가 직접 누른 일반 HTTP(S) 비디오/오디오 파일 저장
- `tabs`: 현재 활성 탭 확인 및 해당 탭의 감지 목록 표시
- `<all_urls>`: 여러 사이트의 CDN/미디어 도메인까지 감지하는 범용 다운로더라 필요합니다. 특정 사이트 전용으로 줄이고 싶다면 `manifest.json`의 `host_permissions`를 해당 도메인으로 바꾸면 됩니다.
- `web_accessible_resources`: 페이지 컨텍스트의 `fetch`/`XHR`를 관찰하는 `page/page-hook.js`를 주입하기 위해 필요합니다.

## 데이터 처리

- Firefox manifest의 `data_collection_permissions.required`는 `none`입니다.
- 쿠키 권한, debugger 권한, request rewriting 권한은 사용하지 않습니다.
- 감지된 URL은 외부 서버로 보내지 않고 현재 브라우저 확장 메모리 안에서만 팝업 표시/다운로드/복사에 사용합니다.
- URL 수집은 사용자가 **감지 시작**을 누른 현재 탭의 감지 창 동안만 수행합니다.
- CDN 서명/토큰 쿼리스트링은 화면 표시에서 마스킹하지만, 사용자가 다운로드/복사 버튼을 누를 때 실제 URL은 보존합니다.
