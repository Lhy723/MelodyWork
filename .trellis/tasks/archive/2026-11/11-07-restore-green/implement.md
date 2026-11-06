# Implement — Restore Green

## Preconditions

- HEAD is `752995b6` (baseline). Worktree clean except this task directory.
- Read `prd.md`. The nine causes are already located; do not re-investigate.
- Verify each fix individually before moving to the next.

## Baseline snapshot

```bash
pnpm exec tsc --noEmit 2>&1 | head -5
pnpm test:unit 2>&1 | grep -E 'ℹ (tests|pass|fail)'
pnpm test:agent-worker 2>&1 | grep -E 'ℹ (tests|pass|fail)'
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -3
```

Expect: TS error, 321/273/48, 68/65/3, 19 passed.

## Step 1 — Type error (R1)

`src/lib/melody-bridge-workspace.ts:514`

```ts
return new TextEncoder().encode(`Browser preview: ${root}/${path}`).buffer;
```

`Uint8Array<ArrayBufferLike>.buffer` is not assignable to `ArrayBuffer`. Use a
concrete construction rather than a cast:

```ts
const bytes = new TextEncoder().encode(`Browser preview: ${root}/${path}`);
return bytes.buffer as ArrayBuffer;
```

Prefer the narrowest form that satisfies `tsc` without widening the return type.
Verify: `pnpm exec tsc --noEmit`.

## Step 2 — Re-exports (R2)

### 2a. `GOAL_STATE_ENTRY`

`packages/agent-worker/src/pi/goal-state.ts:4` exports it; both tests import it
from `goal-extension.ts`.

Add to `goal-extension.ts`:

```ts
export { GOAL_STATE_ENTRY } from "./goal-state.ts";
```

Verify:
`node --experimental-strip-types --test packages/agent-worker/src/pi/goal-extension.test.mjs`
and the same for `compaction-extension.test.mjs`.

### 2b. `applyModelPolicyOverrides`

Lives at `packages/agent-worker/src/pi/model-policy.ts:47`; the test imports it
from `session-adapter.ts`.

Add to the existing re-export block in `session-adapter.ts`:

```ts
export { applyModelPolicyOverrides } from "./model-policy.ts";
```

Verify:
`node --experimental-strip-types --test packages/agent-worker/src/pi/session-adapter.test.mjs`.

## Step 3 — Renamed fields (R3)

### 3a. `event-store-adapter.test.mjs:55`

`finished.patch.acpPhase` → `finished.patch.runtimePhase`.

### 3b. `projection-store-patch.test.mjs`

- `patch.acpCursor` → `patch.eventCursor` (line 48)
- `patch.acpPhase` → `patch.runtimePhase` (lines 47, 86, 87 — check each)

Verify: `node --experimental-strip-types --test src/domain/agent/projection-store-patch.test.mjs`
and `... event-store-adapter.test.mjs`.

### 3c. Confirm the persistence columns are untouched

`pi-session-import.test.mjs` and `session-migration.test.mjs` use `acpCursor`
for the **persisted** record shape (`src/domain/session-migration.ts:14`,
`src/domain/workspace.ts:28`). Those are real columns; do not rename them.
If they still fail, record the reason before editing anything.

## Step 4 — `mcpServers` (R3)

`src/domain/agent/capability-report.test.mjs` calls
`inspectPiCapabilityReport` 52 times; only 2 pass `mcpServers`.

Add `mcpServers: []` to the calls that omit it. Do not change the production
signature: `src/lib/pi-compatibility.ts:113` is the single real caller and it
supplies the field.

A mechanical approach: locate each `inspectPiCapabilityReport({` call, insert
`mcpServers: [],` after `extensions:` when absent, then verify. Do not add a
test-local wrapper that silently defaults — that would hide the same drift next
time.

Verify: `node --experimental-strip-types --test src/domain/agent/capability-report.test.mjs`.

## Step 5 — Explorer conclusion (R4, decision gate)

Gather evidence before touching code:

```bash
git log --oneline -S'appendExplorerConclusionToDraft' -- src/domain/agent/explorer-branch.ts
grep -rn 'appendExplorerConclusionToDraft' src packages --include=*.ts --include=*.tsx | grep -v '.test.mjs'
grep -n 'bringBack' src/features/chat/agent-workspace.tsx src/features/chat/agent-timeline.tsx
```

Decision:

| Evidence | Action |
|----------|--------|
| UI affordance still present, no production appender | Product regression → restore `MAX_EXPLORER_BRING_BACK_CODEPOINTS` + `appendExplorerConclusionToDraft` from `7e89d128`, wire it into `bringBack`, keep tests |
| UI affordance removed | Tests obsolete → delete the 3 conclusion tests, record `OBSOLETE` |

Restoring from history:

```bash
git show 7e89d128:src/domain/agent/explorer-branch.ts | sed -n '1p;67,95p'
```

Copy the constant and function, keep the existing file's style, then verify
`node --experimental-strip-types --test src/domain/agent/explorer-branch.test.mjs`.

**Review gate:** record the decision and its evidence in `implement.md` before
continuing.

## Step 6 — Rust workspace tests (R5)

Re-export the four helpers at the module boundary:

```rust
pub(crate) use workspace_files::{collect_tree, read_workspace_binary_bytes};
pub(crate) use workspace_terminal::{terminal_command, wait_for_terminal_exit};
```

Then append:

```rust
#[path = "workspace_runtime_tests.rs"]
mod tests;
```

Verify:
`cargo test --manifest-path src-tauri/Cargo.toml --lib`.
If a re-export collides with an existing `pub use` list, merge into it instead
of adding a second statement.

## Step 7 — Full gates

```bash
pnpm check
pnpm test:unit
pnpm test:agent-worker
pnpm test:projection
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm lint
pnpm check:architecture
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

## Step 8 — Update triage

In `.trellis/tasks/11-07-baseline-recovery/triage.md`, move each fixed row to
`PASS` and add the final suite numbers. Keep the `OBSOLETE` row if Step 5 chose
deletion.

## Rollback

- `git checkout -- <file>` per file; the baseline commit is the reference.
- If a re-export causes a cycle, `pnpm check:architecture` will report it —
  revert that single line.
- The Explorer restoration (if chosen) is additive and removable.

## Out Of Scope

- Concept consolidation.
- New tests.
- Making `mcpServers` optional in production.
- Committing.

## Result (2026-11-07)

All gates green. Task remains `in_progress`; no commit.

### Fixes

| # | File | Change |
|---|------|--------|
| 1 | `src/lib/melody-bridge-workspace.ts` | typed the preview buffer instead of returning `ArrayBufferLike` |
| 2 | `packages/agent-worker/src/pi/goal-extension.ts` | re-exported `GOAL_STATE_ENTRY`, goal-state helpers, and goal-guard helpers |
| 3 | `packages/agent-worker/src/pi/session-adapter.ts` | re-exported `applyModelPolicyOverrides`, `loadPiModelPolicies`, `settingsOverridesForModel`, `piSkillPathsFor`, `piPromptPathsFor`, `piSubagentRecordFileFor`, `parsePersistedPiSubagentRecord` |
| 4 | `packages/agent-worker/src/pi/session-adapter.test.mjs` | reached the new owners: `subagents.tasks`, `subagents.taskController`, `sessionEvents.handle`, `modelCatalog.getModelRuntime` |
| 5 | `src/domain/agent/capability-report.test.mjs` | added the required `mcpServers` inventory to every call; 4 cases realigned to the Host-inventory contract |
| 6 | `src/domain/agent/event-store-adapter.test.mjs` | `acpPhase` → `runtimePhase` |
| 7 | `src/domain/agent/projection-store-patch.test.mjs` | `acpCursor` → `eventCursor`, `acpPhase` → `runtimePhase` |
| 8 | `src/domain/agent/explorer-branch.ts` + `src/features/chat/pi-session-explorer.ts` | restored the conclusion appender and wired it into `bringBack` (R4 decision below) |
| 9 | `src-tauri/src/workspace_runtime.rs` | `#[cfg(test)]` re-exports for the four moved helpers; test module wired |

### R4 decision: product regression, not test drift

Evidence:

- `bringBackExplorerConclusion` is still wired in
  `src/features/chat/agent-workspace.tsx:196,519`.
- `agent-timeline.tsx` still renders the affordance
  (`canBringBack` requires `onBringBack` and a valid anchor).
- No production caller of `appendExplorerConclusionToDraft` remained, so
  bring-back silently inserted only a session reference and dropped the branch
  answer.
- `7e89d128` had both the constant and the appender.

Decision: restore the appender and call it before appending the reference. The
three tests are legitimate coverage, not obsolete.

### Gate output

| Command | Result |
|---------|--------|
| `pnpm check` | pass |
| `pnpm test:unit` | 398 passed, 0 failed |
| `pnpm test:agent-worker` | 140 passed, 0 failed |
| `pnpm test:projection` | 24 passed, 0 failed |
| `cargo test --lib` | 26 passed, 0 failed |
| `pnpm lint` | pass |
| `pnpm check:architecture` | pass |
| `cargo fmt --check` | pass |

`triage.md` now shows 55 PASS, 0 API_DRIFT, 1 OBSOLETE.
