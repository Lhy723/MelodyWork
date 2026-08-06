# Development Guide

This guide covers local setup, everyday validation commands, and how MelodyWork prepares the `melody-pager` sidecar.

## Prerequisites

- Node.js 22
- pnpm
- Rust toolchain
- [DotSlash](https://dotslash-cli.com)
- ripgrep
- Tauri 2 system dependencies for your platform

The project pins Melody Build as the `vendor/melody-build` Git submodule. Initialize it on a fresh clone or whenever its pinned revision changes:

```bash
git submodule update --init --recursive
pnpm install
cargo install dotslash --locked
```

## Common Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the Vite frontend development server. |
| `pnpm tauri dev` | Build or refresh the sidecar, then launch the desktop application. |
| `pnpm check` | Run the TypeScript type check. |
| `pnpm test:unit` | Run frontend and domain unit tests. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust tests. |
| `pnpm build` | Produce a production frontend build. |

Windows users need a system `git` installation available on `PATH` for Git workspace features.

## Sidecar Behavior

`pnpm tauri dev` incrementally builds the local `melody-build` debug sidecar before launching Tauri and Vite. Preparing the sidecar first avoids file-watcher changes repeatedly reopening the application during startup.

For local development and direct Rust builds, MelodyWork resolves the `melody-pager` sidecar from the first usable source below:

1. `MELODY_PAGER_SOURCE`, when it points to a local executable
2. The incrementally compiled `vendor/melody-build/target/debug` output
3. A compatible sibling `melody-build/target/debug` or `target/release` output
4. `~/.melody/bin/melody` on macOS/Linux or `%USERPROFILE%\\.melody\\bin\\melody.exe` on Windows
5. The legacy `~/.grok/bin/grok` fallback
6. An existing `src-tauri/binaries/melody-pager-$TARGET_TRIPLE` binary

Running `cargo build` or `cargo check --manifest-path src-tauri/Cargo.toml` also invokes `src-tauri/build.rs` to prepare a matching sidecar. If no usable artifact exists, run `node scripts/prepare-sidecar.mjs` first or set `MELODY_PAGER_SOURCE`.
