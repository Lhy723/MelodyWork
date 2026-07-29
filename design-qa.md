# Sidebar design QA

## Source truth

- Reference: `/var/folders/j8/z9355vvj0yl2ycxnt1j2fj1r0000gn/T/codex-clipboard-e76561a5-e27b-45c4-9ef7-af4e30c7dccc.png`
- Implementation capture: `design-qa-implementation.png`
- Side-by-side comparison: `design-qa-comparison.png`
- Focused region: the complete left sidebar, including navigation, project/task hierarchy, selection state, and bottom settings row.

## Render conditions

- Browser viewport: 1280 × 720 CSS pixels
- Device pixel ratio: 2
- Sidebar bounds: 280 × 720 CSS pixels
- State: MelodyWork project expanded; “Implement ACP bridge” selected.

## Visual comparison

- Recreated the narrow macOS-style sidebar with restrained borders, generous vertical rhythm, lightweight line icons, and a pale rounded selected-task row.
- Matched the reference hierarchy: product switcher, compact primary actions, uppercase project section label, folder-level projects, indented tasks, and a persistent bottom account/settings row.
- Omitted the Sites entry as requested.
- Replaced unavailable reference-only destinations with existing MelodyWork destinations: Git workspace and Extensions.
- Preserved actual workspace/session data rather than inserting static sample projects.

## Interaction verification

- Search opens, accepts a query, and filters both projects and tasks.
- Extensions opens the independent settings page directly on the Extensions section.
- Git workspace opens the existing Git panel with changes, branches, and worktrees.
- Browser console: no warnings or errors.

## Findings and resolution

- P1: none.
- P2: none after the final comparison.
- Intentional difference: the browser preview does not show native macOS traffic-light controls; Tauri supplies those in the desktop window.
- Intentional difference: unsupported Scheduled and Sites destinations were not added as non-functional placeholders.

final result: passed

---

# Skill details design QA

## Source truth

- Reference: the existing plugin details flow in `src/features/settings/plugin-details.tsx`.
- Implementation: the skill list, skill details view, and destructive confirmation state rendered in the in-app browser.
- Focused region: Settings → Skills, including metadata, bundled files, `SKILL.md`, source paths, and deletion.

## Visual and interaction verification

- Skill cards use the same compact grid, border, hover, badge, and disclosure treatment as plugin cards.
- The details header, metadata rows, file inventory, source paths, and destructive action follow the plugin details hierarchy.
- Clicking a skill opens its details view and the back action returns to the list.
- The delete action opens a confirmation dialog that clearly states the whole skill directory is permanently removed.
- The dialog exposes one primary confirmation action and closes without deleting when dismissed.
- Browser console: no warnings or errors.

## Findings and resolution

- P1: none.
- P2: none.
- Intentional difference: skills show their `SKILL.md` instructions and bundled files rather than plugin component groups.

final result: passed
