# Interior component attribution

The `copy-button.tsx` and `loading-button.tsx` implementations in this
directory are adapted from the Interior component library by ddoemonn,
licensed under the MIT License.

- Project: https://github.com/ddoemonn/interior
- Source: https://github.com/ddoemonn/interior/blob/46473ce9e0edcebc70702814dc3d59c504e06bac/components/interior/copy-button.tsx
- Loading button source: https://github.com/ddoemonn/interior/blob/main/components/interior/loading-button.tsx
- Upstream commit: `46473ce9e0edcebc70702814dc3d59c504e06bac`
- Copyright: © 2026 ozzy

The adaptation keeps Interior's clipboard fallback and reduced-motion-aware
copy-state animation while using MelodyWork's existing design tokens. The
loading button keeps the library's async state machine and animated faces,
while exposing MelodyWork's size and variant options for existing workflows.
