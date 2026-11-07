# UI Conventions

## Component Layers

| Layer | Use it for | Examples |
|-------|-----------|----------|
| `src/components/ui/` | Generic primitives (form controls, overlays, layout atoms) | `button.tsx`, `select.tsx`, `dialog.tsx`, `tooltip.tsx` |
| `src/components/interior/` | App-chrome components that combine primitives | `accordion.tsx`, `drawer.tsx`, `context-menu.tsx`, `hold-to-confirm.tsx` |
| `src/components/ai-elements/` | Agent/AI surface primitives | `attachments`, `context`, `model-selector`, `prompt-input` |
| `src/features/<area>/` | Product composition and feature-local pieces | `features/chat/agent-composer.tsx` |

Do not introduce a fourth directory for a single screen. If a widget is used by
one feature, keep it in that feature folder until a second consumer exists.

## Naming And Exports

- File names are kebab-case: `agent-workspace.tsx`,
  `research-capability-store.ts`, `agent-store-types.ts`.
- Named exports only. `src/App.tsx` (`export default App`) is the sole default
  export in `src/`.
- Feature-local types go in `*-types.ts`; feature-local helpers go in a
  sibling `.ts` file (`agent-workspace-utils.ts`, `tool-diff.ts`).
- No barrel `index.ts` files exist under `src/features` or `src/components`;
  import the concrete module.

## Primitive Shape

`src/components/ui/button.tsx` is the reference for a primitive:

- Variants and sizes via `cva` from `class-variance-authority`.
- `cn(...)` from `@/lib/utils` to merge classes.
- `data-slot="button"`, `data-variant`, `data-size` for styling/test hooks.
- `Slot.Root` from the `radix-ui` barrel when `asChild` is needed.
- Component declared as a function with `React.ComponentProps<"button">` +
  `VariantProps<typeof buttonVariants>`.

The other 22 files in `src/components/ui/` follow the same `data-slot` + `cn`
pattern (21 import `cn`, 22 use `data-slot`). Match it for a new primitive.

## Styling

- Tailwind v4 utilities in JSX; no CSS-in-JS.
- Use semantic tokens (`bg-primary`, `text-muted-foreground`, `border-border`,
  `ring-ring`) rather than literal colors. Token values live in
  `src/styles/base.css` and are documented in `DESIGN.md` (oklch palette,
  Geist typography, radii).
- Never put `backdrop-filter` on a surface that spans the window or a large
  dock (app shell, composer, turn headers). Compose those from opaque layer
  tokens (`--harness-bg-layer-*`) instead.
- Blur is only acceptable on transient, small overlays (dialog/drawer/modal
  scrims, popovers) that are unmounted at idle.
- Why: three full-window/dock blurs cost ~17.5 GPU points on a 4K@160Hz
  display (paired interleaved) while app CPU stayed ~0 — WindowServer pays for
  it. Removed in `0b5fa19b`.
- Check: `grep -rn "backdrop-filter\|backdrop-blur" src/styles src/components`
  should only return overlay-scoped rules and the reduced-transparency reset.
- Long app-shell styles live in the layered files under `src/styles/`
  (`harness-layout.css`, `harness-chat.css`, `harness-trajectory.css`, ...).
  Add shell-level rules there; keep feature markup on utilities.
- Motion uses `motion` (already a dependency) and the
  `[cubic-bezier(0.23,1,0.32,1)]` easing used by `button.tsx` for
  interaction-scale transitions.
- Icons come from `lucide-react` (`*-icon` suffix: `BotIcon`,
  `LoaderCircleIcon`).

## Composition Rules

- Keep data/state out of `src/components/ui` and `src/components/interior`.
  They receive props; they do not read `useAgentStore`.
- Feature components are the place to subscribe to stores and call bridge
  functions (`features/chat/agent-workspace.tsx`).
- Conditional rendering for runtime mode belongs in the bridge or a hook, not
  in a primitive (`isTauriRuntime()` is called in `src/lib/`).
- Large surfaces split by responsibility, not by line count:
  `features/chat/` separates timeline (`agent-timeline.tsx`), composer
  (`agent-composer.tsx`), layout (`agent-workspace-layout.ts`), and the
  workspace shell (`agent-workspace.tsx`).

## Verification

```bash
pnpm exec tsc --noEmit
pnpm check:ui-font
pnpm lint
pnpm format:check
```

`pnpm check:ui-font` is a CI gate (`scripts/check-ui-font.mjs`). Visual changes
need a real run: `pnpm dev` for browser-preview surfaces, `pnpm tauri dev` for
host-backed surfaces.
