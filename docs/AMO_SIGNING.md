# AMO signing and Firefox self-hosted updates

Open Video Catcher is prepared for Mozilla Add-ons unlisted signing and self-hosted Firefox updates.

## What is automated

The workflow `.github/workflows/sign-firefox.yml`:

1. Builds and validates the Firefox runtime package.
2. Runs `web-ext sign --channel unlisted` using AMO JWT credentials.
3. Renames the signed XPI to `open-video-catcher-firefox.xpi`.
4. Generates `updates.json` with the exact SHA-256 hash of that signed XPI.
5. Publishes `updates.json` and the signed XPI to GitHub Pages.

The extension ID is stable:

```text
open-video-catcher@solitude0429.github.io
```

The update URL embedded in the Firefox manifest is:

```text
https://solitude0429.github.io/open-video-catcher/updates.json
```

## Required manual step

Mozilla developer registration cannot be completed by the agent because it requires the user's Mozilla account, terms acceptance, and usually 2FA. Do this once:

1. Create/sign in to a Mozilla Add-ons developer account.
2. Create AMO API JWT credentials.
3. Add these GitHub repository secrets:
   - `AMO_JWT_ISSUER` — AMO JWT issuer, commonly shaped like `user:<digits>:<digits>`.
   - `AMO_JWT_SECRET` — the matching AMO JWT secret.

Do not paste those secrets into chat.

## Trigger signing

After the secrets exist and the `main` branch is protected, run:

```bash
gh workflow run sign-firefox.yml --ref main
```

Then verify:

```bash
gh run list --workflow sign-firefox.yml --limit 3
gh run view <run-id> --json status,conclusion,url
curl -I https://solitude0429.github.io/open-video-catcher/updates.json
curl -I https://solitude0429.github.io/open-video-catcher/open-video-catcher-firefox.xpi
```

Existing Firefox installs that predate `update_url` need one manual install of the signed XPI containing that URL. After that, future versions update through the hosted `updates.json` channel.
