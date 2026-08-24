---

name: MelodyWork
description: A local-first, inspectable desktop workspace for building with Melody Build.
colors:
background: oklch(1 0 0)
foreground: oklch(0.145 0 0)
surface: oklch(0.985 0 0)
card: oklch(1 0 0)
primary: oklch(0.205 0 0)
primary-foreground: oklch(0.985 0 0)
secondary: oklch(0.97 0 0)
muted: oklch(0.97 0 0)
muted-foreground: oklch(0.556 0 0)
border: oklch(0.922 0 0)
ring: oklch(0.708 0 0)
destructive: oklch(0.577 0.245 27.325)
dark-background: oklch(0.145 0 0)
dark-surface: oklch(0.205 0 0)
dark-primary: oklch(0.922 0 0)
dark-muted: oklch(0.269 0 0)
harness-blue: "#3b82f6"
harness-green: "#22c55e"
harness-amber: "#dd8629"
harness-red: "#ec1313"
typography:
headline:
fontFamily: "Geist Variable, sans-serif"
fontSize: "1.5rem"
fontWeight: 600
lineHeight: 1.25
letterSpacing: "-0.02em"
title:
fontFamily: "Geist Variable, sans-serif"
fontSize: "1rem"
fontWeight: 500
lineHeight: 1.375
body:
fontFamily: "Geist Variable, sans-serif"
fontSize: "0.875rem"
fontWeight: 400
lineHeight: 1.5
label:
fontFamily: "Geist Variable, sans-serif"
fontSize: "0.75rem"
fontWeight: 500
lineHeight: 1.333
mono:
fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
fontSize: "0.875rem"
fontWeight: 400
lineHeight: 1.45
rounded:
sm: "0.375rem"
md: "0.5rem"
lg: "0.75rem"
xl: "1rem"
pill: "9999px"
spacing:
xs: "0.25rem"
sm: "0.5rem"
md: "0.75rem"
lg: "1rem"
xl: "1.5rem"
components:
button-primary:
backgroundColor: "{colors.primary}"
textColor: "{colors.primary-foreground}"
rounded: "{rounded.md}"
padding: "0.5rem 0.625rem"
height: "2rem"
button-ghost:
backgroundColor: "transparent"
textColor: "{colors.foreground}"
rounded: "{rounded.md}"
padding: "0.5rem 0.625rem"
height: "2rem"
input:
backgroundColor: "transparent"
textColor: "{colors.foreground}"
rounded: "{rounded.md}"
padding: "0.25rem 0.625rem"
height: "2rem"
card:
backgroundColor: "{colors.card}"
textColor: "{colors.foreground}"
rounded: "{rounded.lg}"
padding: "1rem"
badge-status:
backgroundColor: "{colors.secondary}"
textColor: "{colors.foreground}"
rounded: "{rounded.pill}"
padding: "0.125rem 0.5rem"

# Design System: MelodyWork

## 1. Overview

**Creative North Star: "The Traceable Workbench"**

MelodyWork is a quiet instrument panel for real repository work. The interface should make an agent's path legible without turning the path into theater: the project is always nearby, the current state is named, and evidence is available at the moment a developer needs to review or decide. The system is deliberately product-first rather than promotional; density belongs to the task, not to decoration.

The visual language uses a neutral light/dark foundation, a compact sans-serif control vocabulary, and small semantic accents for tool states, permissions, research, and Git outcomes. Panels gain depth from tonal layering and restrained rings before they gain it from shadows. Research surfaces may use the existing serif exception for long-form reading, while the surrounding chrome stays in the same Geist voice.

This system rejects the generic AI chat wrapper, the glossy AI/SaaS dashboard, the black-box autopilot, noisy command-center chrome, and cloud-first assumptions named in PRODUCT.md. It must feel like a trusted local workbench: calm during a long session, explicit at a boundary, and fast to scan when the repository is under pressure.

**Key Characteristics:**

- Neutral surfaces with one functional primary action color.
- Compact, stable hierarchy built for desktop density.
- Semantic state colors with text and icon reinforcement.
- Evidence-led interaction: timelines, diffs, tool rows, and disclosures.
- Motion that communicates state and always yields to reduced-motion settings.

## 2. Colors

The palette is restrained and state-rich: neutral surfaces carry the bulk of every screen, while blue, green, amber, and red appear only when they explain a real state or decision.

### Primary

- **Ink Primary** (`oklch(0.205 0 0)`): The default action and selected-state color in light mode. It is strong enough to anchor a compact control without becoming decoration.
- **Inverse Ink** (`oklch(0.922 0 0)`): The dark-mode primary action color, paired with the dark surface so the same semantic action remains legible across themes.

### Secondary

- **Harness Blue** (`#3b82f6`): Informational and active-work state. Use with a soft companion surface (`#e4edfd`) and a text/icon cue; never as a decorative wash.
- **Harness Green** (`#22c55e`): Completed, connected, or healthy state. Pair with a readable text label or icon.

### Tertiary

- **Harness Amber** (`#dd8629`): Attention, pending permission, or caution state.
- **Harness Red** (`#ec1313`): Destructive, failed, or blocked state. Use the soft red surface for background emphasis and reserve the saturated tone for text, icon, or action.

### Neutral

- **Canvas** (`oklch(1 0 0)` / dark `oklch(0.145 0 0)`): The primary work surface.
- **Panel** (`oklch(0.985 0 0)` / dark `oklch(0.205 0 0)`): Sidebar and raised workspace layers.
- **Muted Surface** (`oklch(0.97 0 0)` / dark `oklch(0.269 0 0)`): Hover, selected, secondary, and low-emphasis content regions.
- **Muted Ink** (`oklch(0.556 0 0)` / dark `oklch(0.708 0 0)`): Supporting labels and metadata; it must still meet contrast requirements in context.
- **Border** (`oklch(0.922 0 0)` / dark `oklch(1 0 0 / 10%)`): Dividers and field outlines. Prefer tonal layering to heavy rules.

### Named Rules

**The One-State-Color Rule.** A saturated color must explain a state, permission, or active work; if removing it does not remove information, do not use it.

**The Neutral Workbench Rule.** Keep the canvas and most panels neutral so tool output, diffs, research citations, and permission choices remain the visual focus.

## 3. Typography

**Display Font:** Geist Variable (with `sans-serif` fallback)
**Body Font:** Geist Variable (with `sans-serif` fallback)
**Label/Mono Font:** `ui-monospace`, SFMono-Regular, Menlo, Monaco, Consolas (for code, paths, and terminal output)

**Character:** Geist Variable gives the product a compact, legible rhythm across controls, labels, and dense session output. Research headings use the existing `Georgia, Songti SC, STSong, Noto Serif CJK SC, Source Han Serif SC, serif` stack only where the user is reading long-form academic material; it is a scoped reading aid, not a second app-wide voice.

### Hierarchy

- **Headline** (600, `1.5rem`, `1.25`): Workspace-level titles and high-level statistics; use sparingly.
- **Title** (500–600, `1rem`, `1.375`): Panel headings, settings groups, and research section headings.
- **Body** (400, `0.875rem`, `1.5`): Conversation, controls, descriptions, and review content. Keep explanatory prose near 65–75ch when it is not a dense data view.
- **Label** (500, `0.75rem`, `1.333`): Metadata, captions, status, and compact navigation labels. Uppercase tracking is reserved for intentional tool-state labels, not every section heading.
- **Mono** (400, `0.875rem`, `1.45`): Code, diffs, paths, shell output, token values, and other literal technical material.

### Named Rules

**The One UI Voice Rule.** Use Geist Variable for product chrome and controls; reserve the research serif for reading surfaces and never use a display face for buttons, labels, or status.

**The Readable Density Rule.** Compact text is welcome in tool output, but never trade away line-height, contrast, or focus visibility to fit more rows.

## 4. Elevation

MelodyWork is flat by default and layered by function. Borders and tonal surfaces establish the workspace hierarchy; shadows are reserved for overlays, drawers, and transient surfaces that must separate from the repository view. The system avoids pairing a decorative wide shadow with a one-pixel border on the same resting card.

### Shadow Vocabulary

- **Overlay Lift** (`0 14px 30px -24px rgb(0 0 0 / 35%)`): The restrained separation for terminal drawers and transient workspace panels.
- **Control Thumb** (`0 1px 3px rgb(0 0 0 / 14%)`): A small physical cue for the reasoning-effort slider thumb only.
- **Dark Overlay Lift** (`0 16px 34px -26px rgb(0 0 0 / 80%)`): The dark-theme equivalent where the surrounding surface needs stronger separation.

### Named Rules

**The Flat-by-Default Rule.** Resting surfaces rely on fill, ring, and spacing; a shadow must communicate an actual layer or moving control.

## 5. Components

Components feel compact, familiar, and state-complete. The same control vocabulary is shared across chat, research, files, Git, terminal, and settings; every interactive state has a default, hover, focus-visible, active, disabled, loading, and error treatment where it applies.

### Buttons

- **Shape:** Gently rounded controls (`0.5rem` / `rounded-lg`) with compact height (`2rem` default; `1.75rem` small; `2.25rem` large).
- **Primary:** Ink on inverse text in light mode, inverse ink on dark surface in dark mode; use for the one most important action in a local task.
- **Hover / Focus:** Exponential ease-out around 150ms; adjust color or tonal fill, then add a visible ring (`3px`) on focus-visible.
- **Secondary / Ghost / Tertiary:** Use muted or transparent fills for supporting actions. Ghost controls gain a muted surface on hover; they do not compete with primary actions.

### Chips

- **Style:** Compact pill (`9999px`) with a semantic fill and readable label; use for model, session, capability, or tool status.
- **State:** Selected and active chips change fill and text together; color never carries the state alone.

### Cards / Containers

- **Corner Style:** Moderate corners (`0.75rem` for cards, `0.5rem` for compact containers); never oversized capsule cards.
- **Background:** `card` for content groups, `muted` for secondary regions, and `background` for the main work surface.
- **Shadow Strategy:** Border/ring first; `Overlay Lift` only for drawers, dialogs, and transient surfaces.
- **Border:** Use the neutral border or a semantic border for errors and warnings. Never use a thick colored side stripe.
- **Internal Padding:** `0.75rem` for dense rows, `1rem` for cards, and `1.5rem` when a reading surface needs breathing room.

### Inputs / Fields

- **Style:** `2rem` high by default, transparent or theme-matched fill, `0.5rem` corners, and a neutral border.
- **Focus:** A visible ring and border shift on focus-visible; never rely on placeholder color to show focus.
- **Error / Disabled:** Destructive border/ring with explanatory text for invalid input; disabled fields keep their value legible while reducing interaction affordance.

### Navigation

- **Style:** A resizable, collapsible sidebar with a quieter panel background, compact session rows, and stable selected/hover states. The title bar respects the Tauri overlay window and keeps the workspace controls close to the traffic lights.
- **Default / Active:** Default labels use muted ink; hover uses a muted surface; active uses the selected surface and foreground contrast. Navigation remains keyboard reachable when collapsed.
- **Mobile treatment:** The responsive webview collapses side panels into progressive layers rather than shrinking product typography.

### Session Ledger

The signature component is the evidence-led session timeline: messages, plans, reasoning, tool activity, permission requests, citations, and turn usage appear as a single chronological projection. Keep disclosures one line when collapsed, expose the relevant payload on demand, and use state colors only to distinguish running, waiting, succeeded, failed, or blocked work.

## 6. Do's and Don'ts

### Do:

- **Do** keep the repository, active session, current status, and next action visible in the same workspace frame.
- **Do** use neutral surfaces and a single functional primary action; reserve blue, green, amber, and red for real state.
- **Do** expose tool activity, plans, citations, diffs, and permission decisions as inspectable evidence.
- **Do** use the existing 150–250ms state transitions and honor `prefers-reduced-motion` and `prefers-reduced-transparency`.
- **Do** keep code, paths, diffs, and terminal output in a readable mono stack with enough line-height to scan.
- **Do** make empty, loading, failed, missing, and stopped states teach the user what happens next.

### Don't:

- **Don't** turn MelodyWork into a generic AI chat wrapper that hides the workspace and treats the transcript as the whole product.
- **Don't** build a glossy AI/SaaS dashboard with decorative metrics, marketing language, or invented confidence.
- **Don't** ship a black-box autopilot that silently edits, approves, syncs, or ships on the user's behalf.
- **Don't** add noisy command-center chrome, constant animation, saturated decoration, or status colors without a clear state meaning.
- **Don't** assume accounts, cloud sync, or remote persistence when the local repository is the source of truth.
- **Don't** use gradient text, decorative grid/stripe backgrounds, oversized rounded cards, or a thick colored side stripe as scaffolding.
- **Don't** pair a `1px` border with a wide (`16px+`) soft shadow on a resting card or button; choose one depth cue.
- **Don't** use a display font in UI labels, buttons, data, or permission choices; the research serif is scoped to reading surfaces.
