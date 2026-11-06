# Baseline Triage (2026-11-07)

Restored from `HEAD`; no product behavior was changed.

## Suite results

| Suite | Tests | Pass | Fail | Exit |
|-------|-------|------|------|------|
| `pnpm test:unit` | 321 | 273 | 48 | 1 |
| `pnpm test:projection` | 24 | 24 | 0 | 0 |
| `pnpm test:agent-worker` | 68 | 65 | 3 | 1 |
| `cargo test --lib` | 19 | 19 | 0 | 0 |

Note: `workspace_runtime_tests.rs` is restored but not wired; wiring it fails compilation with 8 errors, so `cargo test --lib` currently runs the routing + git tests only.

## Summary

| Category | Files |
|----------|-------|
| PASS | 47 |
| API_DRIFT | 8 |
| OBSOLETE | 1 |
| NEEDS_REWRITE | 0 |
| RUNNER | 0 |

## Files

| Category | File | Evidence |
|----------|------|----------|
| API_DRIFT | `packages/agent-worker/src/pi/compaction-extension.test.mjs` | SyntaxError: './goal-extension.ts' does not provide an export named 'GOAL_STATE_ENTRY' |
| API_DRIFT | `packages/agent-worker/src/pi/goal-extension.test.mjs` | SyntaxError: './goal-extension.ts' does not provide an export named 'GOAL_STATE_ENTRY' |
| API_DRIFT | `packages/agent-worker/src/pi/session-adapter.test.mjs` | SyntaxError: './session-adapter.ts' does not provide an export named 'applyModelPolicyOverrides' |
| API_DRIFT | `src-tauri/src/workspace_runtime_tests.rs` | missing read_workspace_binary_bytes, collect_tree, terminal_command, wait_for_terminal_exit (moved to workspace submodules) |
| API_DRIFT | `src/domain/agent/capability-report.test.mjs` | TypeError: Cannot read properties of undefined (reading 'filter') |
| API_DRIFT | `src/domain/agent/event-store-adapter.test.mjs` | AssertionError: actual undefined, expected a defined cursor/checkpoint |
| API_DRIFT | `src/domain/agent/explorer-branch.test.mjs` | SyntaxError: './explorer-branch.ts' does not provide an export named 'MAX_EXPLORER_BRING_BACK_CODEPOINTS' |
| API_DRIFT | `src/domain/agent/projection-store-patch.test.mjs` | AssertionError: actual undefined, expected 'ready' |
| OBSOLETE | `src-tauri/src/acp_policy_tests.rs` | not restored: orphan in HEAD (no acp_policy.rs, no #[path] wiring) |
| PASS | `packages/agent-contract/src/capabilities.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-contract/src/validation.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/idempotency.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/main.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/event-mapper.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/instruction-scope-extension.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/model-catalog.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/session-import.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/subagent-policy.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/todo-extension.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/pi/tool-gateway.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/transport.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `packages/agent-worker/src/worker-smoke.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src-tauri/src/git_runtime_tests.rs` | cargo test --lib: 4/4 (19 total with routing tests) |
| PASS | `src/domain/agent/command-validation.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/event-checkpoint.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/event-log.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/event-projector.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/event-stream.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/event-to-session-update.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/legacy-acp-adapter.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/legacy-command-adapter.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/model-catalog.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/pi-model-options.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/pi-session-import.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/recovery-coordinator.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/recovery.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/session-archive.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/session-migration.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/agent/subagent-projection.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/melody-capability-lifecycle.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/message-citations.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/model-provider.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/plan-approval.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/prompt-timeout.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/request-gate.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/research-source-adapter.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/session-mode.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/session-projection.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/task-launch.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/timeline-groups.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/tool-activity.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/domain/user-question.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/features/files/file-preview-utils.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/features/research/research-capability.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/features/research/research-project-workflow.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
| PASS | `src/features/research/research-query.test.mjs` | no failure reported in test:unit / test:projection / test:agent-worker |
