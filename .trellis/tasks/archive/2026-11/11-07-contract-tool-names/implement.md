# Implement — Contract Tool Name Table

## Preconditions

- HEAD is `c18feee3`; worktree clean.
- Read `prd.md` and `design.md`. The 44/2/4 split and the Rust gap are already
  measured; do not re-investigate.
- Ask before committing.

## Baseline capture

```bash
pnpm check:pi-compatibility          # expect pass
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -2
```

## Step 1 — Contract module

Create `packages/agent-contract/src/tool-names.ts`.

- `AGENT_TOOL_NAMES`: 44 entries, exactly the current advertised set
  (`PI_GATEWAY_TOOL_NAMES` order + `todo_write` + `update_goal`).
- `AGENT_INTERNAL_TOOL_NAMES`: 2 entries.
- `AGENT_WORKER_ONLY_TOOL_NAMES`: 4 entries.
- `AgentToolName`, `AgentAdvertisedToolName`, `isAgentToolName`,
  `isAgentAdvertisedToolName`.

Copy the existing doc comments from `tool-names.ts` where they explain a name's
origin; do not lose the reasons.

Export from `src/index.ts`:

```ts
export * from "./tool-names.ts";
```

Verify: `pnpm check:agent-contract`.

## Step 2 — Derive worker constants

Edit `packages/agent-worker/src/pi/tool-names.ts`:

- Import `AGENT_TOOL_NAMES`, `AGENT_INTERNAL_TOOL_NAMES`, and the types.
- Build an explicit typed record keyed by every advertised name.
- Set each `PI_*` constant from that record (internal ones from the internal
  record).
- Annotate `PI_GATEWAY_TOOL_NAMES` as `readonly AgentAdvertisedToolName[]`.
- Keep `PI_BACKGROUND_TERMINAL_TASK_PREFIX` local.

Verify:

```bash
pnpm check:agent-worker
node --experimental-strip-types -e "import('./packages/agent-worker/src/pi/tool-names.ts').then(m => console.log(m.PI_GATEWAY_TOOL_NAMES.length))"
```

Expect 42.

**Review gate:** `tsc` must prove every constant is a union member. If a
constant widened to `string`, the derivation is wrong; fix it before moving on.

## Step 3 — Rust checker

Create `scripts/pi-tool-names-compatibility.mjs` as a pure function:

```js
export const checkPiToolNamesCompatibility = ({
  contract,
  requestPolicy,
  codebaseRuntime,
  lspRuntime,
  manifestTools,
}) => failures;
```

Rules (see `design.md` §3). Parse with:

```js
const rustConstant = /pub\(crate\) const [A-Z_]+: &str = "([^"]+)";/gu;
```

Verify by running it directly against the current sources before wiring:

```bash
node --experimental-strip-types --input-type=module -e "..."
```

Expect zero failures on the clean tree.

## Step 4 — Wire the checker

In `check-pi-compatibility.mjs`, import the new checker at the top with the
other `checkPi*` imports, then call it after the manifest↔worker tool block,
passing `requestPolicy`, `codebaseRuntime`, `lspRuntime`, and
`manifest.worker?.tools`.

Add the file to `check:pi-compatibility`'s Prettier list in `package.json`, plus
`format` and `format:check`.

Verify: `pnpm check:pi-compatibility` passes.

## Step 5 — Prove the gate (R5)

Two probes, each reverted immediately:

1. `request_policy.rs`: rename `"workspace_read_file"` to
   `"workspace_read_file_RENAMED"` → `pnpm check:pi-compatibility` must fail.
2. `tool-names.ts`: rename the same constant's value → must also fail.

Record both outputs in `implement.md`. This is the acceptance evidence: before
this task, probe 1 passed silently.

## Step 6 — Full gates

```bash
pnpm check
pnpm test:unit
pnpm test:agent-worker
pnpm test:projection
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm lint
pnpm check:architecture
pnpm format:check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

No test file should need changing. If one does, stop: the contract changed
behavior, which R6 forbids.

## Step 7 — Spec update

Add to `.trellis/spec/agent-contract/index.md` a short section: tool names live
in `tool-names.ts`; worker constants derive from it; Rust is validated by
`scripts/pi-tool-names-compatibility.mjs`. One paragraph, no duplication of the
table.

## Rollback

- The contract file is additive; delete it and the export line.
- `tool-names.ts` derivation reverts to literals.
- The checker is one import plus one call; remove both.
- No manifest, protocol, or routing change to unwind.

## Out Of Scope

- Renaming constants.
- Code generation for Rust.
- Deleting the manifest.
- The other three consolidation steps.
- Committing without approval.

## Result (2026-11-07)

Implemented; task remains `in_progress`; no commit.

### Files

| File | Change |
|------|--------|
| `packages/agent-contract/src/tool-names.ts` | new: `AGENT_TOOL_NAMES` (44), `AGENT_WORKER_OWNED_TOOL_NAMES` (6), `AGENT_INTERNAL_TOOL_NAMES` (2), union types, guards |
| `packages/agent-contract/src/index.ts` | `export * from "./tool-names.ts"` |
| `packages/agent-worker/src/pi/tool-names.ts` | every `PI_*` constant annotated with the contract union; gateway list typed `readonly AgentAdvertisedToolName[]` |
| `scripts/pi-tool-names-compatibility.mjs` | new: pure checker over source snapshots |
| `scripts/check-pi-compatibility.mjs` | imports and calls the checker; monitor check reduced to dispatch-only |
| `package.json` | checker added to `format`, `format:check`, `check:pi-compatibility` |

### Deviation from the plan

The plan listed 4 worker-owned names. Measurement showed `todo_write` and
`update_goal` are also worker-resolved (Pi extensions; `src-tauri` has no
reference to them), so the set is 6. The checker caught this: it initially
reported both as missing Rust constants.

A second finding: the existing `monitor` check hardcoded
`export const PI_MONITOR = "monitor"`, which Prettier's reformatting broke. That
check now asserts only `toolGateway.includes("MONITOR => ")`; name agreement is
owned by the new checker.

### Probe evidence (R5)

| Mutation | Gate result |
|----------|-------------|
| `request_policy.rs`: `"workspace_read_file"` → `"workspace_read_file_RENAMED"` | **fails**: `契约工具 workspace_read_file 在 Host 路由策略中没有常量。` + `Host 路由策略包含契约外的工具 workspace_read_file_RENAMED。` |
| `tool-names.ts`: same rename | **fails**: 3 messages from the manifest/runtime comparison |

Before this task, the first probe exited 0.

### Gates

| Command | Result |
|---------|--------|
| `pnpm check` | pass |
| `pnpm test:unit` | 398/398 |
| `pnpm test:agent-worker` | 140/140 |
| `pnpm test:projection` | 24/24 |
| `cargo test --lib` | 26/26 |
| `pnpm lint` | pass |
| `pnpm check:architecture` | pass |
| `pnpm format:check` | pass |
| `cargo fmt --check` | pass |

No test file required a semantic change; one Prettier reformat only.
