# Release checklist

1. Update versions together with SemVer:

```bash
npm version <version> --no-git-tag-version
# then update manifest.json version if npm did not do it automatically
```

2. Run local verification:

```bash
npm ci
npm run verify
unzip -l dist/open-video-catcher-chrome-edge.zip
unzip -l dist/open-video-catcher-firefox.zip
```

3. Commit and push to `main` via PR or protected workflow.

4. Tag the release:

```bash
git tag v$(node -p "require('./package.json').version")
git push origin --tags
```

5. Ensure the `GitHub Release Assets` workflow publishes unsigned ZIPs.

6. Ensure `Sign Firefox and Publish Update Channel` succeeds after AMO secrets are configured.

7. Verify the hosted update channel:

```bash
curl -fsSL https://solitude0429.github.io/open-video-catcher/updates.json
curl -fsSLO https://solitude0429.github.io/open-video-catcher/open-video-catcher-firefox.xpi
sha256sum open-video-catcher-firefox.xpi
```

The `update_hash` in `updates.json` must match the signed XPI bytes exactly.
