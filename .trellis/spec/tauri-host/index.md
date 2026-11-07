# Tauri Host Guidelines (`src-tauri/`)

Rust host for the desktop app: window, worker supervision, SQLite, filesystem,
git, and every privileged operation the renderer can request.

## Scope

| Path | Owns |
|------|------|
| `src-tauri/src/lib.rs` | App setup and the `invoke_handler!` registration list |
| `src-tauri/src/*.rs` | Command modules (`agent_session_lifecycle.rs`, `git_runtime.rs`, `config_*.rs`, ...) |
| `src-tauri/src/pi_worker_runtime/` | Pi worker process, stdio protocol, event persistence |
| `src-tauri/src/pi_tool_gateway/` | Host-side tool implementations (`workspace_tools.rs`, `terminal_tasks.rs`, `monitor_tools.rs`, `scheduler_tools.rs`) |
| `src-tauri/src/database*`, `database/**` | SQLite access (`AppDatabase`) |
| `src-tauri/permissions/default.toml` | Main-window command allowlist |
| `src-tauri/src/workspace_sandbox/` | Path containment / sandbox checks |

The host is not a second product layer: it validates, persists, and forwards.
Protocol semantics live in `@melody/agent-contract`; session policy lives in the
worker.

## Pre-Development Checklist

- [ ] New command has all four pieces: the `#[tauri::command]` function, the
      `lib.rs` registration, the `permissions/default.toml` allowlist entry, and
      a typed wrapper in `src/lib/melody-bridge-*.ts`.
- [ ] Paths and session ids from the renderer are validated against the
      workspace registry / SQLite binding before filesystem or worker access.
- [ ] Return type is `Result<T, String>` with an actionable message, not a
      panic, `unwrap`, or `expect` on user input.
- [ ] Ran `pnpm check:pi-compatibility`, which includes the command-permission
      cross-check.

## Quality Check

**Prerequisite:** the agent-worker sidecar is gitignored. Run
`pnpm prepare:agent-worker` once (requires Bun 1.3+) before any cargo command,
or the build script fails with `resource path ... doesn't exist`.

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm check:pi-compatibility
```

CI runs both `cargo test --lib` and `cargo fmt --check` for Rust
(`.github/workflows/check.yml`), after `pnpm prepare:agent-worker`. Rust tests
are inline `#[cfg(test)] mod tests` in the module that owns the behavior; the
first one is `pi_worker_runtime/host_tool_routing.rs` (pure decision tests, no
`tauri::test`). `tauri` is already a dev-dependency with the `test` feature
enabled, so a test that needs an `AppHandle` can use `tauri::test`; add
`tempfile` to `[dev-dependencies]` only when a test needs a scratch directory.
Run touched tests explicitly:
`cargo test --manifest-path src-tauri/Cargo.toml --lib`.

## Command Contract

```rust
/// Delete a product session only after stopping its Pi worker and removing the
/// exact opaque Pi artifacts associated with that session.
#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    database: State<'_, AppDatabase>,
    runtime: State<'_, PiWorkerRuntime>,
    id: String,
) -> Result<(), String> {
    let (cwd, engine) = {
        let connection = database
            .connection
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        ...
    };
    ...
}
```

Conventions visible across the command modules:

- Commands are named in snake_case and exported from a module that owns one
  domain (`delete_session`, `pi_worker_status`, `git_stage`, `list_projects`).
- Long-running work is `pub async fn`; managed state arrives as
  `State<'_, AppDatabase>` / `State<'_, PiWorkerRuntime>`.
- Errors are `String`. Infrastructure messages are plain English
  (`"Database lock poisoned"`, `"Session does not exist"`); validation messages
  aimed at the user are Chinese (`"Pi dispatch state is unavailable"` is the
  exception, not the rule). Either way the renderer's
  `src/domain/app-error.ts` converts them to product copy, so do not try to
  match the renderer's Chinese wording here.
- `//!` module documentation explains the invariant the module enforces
  (`pi_worker_runtime/session_commands.rs` documents why renderer-supplied paths
  never reach the worker unchecked).
- Never hold a `MutexGuard` across an `.await`; scope the database lock in a
  block and drop it before async work (`delete_session` does this).

## Registration And Permissions

A command is callable only when it appears in both:

1. `src-tauri/src/lib.rs` → `tauri::generate_handler![ ... ]`
2. `src-tauri/permissions/default.toml` → `commands.allow = [ ... ]`

`scripts/tauri-command-permission-check.mjs` (invoked by
`scripts/check-pi-compatibility.mjs`) parses both lists plus every
`invoke("<name>")` in `src/**/*.ts(x)` and fails when an invoked command is
registered but not allowlisted:

```text
前端调用的 Tauri 命令 <name> 未加入主窗口权限白名单。
```

The allowlist is intentionally explicit — "only the commands used by the
MelodyWork main window" is the stated policy in `default.toml`. Do not widen it
by wildcard; add the one command.

## Renderer Contract

The renderer side of a command is a typed wrapper in
`src/lib/melody-bridge-<domain>.ts`:

```ts
export const sendPiAgentCommand = async (command: AgentCommandEnvelope): Promise<void> => {
  if (!isTauriRuntime()) throw new Error("Pi worker 仅在桌面运行时可用。");
  await invoke("send_pi_agent_command", { command });
};
```

Keep the preview-mode branch in the bridge, validate payloads before `invoke`
(the command envelope is validated in `src/lib/agent-client.ts`), and never
call `invoke` from a feature component. See
`../frontend/conventions.md#tauri-access`.

## Host-Side Preflight

Before forwarding a renderer command to the worker,
`pi_worker_runtime/session_commands.rs` resolves the product session id to its
registered workspace and validates the session/binding records. Commands in
`SESSION_BOUND_PI_COMMANDS` (`session.close`, `session.configure`,
`session.fork`, `turn.submit`, ...) additionally get session preflight.

When adding a command that takes a path, cwd, or session id:

- Resolve it against `WorkspaceRegistry`, not against the raw string.
- Reject traversal/absolute escapes using the `workspace_sandbox` helpers.
- Do not trust a renderer-supplied migration plan or import payload without
  `validate_pi_session_*` / `validate_pi_migration_import`.
