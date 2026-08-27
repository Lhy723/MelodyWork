import { useEffect, useRef } from "react";

import { questionRequestKey } from "@/domain/user-question";
import { sendSystemNotification } from "@/lib/system-notifications";
import { useAgentStore } from "@/stores/agent-store";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const pendingApprovalIds = (
  timeline: ReturnType<typeof useAgentStore.getState>["timeline"],
) =>
  timeline.flatMap((entry) => {
    if (
      entry.kind === "tool" &&
      entry.permission === "pending" &&
      entry.permissionRequestId !== undefined
    ) {
      return [`tool:${String(entry.permissionRequestId)}`];
    }
    if (
      entry.kind === "plan" &&
      entry.status === "awaiting-approval" &&
      entry.requestId !== undefined
    ) {
      return [`plan:${String(entry.requestId)}`];
    }
    return [];
  });

const pendingQuestionIds = (
  timeline: ReturnType<typeof useAgentStore.getState>["timeline"],
) =>
  timeline.flatMap((entry) => {
    if (entry.kind === "tool" && entry.question?.outcome === "pending") {
      return [`question:${questionRequestKey(entry.question)}`];
    }
    return [];
  });

const sessionTitleForQuestion = (
  sessionId: string,
  sessionsByProject: ReturnType<
    typeof useWorkspaceStore.getState
  >["sessionsByProject"],
) => {
  const backgroundSession = Object.values(sessionsByProject)
    .flat()
    .find((session) => session.acpSessionId === sessionId);
  return backgroundSession?.title;
};

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
  const seenApprovals = useRef(new Set(pendingApprovalIds(timeline)));
  const seenQuestions = useRef(
    new Set([
      ...pendingQuestionIds(timeline),
      ...Object.values(backgroundTimelines).flatMap(pendingQuestionIds),
    ]),
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
    const pending = pendingApprovalIds(timeline);
    const newApproval = pending.find((id) => !seenApprovals.current.has(id));
    for (const id of pending) {
      seenApprovals.current.add(id);
    }
    if (!permissionNotifications || !newApproval) {
      return;
    }
    const timer = window.setTimeout(() => {
      const stillPending = pendingApprovalIds(
        useAgentStore.getState().timeline,
      ).includes(newApproval);
      if (!stillPending) {
        return;
      }
      void sendSystemNotification(
        "Melody 需要授权",
        activeSessionTitle
          ? `“${activeSessionTitle}”正在等待你的确认。`
          : "当前任务正在等待你的确认。",
      ).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeSessionTitle, permissionNotifications, timeline]);

  useEffect(() => {
    const pending = [
      ...timeline.flatMap((entry) => {
        if (entry.kind !== "tool" || entry.question?.outcome !== "pending") {
          return [];
        }
        return [
          {
            id: `question:${questionRequestKey(entry.question)}`,
            sessionId: entry.question.sessionId,
            title: activeSessionTitle,
          },
        ];
      }),
      ...Object.entries(backgroundTimelines).flatMap(([sessionId, entries]) =>
        entries.flatMap((entry) => {
          if (entry.kind !== "tool" || entry.question?.outcome !== "pending") {
            return [];
          }
          return [
            {
              id: `question:${questionRequestKey(entry.question)}`,
              sessionId,
              title: sessionTitleForQuestion(sessionId, sessionsByProject),
            },
          ];
        }),
      ),
    ];
    const newQuestion = pending.find(
      (question) => !seenQuestions.current.has(question.id),
    );
    for (const question of pending) {
      seenQuestions.current.add(question.id);
    }
    if (!questionNotifications || !newQuestion) {
      return;
    }
    const timer = window.setTimeout(() => {
      const state = useAgentStore.getState();
      const stillPending = [
        ...pendingQuestionIds(state.timeline),
        ...Object.values(state.backgroundTimelines).flatMap(pendingQuestionIds),
      ].includes(newQuestion.id);
      if (!stillPending) {
        return;
      }
      void sendSystemNotification(
        "Melody 需要你的回答",
        newQuestion.title
          ? `“${newQuestion.title}”正在等待你的回答。`
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
