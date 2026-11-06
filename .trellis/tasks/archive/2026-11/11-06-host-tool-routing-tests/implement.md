# Implement — Host Tool Routing Behavior Tests

## Preconditions

- Branch `beta`, base `beta`; worktree currently has 266 uncommitted changes.
  Do not clean or revert unrelated files.
- Read `prd.md` and `design.md` first; the seam choice is Design B.
- Nothing in this task changes wire protocol, command names, or user-visible
  messages.

## Baseline (capture before editing)

```bash
grep -rn --include='*.rs' -E '#\[(cfg\(test\)|test)\]' src-tauri/src | grep -v '\.mimosa' | wc -l   # expect 0
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -5                                # expect 0 tests
git status --short | wc -l                                                                         # expect 266
```

Record the three numbers in the session journal. If the test count is not
zero, stop and re-read the task: the premise changed.

## Steps

### 1. Extract the dispatch classifier

- Add `enum ToolDispatchKind` and
  `fn classify_tool_request(value: &Value) -> Option<ToolDispatchKind>` in
  `src-tauri/src/pi_worker_runtime/host_tool_routing.rs`.
- Move the `else if` ladder's predicates into it in the current order:
  background task → subagent worktree → codebase → LSP → memory → browser →
  web → MCP → gateway fallback.
- Replace the ladder with `match classify_tool_request(value)`.
- Add `classify_persisted_decision(result: Result<Option<String>, String>) -> Option<&str>`
  and route `lookup_persisted_permission` through it; keep the two stderr
  diagnostics identical.
- Verify: `cargo check --manifest-path src-tauri/Cargo.toml`.
- Review gate: diff must be predicate movement only.

### 2. Extract the plan

- Add `ToolRequestInput`, `ToolRequestPlan`, and `plan_tool_request`.
- Replace the ordering block in `resolve_tool_request` with:

  ```rust
  let plan = plan_tool_request(ToolRequestInput { ... });
  match plan { ... }
  ```

- The executor keeps exactly the existing `spawn_blocking` / `.await` calls and
  the existing failure strings.
- Verify: `cargo check` and
  `pnpm check:pi-compatibility`.
- Review gate: run `git diff -U0` and confirm no message literal changed.

### 3. Extract the post-hook selector

- Add `fn post_hook_event(status: Option<&str>, error_code: Option<&str>) -> Option<HookEvent>`.
- Replace the inline `if/else` chain in `send_tool_resolution`.
- Verify: `cargo check`.

### 4. Add the test module

- Append `#[cfg(test)] mod tests` to the routing file.
- Implement the 13-row matrix from `design.md`.
- Use plain paths and literals; no `tauri::test`, no `tempfile`.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml --lib` — all new
  tests pass, count > 0.

### 5. Mutation check (R2)

For each guard, apply a one-line temporary change, run only its test, observe
the failure, then revert:

| Guard | Neutralization | Must fail |
|-------|----------------|-----------|
| cwd descendant check | accept any authorized root | `cwd_outside_worker_root` |
| instruction-scope bypass | move it after the deny check | `instruction_scope_bypasses_deny` |
| hook precedence | check persisted deny before `pre_hook_blocked` | `hook_block_beats_allow_and_deny` |
| deny precedence | treat `deny` as a dispatch kind | `persisted_deny_beats_dispatch` |
| post-hook hook-blocked exclusion | return `PostToolUse` for `pi.hook_blocked` | `post_hook_selection` |

Record each failing assertion line in the journal. Re-run the full test module
after each revert.

### 6. Full gates

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml
pnpm check
pnpm check:architecture
pnpm lint
```

`cargo fmt --check` must include the test module; run it last.

### 7. Spec update

Add one line to `.trellis/spec/tauri-host/index.md` only if this task changes a
convention (for example, the first test module establishes a test-file
location). Do not restate the test matrix there.

## Rollback

- After step 1: revert the routing file (`git checkout -- src-tauri/src/pi_worker_runtime/host_tool_routing.rs`
  only if no other task changes are present in that file — otherwise reverse
  the edits manually).
- After step 2–3: the planner is additive; restore the original ordering block
  and delete the helpers. No schema or persistence change to unwind.
- Never roll back by reverting unrelated dirty files; the worktree predates
  this task.

## Review Gates

1. After step 1: predicate-only diff.
2. After step 3: no behavior change; `pnpm check:pi-compatibility` green.
3. After step 5: mutation evidence recorded.
4. Before commit: all gates from step 6 green.

## Out Of Scope

- CI changes, `pnpm test:unit` restoration, renderer tests, `tempfile`
  pre-addition, `AppDatabase::open_in_memory`, trait-object ports.

## Result (2026-11-07)

Implementation complete; task remains `in_progress` pending review/commit.

- `src-tauri/src/pi_worker_runtime/host_tool_routing.rs` is the only product file
  changed. `src-tauri/Cargo.toml` keeps a pre-existing dirty entry; no
  dev-dependency was added.
- Added `PersistedDecision` / `classify_persisted_decision`,
  `ToolDispatchKind` / `classify_tool_request`, `PreHookDecision`,
  `ToolRequestInput` / `ToolRequestPlan` / `plan_tool_request`, and
  `post_hook_event`.
- Added `#[cfg(test)] mod tests`: 15 tests, all pass.

### Gate output

| Command | Result |
|---------|--------|
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 15 passed, 0 failed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | pass |
| `cargo check --manifest-path src-tauri/Cargo.toml` | pass (via test build) |
| `pnpm check:architecture` | pass |
| `pnpm lint` | pass |
| `pnpm check:pi-compatibility` | pass |
| `pnpm check` | blocked by pre-existing TS error in `src/lib/melody-bridge-workspace.ts` (514): `ArrayBufferLike` not assignable to `ArrayBuffer` |

### Mutation evidence (R2)

| Guard neutralized | Test that failed | Observed assertion |
|-------------------|------------------|--------------------|
| descendant check (`Ok(root) if ...` -> `Ok(root)`) | `authorized_sibling_does_not_match_worker_root` | left `RunPreToolHooks { root: "/repo/other" }`, right `FailWorkspace(...)` |
| instruction-scope bypass (`if false && ...`) | `instruction_scope_bypasses_hooks_and_persisted_deny` | right `InstructionScope { root: "/repo/app" }` |
| hook precedence (`Blocked` -> no-op) | `hook_block_beats_persisted_allow_and_deny` | right `HookBlocked("hook denied")` |
| deny precedence (`"deny"` -> `"never"`) | `persisted_deny_beats_dispatch` | right `PersistedDeny` |
| post-hook exclusion (`if false`) | `post_hook_selection_covers_all_resolution_outcomes` | right `None` |

All mutations were reverted before the final suite run.
