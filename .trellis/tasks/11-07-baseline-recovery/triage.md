# Baseline Triage (2026-11-07)

Restored from `HEAD`; no product behavior was changed.

## Suite results

| Suite | Tests | Pass | Fail | Exit |
|-------|-------|------|------|------|
| `pnpm test:unit` | 398 | 398 | 0 | 0 |
| `pnpm test:projection` | 24 | 24 | 0 | 0 |
| `pnpm test:agent-worker` | 140 | 140 | 0 | 0 |
| `cargo test --lib` | 26 | 26 | 0 | 0 |

Note: `workspace_runtime_tests.rs` is now wired; `cargo test --lib` runs routing, git, and workspace tests (26 total).

## Summary

| Category | Files |
|----------|-------|
| PASS | 55 |
| API_DRIFT | 0 |
| OBSOLETE | 1 |
| NEEDS_REWRITE | 0 |
| RUNNER | 0 |

## Files

| Category | File | Evidence |
|----------|------|----------|
| PASS | `packages/agent-worker/src/pi/compaction-extension.test.mjs` | re-exported GOAL_STATE_ENTRY from goal-extension.ts |
| PASS | `packages/agent-worker/src/pi/goal-extension.test.mjs` | re-exported goal-state/goal-guards helpers from goal-extension.ts |
| PASS | `packages/agent-worker/src/pi/session-adapter.test.mjs` | re-exported model/discovery/record helpers; tests use subagents.taskController, sessionEvents.handle, modelCatalog.getModelRuntime |
| PASS | `src-tauri/src/workspace_runtime_tests.rs` | re-exported the four helpers under #[cfg(test)]; module wired |
| PASS | `src/domain/agent/capability-report.test.mjs` | added required mcpServers inventory to 52 calls; aligned 4 cases to the Host-inventory contract |
| PASS | `src/domain/agent/event-store-adapter.test.mjs` | acpPhase -> runtimePhase |
| PASS | `src/domain/agent/explorer-branch.test.mjs` | restored MAX_EXPLORER_BRING_BACK_CODEPOINTS and appendExplorerConclusionToDraft; wired into bringBack |
| PASS | `src/domain/agent/projection-store-patch.test.mjs` | acpCursor -> eventCursor, acpPhase -> runtimePhase |
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
