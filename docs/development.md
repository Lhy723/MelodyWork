# Development Guide

This guide covers local setup and everyday validation commands for the Pi-only desktop runtime.

## Prerequisites

- Node.js 22
- pnpm
- Rust toolchain
- Bun 1.3 or later (used to build the bundled Pi worker)
- Git (workspace Git features and Git Marketplace sources)
- Tauri 2 system dependencies for your platform

Install frontend dependencies with `pnpm install` after cloning. The retired `vendor/melody-build` submodule has been removed; it is not part of setup, build, or runtime.

## Common Commands

| Command                                           | Purpose                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                                        | Run the Vite frontend development server.                           |
| `pnpm tauri dev`                                  | Prepare the Pi worker, then launch the desktop application.         |
| `pnpm tauri:clean`                                | Remove the Rust build target used by Tauri.                         |
| `pnpm check`                                      | Run the TypeScript type check.                                      |
| `pnpm check:ui-font`                              | Check for UI font overrides that bypass the configured font preset. |
| `pnpm test:unit`                                  | Run frontend and domain unit tests.                                 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust tests.                                                     |
| `pnpm build`                                      | Produce a production frontend build.                                |

## Runtime and Build Notes

`pnpm tauri dev` prepares the bundled Pi worker before launching Tauri and Vite. The worker is built with Bun; release builds bundle a target-specific worker, so end users do not need Bun. Marketplace operations are implemented in the Host and use the system Git executable only for Git-based sources. No Melody Build sidecar is compiled, resolved, or launched.

The development wrapper keeps Cargo's incremental cache unless `MELODY_CLEAN_TAURI_TARGET=1` is set. To keep the cache even when that override is configured, set `MELODY_KEEP_TAURI_TARGET=1`. Clean the Tauri target manually with `pnpm tauri:clean`.
