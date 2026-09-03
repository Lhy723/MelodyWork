# Interior component attribution

The `copy-button.tsx`, `loading-button.tsx`, `hold-to-confirm.tsx`, `ripple.tsx`,
`icon-morph.tsx`, and `press-depth.tsx`
implementations in this directory are adapted from the Interior component
library by ddoemonn, licensed under the MIT License.

- Project: https://github.com/ddoemonn/interior
- Source: https://github.com/ddoemonn/interior/blob/46473ce9e0edcebc70702814dc3d59c504e06bac/components/interior/copy-button.tsx
- Loading button source: https://github.com/ddoemonn/interior/blob/main/components/interior/loading-button.tsx
- Hold-to-confirm source: https://www.interior.dev/docs/hold-to-confirm
- Ripple source: https://www.interior.dev/docs/ripple
- Icon Morph source: https://www.interior.dev/docs/icon-morph
- Press Depth source: https://www.interior.dev/docs/press-depth
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
