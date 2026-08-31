import { useEffect, useRef } from "react";

import { toUserMessage } from "@/domain/app-error";
import {
  getAgentStatus,
  isTauriRuntime,
  readStoredSessionTimeline,
  startAgent,
  subscribeToAcp,
} from "@/lib/melody-bridge";
import type { SessionRecord } from "@/domain/workspace";
import { useAgentStore } from "@/stores/agent-store";

export const useAgentBridge = (session?: SessionRecord) => {
  const setStatus = useAgentStore((state) => state.setStatus);
  const appendStderr = useAgentStore((state) => state.appendStderr);
  const receiveAcp = useAgentStore((state) => state.receiveAcp);
  const beginSession = useAgentStore((state) => state.beginSession);
  const sessionId = session?.id;
  const sessionCwd = session?.cwd;
  const sessionAcpId = session?.acpSessionId;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void)[] = [];

    const removeListeners = (listeners: (() => void)[]) => {
      for (const unlisten of listeners) {
        unlisten();
      }
    };

    const connect = async () => {
      if (!sessionId || !sessionCwd) {
        return;
      }
      const currentSession = sessionRef.current;
      if (!currentSession) {
        return;
      }
      try {
        const listeners = await subscribeToAcp(
          receiveAcp,
          appendStderr,
          setStatus,
        );
        if (disposed) {
          removeListeners(listeners);
          return;
        }
        unsubscribe = listeners;
        const current = await getAgentStatus();
        if (disposed) {
          return;
        }
        setStatus(current);
        const shouldInitialize = current.phase === "stopped";
        let running = current;
        if (current.phase === "stopped") {
          running = await startAgent(sessionCwd);
          if (!disposed) {
            setStatus(running);
          }
        }
        if (!disposed && (running.phase === "running" || !isTauriRuntime())) {
          let archiveReadFailed = false;
          let archivedTimelineJson: string | undefined;
          try {
            archivedTimelineJson = await readStoredSessionTimeline(sessionId);
          } catch {
            // A corrupt or incomplete archive must never leave the old cursor
            // looking trustworthy. The session loader will request a replay.
            archiveReadFailed = true;
          }
          if (disposed) {
            return;
          }
          await beginSession(
            sessionCwd,
            sessionId,
            sessionAcpId,
            currentSession.timelineJson,
            currentSession.acpCursor,
            archiveReadFailed ? 0 : currentSession.timelineVersion,
            archivedTimelineJson,
            shouldInitialize,
          );
        }
      } catch (reason) {
        if (!disposed) {
          setStatus({
            phase: "failed",
            message: toUserMessage(reason, "Agent 连接失败，请稍后重试。"),
          });
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      removeListeners(unsubscribe);
    };
  }, [
    appendStderr,
    beginSession,
    receiveAcp,
    sessionAcpId,
    sessionCwd,
    sessionId,
    setStatus,
  ]);
};
