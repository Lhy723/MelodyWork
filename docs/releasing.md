# Release Guide

This guide covers the GitHub Actions release flow and the configuration required for signed Tauri updates.

## Release Flow

MelodyWork uses two long-lived release branches:

- `main` is the **stable** line. It is the source of every formal release.
- `beta` is the **test** line. Test changes and prerelease versions are prepared here before they are promoted to `main`.

### Required development order

1. Start every product change on `beta`, then publish and verify a beta build there.
2. Do not merge or sync `beta` into `main` unless a formal release has been explicitly requested.
3. A beta version is `X.Y.Z-beta.N`; when it is promoted, publish `X.Y.Z` from `main`. The base version must remain the same: for example, `0.3.1-beta.2` promotes to `0.3.1`.

Pushing a version tag starts the GitHub Actions release workflow. It builds the pinned Melody sidecar for Apple Silicon macOS, Intel macOS, and x64 Windows, then produces signed update bundles and `latest.json`. The workflow rejects a tag that does not belong to its intended branch.

- On `main`, `vX.Y.Z` publishes a **stable** release. Its signed manifest is available from GitHub's `releases/latest` endpoint.
- On `beta`, `vX.Y.Z-beta.N` publishes a **beta** prerelease. The workflow also replaces the signed manifest in the persistent `update-beta` prerelease, which gives beta-channel clients a stable endpoint without making a beta release the stable latest release.

The tag must match the version in `package.json` and `src-tauri/tauri.conf.json`. Use a matching beta version in those files before creating a beta tag. When a beta is accepted, merge the tested changes into `main`, replace the prerelease version with the final version, then create the stable tag.

## Required Configuration

Before the first release, generate a Tauri updater key and configure the repository with:

- Variable `TAURI_UPDATER_PUBLIC_KEY`: the complete generated `.pub` file, Base64 encoded, matching `tauri.conf.json`
- Secret `TAURI_SIGNING_PRIVATE_KEY`
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Never commit the private key. MelodyWork checks the signed manifest for the channel selected in **Settings → General → Update channel** and offers an in-app installation path when a newer version is available. Stable is the default; beta receives prerelease builds sooner and may contain unresolved issues.

## macOS Update Note

The current macOS builds are not signed with an Apple Developer ID or notarized. On first launch, macOS may require opening the app through Finder or confirming it in **System Settings → Privacy & Security**. The Tauri updater key verifies update bundles; it does not replace Apple platform signing.
