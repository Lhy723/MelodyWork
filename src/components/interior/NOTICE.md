# Interior component attribution

The `copy-button.tsx`, `loading-button.tsx`, `hold-to-confirm.tsx`, `ripple.tsx`,
`icon-morph.tsx`, `press-depth.tsx`, `floating-label.tsx`, `expanding-search.tsx`,
`progress-bar.tsx`, `load-more.tsx`, `live-activity.tsx`, `collapsible-banner.tsx`,
`presence-avatars.tsx`, `modal.tsx`, `popover.tsx`, `tooltip-group.tsx`,
`drawer.tsx`, `context-menu.tsx`, `dropdown.tsx`, `tabs.tsx`, `accordion.tsx`,
`slider-detents.tsx`, and `text-reveal.tsx` implementations in this
directory are
adapted from the Interior component library by ddoemonn, licensed under the MIT
License.

- Project: https://github.com/ddoemonn/interior
- Source: https://github.com/ddoemonn/interior/blob/46473ce9e0edcebc70702814dc3d59c504e06bac/components/interior/copy-button.tsx
- Loading button source: https://github.com/ddoemonn/interior/blob/main/components/interior/loading-button.tsx
- Hold-to-confirm source: https://www.interior.dev/docs/hold-to-confirm
- Ripple source: https://www.interior.dev/docs/ripple
- Icon Morph source: https://www.interior.dev/docs/icon-morph
- Press Depth source: https://www.interior.dev/docs/press-depth
- Floating Label source: https://www.interior.dev/docs/floating-label
- Expanding Search source: https://www.interior.dev/docs/expanding-search
- Progress Bar source: https://www.interior.dev/docs/progress-bar
- Load More source: https://www.interior.dev/docs/load-more
- Live Activity source: https://www.interior.dev/docs/live-activity
- Collapsible Banner source: https://www.interior.dev/docs/collapsible-banner
- Presence Avatars source: https://www.interior.dev/docs/presence-avatars
- Modal source: https://www.interior.dev/docs/modal
- Popover source: https://www.interior.dev/docs/popover
- Tooltip Group source: https://www.interior.dev/docs/tooltip-group
- Drawer source: https://www.interior.dev/docs/drawer
- Context Menu source: https://www.interior.dev/docs/context-menu
- Dropdown source: https://www.interior.dev/docs/dropdown
- Tabs source: https://www.interior.dev/docs/tabs
- Accordion source: https://www.interior.dev/docs/accordion
- Slider Detents source: https://www.interior.dev/docs/slider-detents
- Text Reveal source: https://www.interior.dev/docs/text-reveal
- Streaming Text source: https://www.interior.dev/docs/streaming-text
- Upstream commit: `46473ce9e0edcebc70702814dc3d59c504e06bac`
- Copyright: © 2026 ozzy

The adaptation keeps Interior's clipboard fallback and reduced-motion-aware
copy-state animation while using MelodyWork's existing design tokens. The
loading button keeps the library's async state machine and animated faces,
while exposing MelodyWork's size and variant options for existing workflows.
The hold-to-confirm control keeps the library's press-and-hold guardrail while
adding async-safe action handling and MelodyWork's design tokens.
The ripple control keeps the library's pointer-origin feedback and keyboard
handling while exposing the hook and visual layer separately so existing
MelodyWork controls retain their own semantics and styles.
The Icon Morph adapter keeps the library's frame-based SVG interpolation and
reduced-motion behavior while exposing a visual-only surface for existing
MelodyWork buttons.
The Press Depth adapter keeps the library's pointer-origin press depth while
reusing MelodyWork's Button variants and preserving native button semantics;
the hook is exposed separately to avoid nesting interactive elements.
The Floating Label adapter keeps the library's reserved label slot, animated
focus state, hint, validation, and character-count behavior while using
MelodyWork's design tokens and controlled-input conventions.
The Expanding Search adapter keeps the library's focus-managed disclosure,
debounced search callbacks, result announcement, and reduced-motion behavior
for compact local filtering surfaces.
The Progress Bar adapter keeps the library's indeterminate-to-determinate
handoff, spring-filled track, status labels, and progressbar semantics while
adding a compact presentation for existing metric cards.
The Load More adapter keeps the library's async sentinel, retry state, end
state, and reduced-motion-aware transitions while using MelodyWork's design
tokens and Chinese labels.
The Live Activity adapter keeps the library's compact/expanded activity pod,
progress phases, retry action, dismissal behavior, and reduced-motion-aware
transitions while adding a provider for app-wide background work.
The Collapsible Banner adapter keeps the library's fold/dismiss state machine,
detail disclosure and reduced-motion-aware height transitions while using
MelodyWork's design tokens and explicit live-region semantics for page-level
warnings and errors.
The Presence Avatars adapter keeps the library's stable roster ordering,
overflow affordance, enter/leave motion, and live announcements while allowing
MelodyWork to render local deterministic Subagent avatars without network
requests.
The Popover adapter keeps Interior's click-triggered disclosure, collision-aware
placement, keyboard and outside-click dismissal, and reduced-motion-aware
transition while exposing a child-safe trigger mode for existing controls.
The Modal adapter keeps Interior's controlled open/close API, focus trap,
backdrop dismissal, Escape handling, and scroll locking while using MelodyWork's
theme tokens and shared button treatment for ordinary business dialogs.
The Tooltip Group adapter keeps Interior's shared warm store, delayed-first
hover, instant sibling switching, keyboard focus behavior, and reduced-motion
tooltip transitions while preserving existing MelodyWork button semantics.
The Drawer adapter keeps Interior's side-panel interaction model, focus and
scroll management, scrim dismissal, reduced-motion-aware entrance, and
header-driven swipe dismissal while using MelodyWork's dialog and button
tokens for focused editing workflows.
The Context Menu adapter keeps Interior's pointer and keyboard invocation,
touch long-press, collision-aware placement, focus restoration, and
reduced-motion-aware transitions while using MelodyWork's semantic menu tokens.
The Dropdown adapter keeps Interior's active-item motion, controlled/uncontrolled
selection API, keyboard navigation, typeahead, disabled-item handling, and
collision-aware popover placement while using MelodyWork's semantic tokens.
The Tabs adapter keeps Interior's shared motion indicator, controlled or
uncontrolled selection, keyboard activation modes, tablist semantics, and
reduced-motion-aware panel transitions while using MelodyWork's semantic tokens.
The Accordion adapter keeps Interior's measured auto-height panels, single or
multiple open modes, keyboard navigation, inert closed content, and
reduced-motion-aware transitions while using MelodyWork's semantic tokens.
The Slider Detents adapter keeps Interior's detent snapping, keyboard stepping,
pointer capture, spring carriage, and reduced-motion behavior while exposing a
commit callback for draft-driven controls such as model reasoning effort.
The Text Reveal adapter keeps Interior's reading-order reveal motion for short,
static copy. Its streaming variant preserves the same visual treatment while
animating only newly appended units during an active assistant stream; once a
Markdown response settles, MelodyWork switches back to its Streamdown renderer
to preserve formatting.
