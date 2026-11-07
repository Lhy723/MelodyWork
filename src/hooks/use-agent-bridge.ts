import { useEffect, useRef } from "react";

import { toUserMessage } from "@/domain/app-error";
import type { AgentStatus } from "@/domain/acp";
import {
  getPiAgentSessionBinding,
  getPiWorkerStatus,
  isTauriRuntime,
  readStoredSessionTimeline,
  startPiWorker,
  stopPiWorker,
  subscribeToAcp,
} from "@/lib/melody-bridge";
import { createPiAgentEventStream } from "@/lib/agent-client";
import { getPiCapabilityReport } from "@/lib/pi-compatibility";
import { isLegacyArchiveSession } from "@/domain/agent/session-archive";
import type { SessionRecord } from "@/domain/workspace";
import { useAgentStore } from "@/stores/agent-store";

/**
 * Browser preview has no host process: the legacy `agent_status`/`start_agent`
 * commands are gone, so the renderer reports the same stopped fixture locally.
 */
const previewAgentStatus = (): AgentStatus => ({
  phase: "stopped",
  message: "浏览器预览",
});

export const useAgentBridge = (
  session?: SessionRecord,
  resetWhenSessionMissing = false,
) => {
  const setStatus = useAgentStore((state) => state.setStatus);
  const resetSessionView = useAgentStore((state) => state.resetSessionView);
  const appendStderr = useAgentStore((state) => state.appendStderr);
  const receiveAcp = useAgentStore((state) => state.receiveAcp);
  const receiveAgentEvent = useAgentStore((state) => state.receiveAgentEvent);
  const beginSession = useAgentStore((state) => state.beginSession);
  const beginArchivedSession = useAgentStore(
    (state) => state.beginArchivedSession,
  );
  const sessionId = session?.id;
  const sessionCwd = session?.cwd;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void)[] = [];
    let piEventStream: ReturnType<typeof createPiAgentEventStream> | undefined;

    const removeListeners = (listeners: (() => void)[]) => {
      for (const unlisten of listeners) {
        unlisten();
      }
    };

    const connect = async () => {
      if (!sessionId || !sessionCwd) {
        if (resetWhenSessionMissing) {
          resetSessionView();
        }
        return;
      }
      const currentSession = sessionRef.current;
      if (!currentSession) {
        return;
      }
      try {
        // Read the persisted timeline archive once, before any engine
        // decision: legacy sessions are identified by it and every open
        // path consumes the result.
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
        if (isTauriRuntime()) {
          let shouldArchive: boolean;
          try {
            const binding = await getPiAgentSessionBinding(sessionId);
            shouldArchive = isLegacyArchiveSession({
              piBindingEngine: binding?.engine,
              acpSessionId: currentSession.acpSessionId,
              hasPersistedTimeline:
                typeof archivedTimelineJson === "string" &&
                archivedTimelineJson.trim().length > 0,
            });
          } catch {
            // An unreadable binding must never archive a session that might
            // be Pi-bound; leave the decision to the normal open path.
            shouldArchive = false;
          }
          if (disposed) {
            return;
          }
          if (shouldArchive) {
            // Legacy archive: seed the visible history, gate the composer,
            // and touch no engine at all — no worker start, no ACP
            // subscribe, no initialize or session.open.
            useAgentStore.setState({
              capabilityDiagnostics: [],
              archivedReadOnly: true,
            });
            await beginArchivedSession(
              sessionCwd,
              sessionId,
              currentSession.timelineJson,
              archivedTimelineJson,
              archiveReadFailed ? 0 : currentSession.timelineVersion,
            );
            return;
          }
        }
        // Runtime context is the only router: Desktop is Pi-only and browser
        // preview retains the deterministic local ACP fixture.
        const usePi = isTauriRuntime();
        // Peripheral capability gaps keep the session on Pi; the notice rides
        // on the status message so the user sees what is unavailable without a
        // dedicated UI surface for capabilityDiagnostics.
        let degradationNotice: string | undefined;
        const joinNotice = (messages: string[]): string | undefined => {
          if (messages.length === 0) return undefined;
          const joined = messages.slice(0, 3).join(" ");
          return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
        };
        if (usePi) {
          try {
            const report = await getPiCapabilityReport(sessionCwd);
            if (disposed) {
              return;
            }
            useAgentStore.setState({
              capabilityDiagnostics: report.diagnostics,
            });
            if (report.blocksPiSession) {
              // A session-level risk (unreadable config, unenforceable
              // sandbox) must refuse to open rather than run on a silently
              // weaker path. Pi-only mode never switches engines here.
              const blocked = report.diagnostics
                .map((item) => item.message)
                .join(" ");
              setStatus({
                phase: "failed",
                message: `无法以 Pi 打开该会话：${blocked}`,
              });
              return;
            }
            degradationNotice = joinNotice(
              (report.degradations ?? []).map((item) => item.message),
            );
          } catch (reason) {
            // A failed inspection must not allow Pi to run with an unknown
            // extension/config surface. Refuse the session and leave a
            // structured diagnostic for the renderer.
            const detail =
              reason instanceof Error ? reason.message : String(reason);
            useAgentStore.setState({
              capabilityDiagnostics: [
                {
                  code: "pi.compatibility_inspection_failed",
                  capability: "compatibility-inspection",
                  severity: "blocking",
                  message: `无法确认当前工作区的 Pi 兼容性，已停止连接。 ${detail}`,
                },
              ],
            });
            setStatus({
              phase: "failed",
              message: `无法确认当前工作区的 Pi 兼容性，已停止连接：${detail}`,
            });
            return;
          }
        } else {
          if (disposed) {
            return;
          }
          useAgentStore.setState({ capabilityDiagnostics: [] });
        }
        if (disposed) {
          return;
        }
        let listeners: (() => void)[] = [];
        const subscribeForRuntime = async (): Promise<(() => void)[]> => {
          if (usePi) {
            piEventStream = createPiAgentEventStream(
              (event) => {
                if (!disposed) {
                  receiveAgentEvent(event);
                }
              },
              (line) => {
                if (!disposed) {
                  appendStderr(line);
                }
              },
              (status) => {
                if (!disposed) {
                  setStatus(
                    degradationNotice
                      ? {
                          ...status,
                          message: [status.message, degradationNotice]
                            .filter(Boolean)
                            .join("；"),
                        }
                      : status,
                  );
                }
              },
            );
            return piEventStream.subscribe;
          }
          return subscribeToAcp(
            (message) => {
              if (!disposed) {
                receiveAcp(message);
              }
            },
            (line) => {
              if (!disposed) {
                appendStderr(line);
              }
            },
            (status) => {
              if (!disposed) {
                setStatus(status);
              }
            },
          );
        };
        const detachListeners = () => {
          const active = Array.from(new Set([...listeners, ...unsubscribe]));
          removeListeners(active);
          listeners = [];
          unsubscribe = [];
        };
        try {
          listeners = await subscribeForRuntime();
          if (disposed) {
            detachListeners();
            return;
          }
          unsubscribe = listeners;
        } catch (reason) {
          if (!usePi) {
            throw reason;
          }
          // The legacy engine is gone: a Pi worker failure is a hard error for
          // this session, never a silent engine switch. Tear down any partial
          // worker state so a retry starts clean.
          const detail = toUserMessage(reason, "Pi worker 启动失败。");
          detachListeners();
          piEventStream?.stream.clear();
          piEventStream = undefined;
          try {
            await stopPiWorker();
          } catch {
            // The worker may already have exited.
          }
          if (disposed) {
            return;
          }
          useAgentStore.setState((state) => ({
            capabilityDiagnostics: [
              ...state.capabilityDiagnostics,
              {
                code: "pi.worker_unavailable",
                capability: "worker",
                severity: "blocking",
                message: `Pi worker 无法启动：${detail}。已停止连接。`,
                source: "pi-worker",
              },
            ],
          }));
          setStatus({
            phase: "failed",
            message: `Pi worker 启动失败：${detail}`,
          });
          return;
        }

        const current: AgentStatus = usePi
          ? await getPiWorkerStatus()
          : previewAgentStatus();
        if (disposed) {
          return;
        }
        setStatus(current);
        // Pi's worker is workspace-scoped: a running worker may need to
        // be replaced when the user opens a session from another project.
        // Call the idempotent start command for every Pi connection so the
        // Host can compare the canonical cwd and restart with the right
        // model and skill catalog. The browser preview has no host to start,
        // so it keeps reporting the local fixture.
        const shouldInitialize = current.phase === "stopped" || usePi;
        let running = current;
        if (usePi || current.phase === "stopped") {
          running = usePi ? await startPiWorker(sessionCwd) : current;
        }
        if (disposed) {
          return;
        }
        if (usePi && running.phase !== "running") {
          throw new Error(
            running.message ?? `Pi worker 状态为 ${running.phase}。`,
          );
        }
        if (!disposed) {
          setStatus(running);
        }
        if (!disposed && (running.phase === "running" || !isTauriRuntime())) {
          await beginSession(
            sessionCwd,
            sessionId,
            currentSession.acpSessionId ?? undefined,
            currentSession.timelineJson,
            currentSession.acpCursor ?? undefined,
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
      piEventStream?.stream.clear();
    };
  }, [
    appendStderr,
    beginSession,
    beginArchivedSession,
    receiveAgentEvent,
    receiveAcp,
    // Do not depend on session.acpSessionId here. The backend writes that
    // value while opening a session; reconnecting at that moment can create
    // a short unsubscribe gap and drop later streaming update events.
    sessionCwd,
    sessionId,
    resetSessionView,
    resetWhenSessionMissing,
    setStatus,
  ]);
};
