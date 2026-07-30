import { useEffect, useRef } from "react";

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

export function useAgentNotifications() {
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const timeline = useAgentStore((state) => state.timeline);
  const completionNotification = useAppSettingsStore(
    (state) => state.completionNotification,
  );
  const permissionNotifications = useAppSettingsStore(
    (state) => state.permissionNotifications,
  );
  const activeSessionTitle = useWorkspaceStore(
    (state) => state.activeSession?.title,
  );
  const previousChatStatus = useRef(chatStatus);
  const seenApprovals = useRef(new Set(pendingApprovalIds(timeline)));

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
}
