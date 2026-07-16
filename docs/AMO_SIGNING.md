# AMO signing and Firefox self-hosted updates

Open Video Catcher is prepared for Mozilla Add-ons unlisted signing and self-hosted Firefox updates.

## What is automated

The workflow `.github/workflows/sign-firefox.yml`:

1. Checks out an explicit SemVer tag and verifies that the tag, `package.json`, lockfile, and extension manifest versions match.
2. Builds and validates deterministic Chrome/Edge and Firefox runtime packages without AMO credentials.
3. Transfers a SHA-256-verified signing bundle to the protected `amo-signing` environment.
4. Runs the lockfile-installed `web-ext sign --channel unlisted` using AMO JWT credentials, with no checkout or dependency install in the secret-bearing job.
5. Derives `updates.json` version, add-on ID, compatibility floor, and SHA-512 hash from the exact signed XPI bytes.
6. Attests the exact signed update-channel checksums and appends matching signed Firefox assets to the existing GitHub Release without replacing conflicting bytes.
7. Publishes checksums, source metadata, `updates.json`, and the signed XPI to GitHub Pages in separate non-secret assembly/deploy jobs.

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
3. Create a GitHub environment named `amo-signing`, require a reviewer, and disable administrator bypass.
4. Add these **environment secrets** to `amo-signing`:
   - `AMO_JWT_ISSUER` — AMO JWT issuer, commonly shaped like `user:<digits>:<digits>`.
   - `AMO_JWT_SECRET` — the matching AMO JWT secret.

Do not paste those secrets into chat.

## Trigger signing

After the environment secrets and a protected SemVer tag exist, run the workflow from the default branch while naming the exact tag:

```bash
gh workflow run sign-firefox.yml --ref main -f tag=v0.2.8
```

Then verify:

```bash
gh run list --workflow sign-firefox.yml --limit 3
gh run view <run-id> --json status,conclusion,url
curl -I https://solitude0429.github.io/open-video-catcher/updates.json
curl -I https://solitude0429.github.io/open-video-catcher/open-video-catcher-firefox.xpi
curl -fsS https://solitude0429.github.io/open-video-catcher/SHA256SUMS
```

Existing Firefox installs that predate `update_url` need one manual install of the signed XPI containing that URL. After that, future versions update through the hosted `updates.json` channel.
