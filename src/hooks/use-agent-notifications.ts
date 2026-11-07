import { useEffect, useRef } from "react";

import type { TimelineEntry } from "@/domain/acp";
import {
  pendingInteractions,
  pendingNotificationCandidates,
  type PendingInteraction,
  productSessionIdForRuntimeKey,
} from "@/domain/agent/pending-interaction";
import type { SessionRecord } from "@/domain/workspace";
import { sendSystemNotification } from "@/lib/system-notifications";
import { useAgentStore } from "@/stores/agent-store";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

type SessionsByProject = Record<string, SessionRecord[]>;

type PendingCandidate = PendingInteraction & {
  title?: string;
  /** Background timeline key; `undefined` for the visible session. */
  runtimeSessionId?: string;
};

/** Notification target: which gate the user must resolve, and for which session. */
type PendingTarget = "approval" | "question";

/**
 * Collect candidates from the visible timeline and every background timeline.
 * The visible timeline wins for an interaction already present there, so an
 * active session that also lingers in `backgroundTimelines` notifies once.
 *
 * Background timelines are keyed by the event identity, which is the product
 * session id for Pi and the persisted ACP session id for legacy sessions, so
 * each key is resolved back to its product session title before notifying.
 */
const pendingCandidates = (
  timeline: readonly TimelineEntry[],
  backgroundTimelines: Readonly<Record<string, readonly TimelineEntry[]>>,
  activeSessionTitle: string | undefined,
  sessionsByProject: SessionsByProject,
  target: PendingTarget,
): PendingCandidate[] => {
  const sessions = Object.values(sessionsByProject).flat();
  const candidates: PendingCandidate[] = [];
  for (const candidate of pendingNotificationCandidates({
    timeline,
    backgroundTimelines,
    target,
  })) {
    const { runtimeSessionId } = candidate;
    const productSessionId =
      runtimeSessionId === undefined
        ? undefined
        : productSessionIdForRuntimeKey(runtimeSessionId, sessions);
    candidates.push({
      ...candidate,
      title:
        runtimeSessionId === undefined
          ? activeSessionTitle
          : productSessionId === undefined
            ? undefined
            : sessions.find((session) => session.id === productSessionId)
                ?.title,
    });
  }
  return candidates;
};

/** Re-read every timeline to confirm a notification target is still blocked. */
const pendingKeys = (
  timeline: readonly TimelineEntry[],
  backgroundTimelines: Readonly<Record<string, readonly TimelineEntry[]>>,
) =>
  new Set([
    ...pendingInteractions(timeline).map(({ key }) => key),
    ...Object.values(backgroundTimelines).flatMap((entries) =>
      pendingInteractions(entries).map(({ key }) => key),
    ),
  ]);

export function useAgentNotifications() {
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const timeline = useAgentStore((state) => state.timeline);
  const backgroundTimelines = useAgentStore(
    (state) => state.backgroundTimelines,
  );
  const completionNotification = useAppSettingsStore(
    (state) => state.completionNotification,
  );
  const permissionNotifications = useAppSettingsStore(
    (state) => state.permissionNotifications,
  );
  const questionNotifications = useAppSettingsStore(
    (state) => state.questionNotifications,
  );
  const activeSessionTitle = useWorkspaceStore(
    (state) => state.activeSession?.title,
  );
  const sessionsByProject = useWorkspaceStore(
    (state) => state.sessionsByProject,
  );
  const previousChatStatus = useRef(chatStatus);
  const seenApprovals = useRef(
    new Set(
      pendingCandidates(
        timeline,
        backgroundTimelines,
        activeSessionTitle,
        sessionsByProject,
        "approval",
      ).map(({ key }) => key),
    ),
  );
  const seenQuestions = useRef(
    new Set(
      pendingCandidates(
        timeline,
        backgroundTimelines,
        activeSessionTitle,
        sessionsByProject,
        "question",
      ).map(({ key }) => key),
    ),
  );

  useEffect(() => {
    const previous = previousChatStatus.current;
    previousChatStatus.current = chatStatus;
    if (
      chatStatus !== "ready" ||
      (previous !== "submitted" && previous !== "streaming") ||
      completionNotification === "never" ||
      (completionNotification === "unfocused" && document.hasFocus())
    ) {
      return;
    }
    void sendSystemNotification(
      "Melody 已完成",
      activeSessionTitle
        ? `“${activeSessionTitle}”已完成本轮回复。`
        : "当前任务已完成本轮回复。",
    ).catch(() => undefined);
  }, [activeSessionTitle, chatStatus, completionNotification]);

  useEffect(() => {
    const pending = pendingCandidates(
      timeline,
      backgroundTimelines,
      activeSessionTitle,
      sessionsByProject,
      "approval",
    );
    const newApproval = pending.find(
      (approval) => !seenApprovals.current.has(approval.key),
    );
    for (const approval of pending) {
      seenApprovals.current.add(approval.key);
    }
    if (!permissionNotifications || !newApproval) {
      return;
    }
    const timer = window.setTimeout(() => {
      const state = useAgentStore.getState();
      const stillPending = pendingKeys(
        state.timeline,
        state.backgroundTimelines,
      ).has(newApproval.key);
      if (!stillPending) {
        return;
      }
      void sendSystemNotification(
        "Melody 需要授权",
        newApproval.title
          ? `“${newApproval.title}”正在等待你的确认。`
          : newApproval.runtimeSessionId
            ? "后台任务正在等待你的确认。"
            : "当前任务正在等待你的确认。",
      ).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeSessionTitle,
    backgroundTimelines,
    permissionNotifications,
    sessionsByProject,
    timeline,
  ]);

  useEffect(() => {
    const pending = pendingCandidates(
      timeline,
      backgroundTimelines,
      activeSessionTitle,
      sessionsByProject,
      "question",
    );
    const newQuestion = pending.find(
      (question) => !seenQuestions.current.has(question.key),
    );
    for (const question of pending) {
      seenQuestions.current.add(question.key);
    }
    if (!questionNotifications || !newQuestion) {
      return;
    }
    const timer = window.setTimeout(() => {
      const state = useAgentStore.getState();
      const stillPending = pendingKeys(
        state.timeline,
        state.backgroundTimelines,
      ).has(newQuestion.key);
      if (!stillPending) {
        return;
      }
      void sendSystemNotification(
        "Melody 需要你的回答",
        newQuestion.title
          ? `“${newQuestion.title}”正在等待你的回答。`
          : newQuestion.runtimeSessionId
            ? "后台任务正在等待你的回答。"
            : "当前任务正在等待你的回答。",
      ).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeSessionTitle,
    backgroundTimelines,
    questionNotifications,
    sessionsByProject,
    timeline,
  ]);
}
