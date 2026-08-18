import { useEffect, useRef } from "react";

import { timelineProjectionVersion } from "@/domain/session-projection";
import { updateStoredSession } from "@/lib/melody-bridge";
import { useAgentStore } from "@/stores/agent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const PERSIST_DEBOUNCE_MS = 650;

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

type PendingSnapshot = {
  id: string;
  title?: string;
  timeline: ReturnType<typeof useAgentStore.getState>["timeline"];
  acpCursor?: string;
  activelyStreaming: boolean;
  revision: number;
};

export const useSessionPersistence = () => {
  const localSessionId = useAgentStore((state) => state.localSessionId);
  const timeline = useAgentStore((state) => state.timeline);
  const acpCursor = useAgentStore((state) => state.acpCursor);
  const chatStatus = useAgentStore((state) => state.chatStatus);
  const activeSession = useWorkspaceStore((state) => state.activeSession);
  const replaceSession = useWorkspaceStore((state) => state.replaceSession);

  const pending = useRef(new Map<string, PendingSnapshot>());
  const latest = useRef(new Map<string, PendingSnapshot>());
  const savedSignatures = useRef(new Map<string, string>());
  const nextRevision = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const draining = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  const flush = async () => {
    if (draining.current) {
      return;
    }
    draining.current = true;
    try {
      while (pending.current.size > 0) {
        const first = pending.current.entries().next().value as
          [string, PendingSnapshot] | undefined;
        if (!first) {
          break;
        }
        const [id, snapshot] = first;
        pending.current.delete(id);

        // Serialization happens at the write boundary, once per coalesced
        // snapshot, instead of once for every streamed agent chunk.
        const timelineJson = JSON.stringify(snapshot.timeline);
        const signature = `${snapshot.id}:${snapshot.title ?? ""}:${snapshot.acpCursor ?? ""}:${timelineJson}`;
        if (savedSignatures.current.get(id) === signature) {
          continue;
        }
        try {
          const session = await updateStoredSession({
            id: snapshot.id,
            title: snapshot.title,
            timelineJson,
            acpCursor: snapshot.acpCursor ?? null,
            timelineVersion: timelineProjectionVersion(
              snapshot.timeline,
              snapshot.activelyStreaming,
            ),
          });
          savedSignatures.current.set(id, signature);
          if (latest.current.get(id)?.revision === snapshot.revision) {
            replaceSession(session);
          }
        } catch {
          // Keep the newest snapshot queued for the next flush. A transient
          // IPC/database failure must not lose the in-memory timeline.
          const newest = latest.current.get(id);
          if (newest?.revision === snapshot.revision) {
            pending.current.set(id, newest);
          }
          break;
        }
      }
    } finally {
      draining.current = false;
      if (pending.current.size > 0) {
        schedule();
      }
    }
  };
  flushRef.current = flush;

  const schedule = () => {
    if (timer.current !== undefined || draining.current) {
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      void flushRef.current();
    }, PERSIST_DEBOUNCE_MS);
  };

  useEffect(() => {
    if (!localSessionId || activeSession?.id !== localSessionId) {
      return;
    }
    const snapshot: PendingSnapshot = {
      id: localSessionId,
      title: deriveTitle(activeSession.title, timeline),
      timeline,
      acpCursor,
      activelyStreaming:
        chatStatus === "submitted" || chatStatus === "streaming",
      revision: ++nextRevision.current,
    };
    latest.current.set(localSessionId, snapshot);
    pending.current.set(localSessionId, snapshot);
    schedule();
  }, [activeSession, acpCursor, chatStatus, localSessionId, timeline]);

  useEffect(() => {
    const flushNow = () => {
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      void flushRef.current();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushNow();
      }
    };
    window.addEventListener("pagehide", flushNow);
    window.addEventListener("beforeunload", flushNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      window.removeEventListener("beforeunload", flushNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      void flushRef.current();
    };
  }, []);
};
