# Release Guide

This guide covers the GitHub Actions release flow and the configuration required for signed Tauri updates.

## Release Flow

Pushing a `v*` tag starts the GitHub Actions release workflow. It builds the pinned Melody sidecar for Apple Silicon macOS, Intel macOS, and x64 Windows, produces signed update bundles and `latest.json`, then creates a beta draft release. Publishing that draft makes it the updater's latest release.

## Required Configuration

Before the first release, generate a Tauri updater key and configure the repository with:

- Variable `TAURI_UPDATER_PUBLIC_KEY`: the complete generated `.pub` file, Base64 encoded, matching `tauri.conf.json`
- Secret `TAURI_SIGNING_PRIVATE_KEY`
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Never commit the private key. MelodyWork checks the GitHub Release `latest.json` at startup and offers an in-app installation path when a newer version is available.

## macOS Beta Note

The current macOS beta is not signed with an Apple Developer ID or notarized. On first launch, macOS may require opening the app through Finder or confirming it in **System Settings → Privacy & Security**. The Tauri updater key verifies update bundles; it does not replace Apple platform signing.
