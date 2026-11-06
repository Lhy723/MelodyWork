# Contract Tool Name Table

## Goal

Make the tool-name vocabulary a single declared contract instead of three
hand-maintained copies, and close the gap where a renamed Rust Host constant
passes every check.

## Background (verified 2026-07-11 on `c18feee3`)

Measured sets:

| Group | Count | Current home |
|-------|-------|--------------|
| Advertised to the Host | 44 | `PI_GATEWAY_TOOL_NAMES` (42) + `PI_TODO_WRITE` + `PI_UPDATE_GOAL` |
| Internal, never advertised | 2 | `workspace_create_subagent_worktree`, `melody_internal_instruction_scope` |
| `manifest.worker.tools` | 44 | `docs/architecture/pi-migration/pi-compatibility-manifest.json` — already equal to the advertised set |
| Rust `request_policy.rs` constants | 38 | 36 advertised + 2 internal |
| Rust handled elsewhere | 2 | `codebase_navigation` (`pi_codebase_runtime.rs`), `lsp` (`pi_lsp_runtime.rs`) |
| Worker-owned (advertised, not Host-routed) | 4 | `task`, `get_task_output`, `wait_tasks`, `kill_task` |

### The gap

Probe results (both reverted immediately):

| Mutation | `check-pi-compatibility` |
|----------|--------------------------|
| `tool-names.ts`: `"workspace_read_file"` → `"workspace_read_file_RENAMED"` | **fails** with 3 messages |
| `request_policy.rs`: `"workspace_read_file"` → `"workspace_read_file_RENAMED"` | **passes** (exit 0) |

`check-pi-compatibility.mjs:1396` compares the manifest against worker-side
sources only (adapter text, extensions, worker gateway). No rule reads the 40
Rust constants, and no rule compares them to the TypeScript names. The 33
shared values agree today purely because a human kept them in sync.

## Requirements

**R1 — Declare the table in the contract package.** Add
`packages/agent-contract/src/tool-names.ts` exporting:

- `AGENT_TOOL_NAMES` — the 44 advertised names, as a `const` tuple.
- `AGENT_INTERNAL_TOOL_NAMES` — the 2 internal bridge names.
- `AGENT_WORKER_OWNED_TOOL_NAMES` — the 4 names the worker resolves itself
  (they are still advertised, so they are a subset of `AGENT_TOOL_NAMES`).
- `AgentToolName` / `AgentAdvertisedToolName` union types.
- `isAgentToolName` / `isAgentAdvertisedToolName` guards, matching the style
  already used in `session-modes.ts` (`isAgentSessionModeId`).

Export them from `src/index.ts`, next to the existing
`AGENT_SESSION_MODE_IDS` re-export.

**R2 — Derive the worker constants.** `packages/agent-worker/src/pi/tool-names.ts`
keeps its `PI_*` constant names (5 modules and the gateway import them; renaming
would touch ~300 references for no behavioral gain) but each value comes from
the contract:

```ts
export const PI_WORKSPACE_READ_FILE: AgentToolName = AGENT_TOOL_NAMES[0];
```

Prefer an explicit mapping over positional indexing if the tuple order ever
needs to change; a `Record<AgentToolName, AgentToolName>` identity map or direct
literals checked by the compiler are both acceptable. The hard requirement is
that a worker constant can no longer hold a value outside the contract union.

**R3 — Build the gateway list from the contract.** `PI_GATEWAY_TOOL_NAMES`
must be provably a subset of `AGENT_TOOL_NAMES` (the compiler enforces this once
the element type is `AgentToolName`).

**R4 — Validate the Rust side.** Add
`scripts/pi-tool-names-compatibility.mjs`, following the existing child-checker
pattern (`export const checkPiToolNamesCompatibility = (manifest, sources) =>
failures[]`), and call it from `check-pi-compatibility.mjs`. It must:

1. Parse `pub(crate) const NAME: &str = "value";` from
   `src-tauri/src/pi_tool_gateway/request_policy.rs`.
2. Parse `CODEBASE_TOOL` and `LSP_TOOL` from their modules.
3. Import `AGENT_TOOL_NAMES` + `AGENT_INTERNAL_TOOL_NAMES` from the contract.
4. Fail when:
   - an advertised name has no Rust constant and is not in
     `AGENT_WORKER_OWNED_TOOL_NAMES`;
   - a Rust constant's value is not in the contract table;
   - the manifest's `worker.tools` differs from `AGENT_TOOL_NAMES`.

**R5 — Prove the gate works.** The two probes above must now behave
symmetrically: mutating either side fails the check. Record both outputs.

**R6 — No behavior change.** Tool names, advertised sets, capability
announcements, and routing outcomes stay byte-identical. `pnpm check`,
`pnpm test:unit`, `pnpm test:agent-worker`, `cargo test --lib`, `pnpm lint`,
`pnpm check:architecture` all pass.

**R7 — Keep the manifest.** Do not delete
`pi-compatibility-manifest.json`; `check-agent-packaging.mjs` also reads it.
`worker.tools` becomes a value validated against the contract rather than an
independent source of truth.

## Non-Goals

- Renaming `PI_*` or Rust constants.
- Merging the worker-only aliases into the gateway set.
- Deleting the manifest.
- Touching the renderer's `tool-activity.ts` heuristic (it infers operations
  from names by regex; the contract table is not a substitute).
- The other three consolidation steps (model policy, event mapping, subagent
  policy).

## Acceptance Criteria

- [ ] `packages/agent-contract/src/tool-names.ts` exists and is exported from
      `src/index.ts`.
- [ ] Every `PI_*` tool constant in `tool-names.ts` is typed by the contract
      union; `pnpm check:agent-worker` proves it.
- [ ] `PI_GATEWAY_TOOL_NAMES` elements are `AgentToolName`.
- [ ] `scripts/pi-tool-names-compatibility.mjs` is wired into
      `check-pi-compatibility.mjs` and formatted.
- [ ] Mutating `request_policy.rs` fails the gate; mutating `tool-names.ts`
      fails the gate. Both outputs recorded.
- [ ] Contract and worker test suites pass; no existing test changes required.
- [ ] Full gate set green.

## Constraints

- Branch `beta`; base `beta`.
- Contract package stays dependency-free and NodeNext with `.ts` specifiers.
- Do not introduce a code generator; explicit declarations are preferred.
- The Rust side is validated by the script, not by a new build dependency.
