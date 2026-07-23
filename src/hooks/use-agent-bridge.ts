import { useEffect } from "react";

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

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void)[] = [];

    const connect = async () => {
      if (!session) {
        return;
      }
      unsubscribe = await subscribeToAcp(receiveAcp, appendStderr);
      const current = await getAgentStatus();
      if (disposed) {
        return;
      }
      setStatus(current);
      let running = current;
      if (current.phase === "stopped") {
        running = await startAgent(session.cwd);
        if (!disposed) {
          setStatus(running);
        }
      }
      if (
        !disposed &&
        (running.phase === "running" || !isTauriRuntime())
      ) {
        await beginSession(
          session.cwd,
          session.id,
          session.acpSessionId,
          session.timelineJson,
        );
      }
    };

    void connect();

    return () => {
      disposed = true;
      for (const unlisten of unsubscribe) {
        unlisten();
      }
    };
  }, [
    appendStderr,
    beginSession,
    receiveAcp,
    session,
    setStatus,
  ]);
};
