# Product

## Register

product

## Platform

web

## Users

Software developers and AI practitioners working from local repositories, often moving between an active coding task, a research question, and a review or delivery step. They need to see what an agent is doing while it works, keep the repository and its rules close at hand, and make a deliberate decision before protected actions happen.

## Product Purpose

MelodyWork is a local-first desktop workspace around the Melody Build execution engine. It turns an outcome described in natural language into a bounded Agent Session, then keeps the useful context together: project and worktree selection, research, files, terminal output, tool activity, permissions, diffs, branches, and commits. Its job is to make AI-assisted development feel inspectable and reversible rather than opaque. Success means a developer can move from intent to a reviewable Git change without surrendering local context or control, and can recover the full session when work is interrupted.

## Brand Personality

Calm, precise, and inspectable. The voice is direct and concrete: name the current state, show the evidence, and make the next decision obvious. The product should feel quietly capable in a long coding session, with enough density for expert work and enough restraint that the interface disappears behind the repository.

## Anti-references

- A generic AI chat wrapper that hides the workspace and treats the transcript as the whole product.
- A glossy AI/SaaS dashboard with decorative metrics, marketing language, or invented confidence.
- A black-box autopilot that silently edits, approves, syncs, or ships on the user's behalf.
- Noisy command-center chrome: constant animation, saturated decoration, or status colors without a clear state meaning.
- Cloud-first assumptions such as mandatory accounts, opaque remote persistence, or a cloud lock-in story.

## Design Principles

1. **Make agent work inspectable.** Keep messages, reasoning, tool activity, plans, citations, diffs, and trajectory views close to the action that produced them.
2. **Treat local context as a product feature.** Projects, worktrees, session state, files, Git history, and project rules stay grounded in the machine where the work happens.
3. **Make permission a visible contract.** Protected actions pause with an understandable request and explicit choices; never turn approval into a surprise or a hidden default.
4. **Be dense when the task demands it, quiet when it does not.** Favor stable hierarchy, compact controls, and progressive disclosure over decorative surface area.
5. **Preserve momentum across the whole loop.** Chat, research, files, terminal, review, settings, and delivery should feel like views of one workspace, not disconnected tools.
6. **Be honest about state and evidence.** Distinguish loading, running, stopped, missing, failed, and complete; never imply a capability, source, or result that is not present.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the rendered interface. Every workflow should be keyboard-complete with visible focus, semantic controls, usable target sizes, and text contrast that does not depend on color alone. Support light and dark themes, reduced motion, and reduced transparency; keep status, errors, permission choices, and streaming progress understandable to screen readers and users with color-vision differences. Preserve readable code and research text at user-controlled zoom levels, and keep English and Simplified Chinese labels equivalent in meaning as localization expands.
