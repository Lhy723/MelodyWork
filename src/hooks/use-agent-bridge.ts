import { useEffect, useRef } from "react";

import {
  getAgentStatus,
  isTauriRuntime,
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
        let running = current;
        if (current.phase === "stopped") {
          running = await startAgent(sessionCwd);
          if (!disposed) {
            setStatus(running);
          }
        }
        if (
          !disposed &&
          (running.phase === "running" || !isTauriRuntime())
        ) {
          await beginSession(
            sessionCwd,
            sessionId,
            sessionAcpId,
            currentSession.timelineJson,
            currentSession.acpCursor,
            currentSession.timelineVersion,
          );
        }
      } catch (reason) {
        if (!disposed) {
          setStatus({
            phase: "failed",
            message:
              reason instanceof Error ? reason.message : String(reason),
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
