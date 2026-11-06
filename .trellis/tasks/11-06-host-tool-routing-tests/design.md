# Design — Host Tool Routing Behavior Tests

## Current Structure

`resolve_tool_request(app, generation, value)` interleaves six concerns:

1. Resolve `worker_cwd` from `self.inner.process` (async, mutex).
2. Authorize `requested_cwd` through `app.try_state::<WorkspaceRegistry>()` and
   require the authorized root to equal or descend from `worker_cwd`.
3. Bypass everything for `is_instruction_scope_request`.
4. Run `PreToolUse` via `run_host_tool_hooks` (blocking thread, filesystem
   hook config) and short-circuit on `blocked`.
5. Read the persisted rule (`lookup_persisted_permission`), apply `deny`, or
   carry `allow` as an override.
6. Pick one dispatch branch (background / worktree / codebase / LSP / memory /
   browser / web / MCP / gateway), then deliver through
   `send_tool_resolution` and schedule an observational post hook.

Only step 6 is genuinely async or side-effecting. Steps 1–5 and the post-hook
choice are decision logic.

## Options

### A. End-to-end with a real worker child

Spawn the actual worker binary, drive a `tool.requested` event, assert the
stdout frame.

- Proves the whole chain.
- Requires a built worker, a real cwd, hook files, SQLite state, and timing.
- Deterministic failure modes are hard; the suite becomes the slowest test in
  the repo and duplicates `check-pi-compatibility`.
- Rejected for this task.

### B. Extract a pure planner + pure selectors (recommended)

Keep `resolve_tool_request` as the executor, but move every ordering decision
into pure functions that take explicit inputs and return a plan.

```rust
enum ToolRequestPlan {
    FailWorkspace(String),
    InstructionScope { root: PathBuf },
    RunPreToolHooks { root: PathBuf },
    HookBlocked(String),
    PersistedDeny,
    Dispatch { kind: ToolDispatchKind, root: PathBuf },
}

enum ToolDispatchKind {
    BackgroundTask,
    SubagentWorktree,
    Codebase,
    Lsp,
    Memory,
    Browser,
    Web,
    Mcp,
    Gateway,
}

fn plan_tool_request(input: ToolRequestInput<'_>) -> ToolRequestPlan;

struct ToolRequestInput<'a> {
    worker_cwd: Result<&'a Path, &'a str>,
    requested_cwd: Option<&'a str>,
    authorization: Option<Result<PathBuf, String>>, // None = registry unavailable
    instruction_scope: bool,
    pre_hook: PreHookDecision<'a>, // NotRun | Passed | Blocked(reason)
    persisted_decision: Option<&'a str>,
        // "allow" | "deny" | None (missing/invalid/failed lookup)
    dispatch: ToolDispatchKind,
}
```

Hooks are the one exception to "plan once". The executor calls
`plan_tool_request` with `PreHookDecision::NotRun`; if the result is
`RunPreToolHooks { root }`, it runs PreToolUse and calls the planner again with
`Passed` or `Blocked`. That keeps the instruction-scope bypass ahead of every
Hook without adding a second dispatch path.

The executor becomes:

```rust
let plan = plan_tool_request(...);
match plan {
    FailWorkspace(message) => send(fail_for_workspace(value, message)),
    InstructionScope => send(resolve_instruction_scope_request(...)),
    HookBlocked(reason) => send(fail_resolution(..., "pi.hook_blocked", reason)),
    PersistedDeny => send(deny_for_persisted_permission(value)),
    Dispatch(kind) => resolve_kind(kind, ...).await,
}
```

Additional pure selectors:

- `classify_tool_request(value) -> Option<ToolDispatchKind>` — holds the
  dispatch precedence currently encoded by the `else if` ladder.
  `None` means “not a tool request”.
- `classify_persisted_decision(Result<Option<String>, String>) -> Option<&str>` —
  maps DB results to `allow` / `deny` / interactive, preserving the
  “failure never widens permissions” invariant.
- `post_hook_event(status: Option<&str>, error_code: Option<&str>) -> Option<HookEvent>` —
  the four-way choice in `send_tool_resolution`.

Because `Dispatch(kind)` is produced by the same classifier the executor
matches, planner and executor cannot drift by construction.

- Proves ordering and precedence without a process.
- No trait objects, no async test runtime, no Tauri mock needed for the planner.
- Cost: a behavior-preserving move of branch selection out of the method.
- Chosen.

### C. Trait-object ports (`ToolRequestPorts`)

Abstract `worker_cwd`, `authorize`, `hooks`, `persisted`, `dispatch`, `deliver`
and test the executor against a fake.

- Proves delivery order, not just the plan.
- Requires converting a 683-line async method into generic/trait plumbing and
  touching every domain resolver call site.
- Larger blast radius than the task warrants; deferred. If the planner tests
  later prove insufficient, this is the follow-up.

## Chosen Design (B) — Details

### Invariants preserved

| Invariant | Where it now lives |
|-----------|--------------------|
| A lookup failure or invalid decision never widens permissions | `classify_persisted_decision` returns `None`; caller keeps the interactive request |
| Instruction-scope reads bypass hooks and persisted rules | `plan_tool_request` returns `InstructionScope` before consulting `pre_hook_*` / `persisted_decision` |
| PreToolUse can only deny inside the authorized root | authorization runs before `pre_hook_blocked` is consumed |
| `deny` beats `allow` beats prompt | explicit match order in `plan_tool_request` |
| Hook-blocked calls never produce a post hook | `post_hook_event(_, Some("pi.hook_blocked")) == None` |
| Resolution is delivered before observational hooks | unchanged executor tail (already ordered this way) |

### Test Module

Add at the bottom of `host_tool_routing.rs`:

```rust
#[cfg(test)]
mod tests { ... }
```

No `tauri::test`, no `tempfile` required: every planner test passes plain
`&Path` values and literals. If a later test needs a scratch directory, add
`tempfile` to `[dev-dependencies]` then — not preemptively.

### Test Matrix

| Test | Inputs | Assertion |
|------|--------|-----------|
| `worker_not_running` | `worker_cwd = Err(...)` | `FailWorkspace("Pi worker is not running")` |
| `registry_unavailable` | `requested_cwd = Some`, `authorization = None` | `FailWorkspace("Workspace authorization is unavailable.")` |
| `unauthorized_cwd` | `authorization = Err(registry_error)` | failure carries the registry message |
| `cwd_outside_worker_root` | authorized root = sibling | `does not match the active Pi worker workspace` |
| `cwd_is_descendant` | authorized root = `worker/a` | `Dispatch(Gateway)` |
| `instruction_scope_bypasses_deny` | instruction scope + `persisted = deny` + hook blocked | `InstructionScope` |
| `hook_block_beats_allow_and_deny` | hook blocked, `persisted = allow` | `HookBlocked` |
| `persisted_deny_beats_dispatch` | `deny`, regular tool | `PersistedDeny` |
| `persisted_allow_keeps_dispatch` | `allow`, memory write | `Dispatch(Memory)` |
| `invalid_decision_is_interactive` | `Ok(Some("ask"))` | `None` |
| `lookup_error_is_interactive` | `Err(...)` | `None` |
| `dispatch_precedence` | one value per tool family | expected `ToolDispatchKind` |
| `post_hook_selection` | four status/error pairs | expected `Option<HookEvent>` |

### Risks

- **Behavior drift during extraction.** Mitigation: extraction is mechanical;
  the executor's only new branch is `match plan`. Run `pnpm check:pi-compatibility`
  and `cargo test --lib` after each step.
- **Planner input becomes a god-struct.** Mitigation: it has six fields and no
  lifetimes beyond `&Path`/`&str`; do not add AppHandle or async.
- **False confidence.** Mitigation: R2 mutation check — neutralize each guard
  and prove the corresponding test fails.
- **Scope creep into `lookup_persisted_permission`.** Keep the DB call in
  place; only the result-to-decision mapping is extracted and tested.

### Rejected Details

- Adding `AppDatabase::open_in_memory`: only one caller needs it, and the
  planner does not; revisit if persistence itself needs coverage.
- Moving the module into a directory: unnecessary for one test module.

## Verification

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml
pnpm check:pi-compatibility
pnpm check:architecture
pnpm lint
```
