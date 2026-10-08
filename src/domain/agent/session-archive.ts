/**
 * Status notice shown when a legacy-engine session is opened as a read-only
 * archive. The composer gate and this message must tell one coherent story.
 */
export const ARCHIVE_STATUS_NOTICE =
  "该会话由旧引擎创建，已归档为只读；历史记录仍可查看，新工作请新建会话。";

/**
 * The selected session's archive state must not disable a separate new-task
 * composer. Only the composer attached to the archived session is read-only.
 */
export const isComposerReadOnly = (input: {
  archivedReadOnly: boolean;
  creatingNewTask: boolean;
}): boolean => input.archivedReadOnly && !input.creatingNewTask;

/**
 * Decide whether a Pi open must import an existing ACP session. New database
 * rows serialize their optional ACP id as `null`, which is not evidence of a
 * legacy session.
 */
export const shouldImportPiSession = (input: {
  piBindingEngine?: string;
  acpSessionId?: string | null;
}): boolean =>
  input.piBindingEngine === "melody-acp" ||
  (input.piBindingEngine === undefined && Boolean(input.acpSessionId?.trim()));

/**
 * Decide whether a session must be opened as a read-only archive instead of
 * starting an engine.
 *
 * A session is a legacy archive only when it is NOT durably bound to Pi and
 * at least one legacy marker is present:
 * - an existing `melody-acp` binding (the binding alone proves the session
 *   was created by the old engine — chosen deliberately so reopening such a
 *   session never restarts that engine even when its history has not been
 *   persisted yet),
 * - a legacy ACP session id on the record, or
 * - a persisted timeline archive.
 *
 * A session with no binding and no history of either kind is brand new (or
 * Pi-bound but not yet opened) and must open normally.
 */
export const isLegacyArchiveSession = (input: {
  piBindingEngine?: string;
  acpSessionId?: string | null;
  hasPersistedTimeline: boolean;
}): boolean =>
  input.piBindingEngine !== "pi" &&
  (input.piBindingEngine === "melody-acp" ||
    Boolean(input.acpSessionId?.trim()) ||
    input.hasPersistedTimeline);
