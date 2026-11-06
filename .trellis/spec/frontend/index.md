# Frontend Guidelines (`src/`)

Renderer conventions for the Tauri web app, written from the code that exists
today. Extend these patterns; do not start a second convention beside them.

## Scope

| Area                   | Path                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Product surfaces       | `src/features/<area>/` (`chat`, `files`, `git`, `research`, `sessions`, `settings`, `terminal`, `workspace`) |
| Shared primitives      | `src/components/ui/`                                                                                         |
| App chrome components  | `src/components/interior/`                                                                                   |
| Agent-UI components    | `src/components/ai-elements/`                                                                                |
| Zustand stores         | `src/stores/`                                                                                                |
| Tauri bridge / clients | `src/lib/`                                                                                                   |
| Framework-free logic   | `src/domain/`                                                                                                |
| Reusable hooks         | `src/hooks/`                                                                                                 |

Not covered here: `packages/agent-contract` (see `../agent-contract/index.md`)
and `packages/agent-worker` (see `../agent-worker/index.md`).

## Pre-Development Checklist

- [ ] Place new logic in the layer that owns it: pure rules in `src/domain/`,
      IPC in `src/lib/melody-bridge-*.ts`, state transitions in `src/stores/`,
      rendering in `src/features/<area>/`.
- [ ] Reuse a component before writing one: `src/components/ui/` for
      form/overlay primitives, `src/components/interior/` for app chrome,
      `src/components/ai-elements/` for agent surfaces.
- [ ] Read [conventions.md](./conventions.md) for import/state/async/error rules
      and [ui.md](./ui.md) for component and styling rules.
- [ ] Adding or changing a Tauri command? Also read `../tauri-host/index.md`.
- [ ] Adding a renderer surface for a preview-only flow? Keep the
      `isTauriRuntime()` branch in the bridge, not in the component.

## Quality Check

Run before yielding:

```bash
pnpm test:unit            # src/** + agent-contract, ~0.3s
pnpm check                # tsc --noEmit + contract/worker/packaging + Pi compatibility
pnpm check:architecture   # domain boundary, Pi SDK boundary, runtime import cycles
pnpm lint
pnpm format:check
```

`pnpm check:architecture` is not part of `pnpm check`; CI runs every gate plus
all test suites (`.github/workflows/check.yml`).

Suite ownership: `test:unit` owns `src/**/*.test.mjs` and
`packages/agent-contract/src/*.test.mjs`; `test:agent-worker` owns pure worker
tests; `test:smoke` owns the two process-spawning worker files. A file belongs
to exactly one suite — do not add a worker path back to `test:unit`. Renderer
work still needs a real run (`pnpm dev` / `pnpm tauri dev`) for visual changes;
the suites cover domain and store logic, not components.

## Files

| File                               | Owns                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [conventions.md](./conventions.md) | Layer/import boundaries, Zustand slicing, async + latest-request rule, error normalization, Tauri access |
| [ui.md](./ui.md)                   | Component layers, naming/export style, `cva`/`cn`/`data-slot`, icons, design tokens                      |
