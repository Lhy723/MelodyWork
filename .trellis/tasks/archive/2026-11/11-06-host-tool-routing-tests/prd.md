# Host Tool Routing Behavior Tests

## Goal

Give `PiWorkerRuntime::resolve_tool_request` direct behavior coverage for the
decision order that governs every Host-backed Pi tool call:

workspace authorization → instruction-scope bypass → enforceable PreToolUse →
persisted permission precedence → Host dispatch → worker resolution and
post-hook selection.

Today that order exists only as control flow inside a 683-line async method
(`src-tauri/src/pi_worker_runtime/host_tool_routing.rs`) and cannot be executed
without a running Pi child process.

## Background (verified 2026-11-06, this worktree)

- `src-tauri/src/pi_worker_runtime/host_tool_routing.rs` is 683 lines; it has
  no `#[cfg(test)]` module.
- `src-tauri/src` contains **zero** `#[test]` / `#[cfg(test)]` entries, so
  `cargo test --lib` currently runs no tests.
- `progress.md` and `findings.md` describe `pnpm test:unit`, `.test.mjs`
  suites, and “direct tests” in `pi_tool_gateway.rs` / `event_pipeline.rs`.
  Those files are not present in this checkout. Plans must not depend on them.
- `src-tauri/Cargo.toml` already declares
  `[dev-dependencies] tauri = { version = "2", features = ["test"] }`.
- The routing method's real dependencies are `self.worker_cwd(generation)`,
  `AppHandle`-managed `WorkspaceRegistry` and `AppDatabase`,
  `pi_hook_runtime::run_tool_hooks`, eight Host domain resolvers, and
  `self.write_frame(...)`.

## Requirements

**R1 — Executable precedence.** Each precedence rule below becomes a test that
asserts the resulting resolution, not the presence of source code.

| # | Situation | Required outcome |
|---|-----------|------------------|
| 1 | Worker generation is not running | workspace failure (`"Pi worker is not running"`) |
| 2 | `WorkspaceRegistry` state is absent | workspace failure (`"Workspace authorization is unavailable."`) |
| 3 | Requested cwd is not registered | workspace failure carrying the registry error |
| 4 | Requested cwd is an authorized path outside the worker cwd | workspace failure (`"...does not match the active Pi worker workspace."`) |
| 5 | Requested cwd is the worker cwd or a descendant | request proceeds |
| 6 | Instruction-scope read | resolved by `resolve_instruction_scope_request`; PreToolUse and persisted deny are skipped |
| 7 | PreToolUse returns a blocking decision | `pi.hook_blocked`, and no PostToolUse hook is scheduled |
| 8 | Persisted decision is `deny` | denied before any dispatch branch runs |
| 9 | Persisted decision is `allow` + the tool normally requires permission | the permission prompt is bypassed |
| 10 | Persisted decision is missing or invalid | request stays interactive; invalid values emit a stderr diagnostic |
| 11 | Persisted lookup fails | request stays interactive; no permission widening |
| 12 | Background-task control / subagent worktree / codebase / LSP / memory / browser / web / MCP / regular tool | dispatch kind chosen by one documented precedence, not by branch order drift |
| 13 | Resolution delivery | `pi.hook_blocked` → no post hook; `pi.permission_denied` → `PermissionDenied`; `completed` → `PostToolUse`; otherwise `PostToolUseFailure` |

**R2 — Tests must be able to fail.** For each guard, a temporary one-line
neutralization must make its test fail. Record the observed failing assertion
in `implement.md` or the session journal.

**R3 — No behavior change.** Command names, JSON shapes, permission outcomes,
error codes, and user-visible messages stay identical. `pnpm check:pi-compatibility`
must still pass.

**R4 — Smallest seam.** Extracting a pure decision function (plus pure
selectors) is allowed. Introducing a trait-object port layer, a new command, or
a second dispatch implementation is not allowed unless `design.md` justifies it
and the user approves.

**R5 — Real commands only.** Verification uses:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm check:architecture
pnpm lint
```

## Non-Goals

- End-to-end tests that spawn a real Pi worker process.
- Testing the renderer, the wire protocol package, or the Pi SDK.
- Broad structural refactoring of `host_tool_routing.rs` or the eight domain
  resolvers.
- Making `cargo test` a CI gate in this task.
- Fixing the stale `progress.md` / `findings.md` claims about a test suite.

## Acceptance Criteria

- [x] A `#[cfg(test)]` module exists with at least one test per row in R1.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --lib` passes and
      reports the new tests (not zero).
- [x] The R2 mutation check was performed and its evidence recorded.
- [x] `cargo fmt --check`, `pnpm check:architecture`, and `pnpm lint` pass;
      `pnpm check` is blocked by a pre-existing TS error outside this task.
- [x] The diff touches only the routing module, its test module, and (only if
      needed) `[dev-dependencies]` in `src-tauri/Cargo.toml`.
- [x] `design.md` records the chosen seam and the rejected alternatives.

## Constraints

- Branch `beta`; base branch `beta`. No commit, push, or release unless asked.
- Do not modify product behavior to make a test pass.
- Do not add a TypeScript test runner.
- Keep tests deterministic and independent of network, user home directory, and
  wall-clock timing.
