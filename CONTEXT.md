# MelodyWork

MelodyWork is a local-first workspace for running, observing, and reviewing Agent Sessions against a project.

## Language

**Agent Session**:
A continuous conversation and execution context associated with one project workspace.
_Avoid_: Chat, thread

**Session Projection**:
The ordered, display-ready record of an Agent Session, including messages, thoughts, tool activity, and turn usage. It is derived from session events and is distinct from the raw event stream.
_Avoid_: Raw history, event log

**Research Project**:
The project-scoped collection of papers, searches, Tracking Topics, notes, tasks, and the current research inbox.
_Avoid_: Global library

**Tracking Topic**:
A saved research query whose latest papers and refresh time belong to one Research Project.
_Avoid_: Alert, subscription

**Task Launch**:
The transition that creates or selects an Agent Session and delivers its first prompt only after that session is ready.
_Avoid_: New-task screen, pending prompt

**Permission Request**:
An Agent Session request to perform a protected tool action, resolved by selecting one of the options supplied by that request or by a trusted project rule.
_Avoid_: Confirmation dialog, approval popup

**Melody Capability**:
A skill or plugin that Melody can discover and whose enabled state is governed by Melody configuration.
_Avoid_: Settings row, extension toggle

**Research Source Adapter**:
The replaceable seam that turns one academic source request into a bounded operation with source-specific timeout, retry, rate-limit, cache, and response mapping policy.
_Avoid_: Generic fetch helper

**Async Operation**:
A UI operation with an explicit pending/success/error lifecycle and a latest-request rule, so stale results cannot overwrite the current page.
_Avoid_: Loading boolean

**Session Snapshot**:
A bounded, compacted Session Projection persisted as a recovery hint; when it is
truncated, it never resumes from its old ACP cursor. The Session Timeline
Archive can still restore the complete display before ACP replay validates the
running session.
_Avoid_: Complete history

**Session Timeline Archive**:
The append-oriented, unbounded set of Session Projection entries
stored separately from the bounded Session Snapshot. It is the durable source
for restoring complete history; streaming revisions update the same ordinal
instead of creating one row per token delta.
_Avoid_: Snapshot, raw ACP event log

**Application Error**:
The normalized error kind and user-facing message shared by UI, IPC, network, storage, and ACP boundaries.
_Avoid_: Raw transport error
