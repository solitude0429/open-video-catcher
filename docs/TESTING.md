# Testing

Run all local checks:

```bash
npm ci
npm run verify
```

The verify command performs:

- manifest/project validation
- JavaScript syntax checks
- unit tests for media URL classification, redaction, command generation, HLS parsing, and DASH parsing
- Chrome/Edge and Firefox runtime packaging
- strict `web-ext lint --self-hosted --warnings-as-errors`
- `npm audit --audit-level=moderate`

Manual browser smoke test:

1. Load the unpacked Chrome/Edge build from `dist/build/chrome-edge` or Firefox build from `dist/build/firefox`.
2. Open a page with accessible media.
3. Play the video/audio.
4. Open the extension popup.
5. Confirm detected items show source, kind, quality/analysis when applicable.
6. Test URL copy, `ffmpeg`, `curl`, and `yt-dlp` buttons.
7. For HLS/DASH, click `playlist 분석` and verify variants/representations appear.
