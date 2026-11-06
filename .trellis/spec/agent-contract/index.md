# Agent Contract Guidelines (`@melody/agent-contract`)

The single source of truth for the renderer ↔ worker wire protocol. The
renderer reaches it through `src/domain/agent/contract.ts`, which is a pure
re-export:

```ts
// src/domain/agent/contract.ts
export * from "@melody/agent-contract";
```

Never redeclare a protocol type in `src/domain` or `packages/agent-worker`.
If both sides need a field, it belongs here.

## Scope

| File | Owns |
|------|------|
| `src/index.ts` | All wire types: envelopes, commands, events, payloads, ids |
| `src/protocol-version.ts` | `AGENT_PROTOCOL_VERSION` |
| `src/capabilities.ts` | Capability names + per-command requirements |
| `src/session-modes.ts` | Product-enforced session mode ids |
| `src/validation.ts` | Command envelope validator and field validators |
| `src/validation/shared.ts` | Shared predicates and control-character guard |
| `src/validation/resource-manifest.ts` | Resource manifest validator |

The package has **no runtime dependencies** (`packages/agent-contract/package.json`),
compiles as NodeNext with explicit `.ts` specifiers, and is
`types`/`import`-exported straight from `src/index.ts` (no build output).

## Pre-Development Checklist

- [ ] The field is consumed by both renderer and worker, or by more than one
      worker adapter. Otherwise keep it local to the consumer.
- [ ] Added the type to `src/index.ts` and the validator export path through
      `src/index.ts` (see its tail: `export { validateAgentCommandEnvelope,
      containsControlCharacters, withoutControlCharacters }`).
- [ ] Checked whether the command needs a capability requirement in
      `src/capabilities.ts`.
- [ ] Did not import `zod`/`typebox` here; validation is hand-written in this
      package.

## Quality Check

```bash
pnpm check:agent-contract   # tsc --noEmit for the package
pnpm check                  # full renderer + package + compatibility gate
```

## Protocol Rules

### Versioning

`AGENT_PROTOCOL_VERSION` is `1` (`src/protocol-version.ts`). Every command
envelope carries `protocolVersion`, and the validator rejects anything else:

```ts
if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
  throw new Error(`不支持的 agent protocol 版本：${String(value.protocolVersion)}。`);
}
```

Changing the wire shape means bumping this constant, updating every producer
(`src/lib/agent-client.ts` builds envelopes with `protocolVersion: 1`), and
updating `docs/architecture/pi-migration/pi-compatibility-manifest.json`
(`pi.protocolVersion`, asserted against the worker adapter by
`scripts/check-pi-compatibility.mjs`).

### Discriminated unions

Commands discriminate on `command.type`; events on `event.type`. Both are
exhaustive unions in `src/index.ts`, so a new case forces updates at every
consumer switch:

- Renderer: `src/stores/agent-store-receive.ts`, `src/stores/agent-store-pi.ts`,
  and the projection helpers in `src/domain/agent/`
  (`event-to-session-update.ts`, `message-projection.ts`).
- Worker: `packages/agent-worker/src/main.ts` (`dispatch`) and the event
  mapping in `packages/agent-worker/src/pi/event-mapper.ts`.

`tsconfig` sets `noFallthroughCasesInSwitch`, and each package sets
`noUnusedLocals`/`noUnusedParameters`; do not silence a new case with a
default that throws away the payload.

### Validation style

Validators take `unknown`, return an assertion or a typed value, and throw
`Error` with a field-scoped message:

```ts
export function validateAgentCommandEnvelope(
  value: unknown,
): asserts value is AgentCommandEnvelope {
  if (!isRecord(value)) throw new Error("agent command envelope 必须是对象。 ");
  ...
  if (!(...)) throw new Error("agent command envelope.requestId 必须是稳定 ID。 ");
}
```

Local conventions, all visible in `src/validation.ts`:

- Limits are named `MAX_*` constants (`MAX_IDEMPOTENCY_KEY_LENGTH = 256`,
  `MAX_FRAME_BYTES`-style bounds, `MAX_MODEL_CREDENTIALS = 512`), never inline
  magic numbers.
- Messages name the exact field and are written in user-facing Chinese, because
  they can surface through `toUserMessage` (`src/domain/app-error.ts` keeps
  validation text verbatim).
- Enumerations are checked with explicit `includes(...)` against a const array,
  not truthiness.
- Text that can reach a prompt or a filesystem key passes through
  `containsControlCharacters` / `withoutControlCharacters`
  (`src/validation/shared.ts`); the predicate rejects, the sanitizer strips.

Validators run on both sides of the transport:
`src/lib/agent-client.ts:211` before invoking the worker, and
`packages/agent-worker/src/main.ts:135,143` on inbound frames.

### Capability gating

A command that an engine may not support declares its requirement in
`src/capabilities.ts`. The worker calls
`assertAgentCommandCapabilities(command, adapter.health())` before dispatch
(`packages/agent-worker/src/main.ts:148`), producing a structured
`UnsupportedAgentCapability` instead of a late SDK exception. Add the
requirement there, not as an ad-hoc `if` in the worker.

### Session modes

`AGENT_SESSION_MODE_IDS = ["default", "plan", "ask"]`
(`src/session-modes.ts`) with `isAgentSessionModeId`. The wire keeps
`sessionModeId` as a string because ACP may expose more; Pi is restricted to
those three.
