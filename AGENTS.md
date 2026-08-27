# Repository Workflow

## Branches and releases

- Start every product change on `beta`; do not develop directly on `main`.
- Publish test builds from `beta` before promoting their changes.
- Do not merge or sync `beta` into `main`, and do not create a stable release, unless the user explicitly requests a formal release to `main`.
- A test version uses `X.Y.Z-beta.N`. Its formal promotion uses the same base version, `X.Y.Z`, on `main` (for example, `0.3.1-beta.2` promotes to `0.3.1`).
- Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` on the same release version.
