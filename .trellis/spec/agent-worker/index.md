# Agent Worker Guidelines (`@melody/agent-worker`)

Node process that hosts the Pi agent runtime and speaks the JSONL protocol from
`@melody/agent-contract`. The Tauri host spawns it; the renderer never imports
it.

## Scope

| Path                 | Owns                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `src/main.ts`        | Process entry: stdin loop, command dispatch, event emission               |
| `src/transport.ts`   | JSONL framing, size limits, backpressure                                  |
| `src/protocol.ts`    | Worker-side protocol interfaces (`WorkerCommandHandler`, `WorkerEmitter`) |
| `src/idempotency.ts` | Duplicate-command protection                                              |
| `src/pi/**`          | Everything that touches the Pi SDK                                        |

`pnpm --filter @melody/agent-worker start` runs
`node --experimental-strip-types src/main.ts`.

## Pre-Development Checklist

- [ ] Does the change need the Pi SDK? If yes it goes under `src/pi/`; that
      boundary is enforced (`scripts/check-architecture.mjs`).
- [ ] Does it add a command or event? Update `@melody/agent-contract` first,
      then the `dispatch` switch, then the renderer consumer.
- [ ] Does it add a tool? Update `src/pi/tool-names.ts`, the gateway case
      (`src/pi/tool-gateway.ts`), and the `worker.tools` list in
      `docs/architecture/pi-migration/pi-compatibility-manifest.json`.
- [ ] Does it change capabilities or the Pi version? Update the manifest and
      run `pnpm check:pi-compatibility`.

## Quality Check

```bash
pnpm check:agent-worker     # tsc --noEmit, NodeNext, strict
pnpm check:architecture     # Pi SDK confinement + runtime cycles
pnpm test:agent-worker      # 12 pure worker files, ~0.5s
pnpm test:smoke             # main.test.mjs + worker-smoke.test.mjs, spawns processes
pnpm check                  # includes check:pi-compatibility
```

`test:agent-worker` owns every worker test that does not spawn a process; the
two that do (`main.test.mjs`, `worker-smoke.test.mjs`) live in the root
`test:smoke` so fast feedback stays fast. Add a new worker test to
`packages/agent-worker/package.json`'s `test` script — not to the root
`test:unit`. The Pi compatibility script remains the regression gate for
protocol/adapter drift.

## Runtime Shape

### Entry and emission

`src/main.ts`:

- Reads stdin frames, validates each with `validateAgentCommandEnvelope`, then
  gates it with `assertAgentCommandCapabilities(frame, adapter.health())`.
- Dispatches on `command.type`; returns `true` from `dispatch` for
  `runtime.shutdown`.
- Emits envelopes with a stable identity:
  `workerEpoch` (one `randomUUID()` per process) + incrementing `sequence` →
  `eventId = "${workerEpoch}:${sequence}"`, mirrored into `sourceEventId`.
  Every event carries `protocolVersion`, optional
  `sessionId`/`streamSessionId`/`runId`/`requestId`, and `replay`.

Do not invent a second event identity scheme; the renderer's event log and
replay checkpoints rely on ordinal + epoch (`src/domain/agent/event-log.ts`).

### Error shape

`errorFor` preserves a structured error when the adapter attached one:

```ts
const errorFor = (
  error: unknown,
  scope: AgentError["scope"] = "runtime",
): AgentError =>
  (error as { agentError?: AgentError }).agentError ?? {
    code: "pi.worker_error",
    message: error instanceof Error ? error.message : String(error),
    retriable: false,
    scope,
  };
```

New failure paths should attach `agentError` with a stable `code` and
`retriable`; the message is user-facing and will be rendered through
`toUserMessage`.

### Transport rules

`src/transport.ts`:

- `MAX_FRAME_BYTES = 1024 * 1024` — one frame, excluding newline/UTF-8
  overhead. Both `encodeJsonLine` and `parseJsonLine` enforce it and throw a
  Chinese, actionable message.
- `JsonlWriter` respects `write()` backpressure by awaiting `"drain"`; do not
  write to `process.stdout` directly.
- A frame handler may return `false` to stop consuming stdin
  (`runtime.shutdown`). Frames already dispatched are awaited; later frames are
  never admitted. Preserve that ordering.

### Pi boundary

Only `src/pi/**` may import `@earendil-works/pi-*`. The check is
`workerBoundaryViolations` in `scripts/check-architecture.mjs`. If a generic
module needs a Pi type, define a local structural type or move the logic into
`src/pi/`; do not re-export the SDK.

Adapter files are named by responsibility (`session-*-runtime.ts`,
`tool-*.ts`, `subagent-*.ts`, `model-*.ts`). A new session feature usually
belongs in an existing runtime file rather than a new one.

### Tools

- Tool names are constants in `src/pi/tool-names.ts` (`PI_WORKSPACE_READ_FILE`,
  `PI_ASK_USER_QUESTION`, ...). Consumers import the constant; no string
  literals.
- `src/pi/tool-gateway.ts` is the single dispatch point for Host tools and
  applies `sessionModeAllowsTool` / `subagentCapabilityAllowsTool`.
- Schemas live in `src/pi/tool-schemas.ts`; results in `tool-results.ts`;
  policy errors in `tool-errors.ts`.
- The manifest's `worker.tools` array is compared against the adapter's
  announced set by `scripts/check-pi-compatibility.mjs`
  (`manifest.worker.tools` loop at ~line 1396). Adding a tool without updating
  the manifest fails the check.
