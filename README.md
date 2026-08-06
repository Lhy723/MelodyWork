![MelodyWork](docs/images/melodywork-hero.png)

# MelodyWork

> A local-first desktop workspace for building with [Melody Build](https://github.com/Lhy723/melody-build).

MelodyWork brings the full agent loop into one focused desktop application: talk through a task, review the change, inspect files, run commands, and ship from the project you already have on disk. It is designed to keep developer control close at hand, with Git-native workflows and explicit permission boundaries.

**Local-first · Agent collaboration · Git-native · Built for delivery**

## What You Can Do

| Area | Capabilities |
| --- | --- |
| **Agent sessions** | Start and resume ACP stdio sessions with the bundled `melody-pager`, stream responses and tool activity, and handle permission requests in context. |
| **Project control** | Work across multiple projects and sessions with local SQLite persistence and a shared project directory by default. |
| **Git workflow** | Inspect repository state and per-file diffs, stage changes, commit, and manage branches and user-created worktrees. |
| **Files and terminal** | Edit workspace-bounded text files, preview supported files, and run commands deliberately from an integrated terminal panel. |
| **Research workspace** | Collect research context, organize source material, and keep the investigation beside the implementation work. |
| **Configuration** | Manage user and project `config.toml` files; discover MCP servers, Skills, Plugins, and Hooks in the workspace. |
| **Permissions** | Allow or deny actions once, for a session, or for a project. Project rules remain inspectable and removable. |

## Principles

- **Your code stays yours.** Projects, session state, and working data are kept locally. MelodyWork has no account system or cloud sync in the current beta.
- **The repository is the source of truth.** Git status, diffs, commits, branches, and worktrees are first-class rather than an afterthought.
- **Automation stays visible.** Tool calls, terminal activity, file changes, and permission requests remain reviewable in the same workspace.
- **Serious work deserves a serious surface.** The interface is purpose-built for sustained engineering work, not a thin chat wrapper around a shell.

## Quick Start

### Prerequisites

- Node.js 22
- pnpm
- Rust toolchain
- [DotSlash](https://dotslash-cli.com)
- ripgrep
- Tauri 2 system dependencies for your platform

`melody-build` is pinned as the `vendor/melody-build` Git submodule. Initialize it on a fresh clone or after its pinned revision changes:

```bash
git submodule update --init --recursive
pnpm install
cargo install dotslash --locked
pnpm tauri dev
```

`pnpm tauri dev` incrementally builds the local `melody-build` debug sidecar before launching Tauri and Vite. This order prevents file-watcher changes from repeatedly reopening the app while the sidecar is being prepared.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the Vite frontend development server. |
| `pnpm tauri dev` | Build or refresh the sidecar, then launch the desktop application. |
| `pnpm check` | Run the TypeScript type check. |
| `pnpm test:unit` | Run frontend and domain unit tests. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust tests. |
| `pnpm build` | Produce a production frontend build. |

Windows users need a system `git` installation available on `PATH` for the Git workspace features.

### Sidecar Resolution

For local development and direct Rust builds, MelodyWork resolves the `melody-pager` sidecar from the first usable source below:

1. `MELODY_PAGER_SOURCE`, when it points to a local executable
2. The incrementally compiled `vendor/melody-build/target/debug` output
3. A compatible sibling `melody-build/target/debug` or `target/release` output
4. `~/.melody/bin/melody` on macOS/Linux or `%USERPROFILE%\\.melody\\bin\\melody.exe` on Windows
5. The legacy `~/.grok/bin/grok` fallback
6. An existing `src-tauri/binaries/melody-pager-$TARGET_TRIPLE` binary

Running `cargo build` or `cargo check --manifest-path src-tauri/Cargo.toml` also invokes `src-tauri/build.rs` to prepare a matching sidecar. When no usable artifact exists, run `node scripts/prepare-sidecar.mjs` first or set `MELODY_PAGER_SOURCE`.

## Releases and Updates

Pushing a `v*` tag starts the GitHub Actions release workflow. It builds the pinned Melody sidecar for Apple Silicon macOS, Intel macOS, and x64 Windows, produces signed update bundles and `latest.json`, then creates a beta draft release. Publishing that release makes it the updater's latest version.

Before the first release, generate a Tauri updater key and configure:

- Repository variable `TAURI_UPDATER_PUBLIC_KEY`: the complete generated `.pub` file, Base64 encoded, matching `tauri.conf.json`
- Secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Never commit the private key. MelodyWork checks the GitHub Release `latest.json` at startup and offers an in-app installation path when a newer version is available.

The current macOS beta is not signed with an Apple Developer ID or notarized. On first launch, macOS may require opening the app through Finder or confirming it in **System Settings → Privacy & Security**. The Tauri updater key verifies update bundles; it does not replace Apple platform signing.

## Status

MelodyWork is in active beta. The goal is a dependable local environment for working with Melody Build, while the product surface and release workflow continue to evolve.

---

Built around [Melody Build](https://github.com/Lhy723/melody-build), with a little more room to think, review, and deliver.
