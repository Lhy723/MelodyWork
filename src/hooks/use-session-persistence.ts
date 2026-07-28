import { useEffect, useRef } from "react";

import { updateStoredSession } from "@/lib/melody-bridge";
import { timelineProjectionVersion } from "@/domain/session-projection";
import { useAgentStore } from "@/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const deriveTitle = (
  currentTitle: string | undefined,
  timeline: ReturnType<typeof useAgentStore.getState>["timeline"],
) => {
  if (
    currentTitle &&
    currentTitle !== "New session" &&
    currentTitle !== "新会话"
  ) {
    return currentTitle;
  }
  const firstPrompt = timeline.find(
    (entry) => entry.kind === "message" && entry.role === "user",
  );
  if (firstPrompt?.kind !== "message") {
    return currentTitle;
  }
  const compact = firstPrompt.content.replace(/\s+/g, " ").trim();
  return compact.length > 52 ? `${compact.slice(0, 51)}…` : compact;
};

export const useSessionPersistence = () => {
  const localSessionId = useAgentStore((state) => state.localSessionId);
  const timeline = useAgentStore((state) => state.timeline);
  const acpCursor = useAgentStore((state) => state.acpCursor);
  const activeSession = useWorkspaceStore((state) => state.activeSession);
  const replaceSession = useWorkspaceStore((state) => state.replaceSession);
  const lastSaved = useRef("");

  useEffect(() => {
    if (!localSessionId || activeSession?.id !== localSessionId) {
      return;
    }
    const timelineJson = JSON.stringify(timeline);
    const title = deriveTitle(activeSession.title, timeline);
    const signature = `${localSessionId}:${title}:${acpCursor ?? ""}:${timelineJson}`;
    if (signature === lastSaved.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      void updateStoredSession({
        id: localSessionId,
        title,
        timelineJson,
        acpCursor: acpCursor ?? null,
        timelineVersion: timelineProjectionVersion(timeline),
      }).then((session) => {
        lastSaved.current = signature;
        replaceSession(session);
      });
    }, 650);

    return () => window.clearTimeout(timer);
  }, [
    activeSession,
    acpCursor,
    localSessionId,
    replaceSession,
    timeline,
  ]);
};
