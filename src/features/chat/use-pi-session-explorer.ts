import { useEffect, useMemo, useState } from "react";

import type { TimelineEntry } from "@/domain/acp";
import type { PiSessionFork } from "@/domain/agent/pi-session-fork";
import type { SessionRecord } from "@/domain/workspace";
import { toUserMessage } from "@/domain/app-error";
import {
  createStoredSession,
  forkPiSession,
  getPiSessionFork,
  isTauriRuntime,
  listPiSessionForks,
  listStoredSessions,
  updateStoredSession,
} from "@/lib/melody-bridge";
import {
  readSessionComposerDraft,
  writeSessionComposerDraft,
} from "@/lib/session-composer-draft";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  createPiSessionExplorer,
  type PiExplorerMessage,
  type PiSessionExplorerWorkspacePatch,
  type PiSessionExplorerWorkspaceState,
} from "./pi-session-explorer";

export function usePiSessionExplorer(options: {
  activeSession?: SessionRecord;
  sessionsByProject: Record<string, SessionRecord[]>;
  timeline: TimelineEntry[];
  selectSession: (session: SessionRecord) => void | Promise<void>;
}) {
  const { activeSession, sessionsByProject, timeline, selectSession } = options;
  const [activePiFork, setActivePiFork] = useState<PiSessionFork>();
  const [relatedPiForks, setRelatedPiForks] = useState<PiSessionFork[]>([]);
  const [piForkRecoveryBusy, setPiForkRecoveryBusy] = useState(false);
  const workspace = useMemo(
    () => ({
      setState: (
        update:
          | PiSessionExplorerWorkspacePatch
          | ((
              state: PiSessionExplorerWorkspaceState,
            ) => PiSessionExplorerWorkspacePatch),
      ) => {
        useWorkspaceStore.setState((state) =>
          typeof update === "function" ? update(state) : update,
        );
      },
    }),
    [],
  );
  const explorer = useMemo(
    () =>
      createPiSessionExplorer({
        createStoredSession,
        updateStoredSession,
        forkPiSession,
        getPiSessionFork,
        listPiSessionForks,
        listStoredSessions,
        readComposerDraft: readSessionComposerDraft,
        writeComposerDraft: writeSessionComposerDraft,
        selectSession,
        toUserMessage,
        workspace,
      }),
    [selectSession, workspace],
  );
  const activeSessionId = activeSession?.id;

  useEffect(() => {
    let current = true;
    if (!activeSessionId || !isTauriRuntime()) {
      setActivePiFork(undefined);
      setRelatedPiForks([]);
      return () => {
        current = false;
      };
    }
    void explorer.load(activeSessionId).then((forkState) => {
      if (current) {
        setActivePiFork(forkState.activePiFork);
        setRelatedPiForks(forkState.relatedPiForks);
      }
    });
    return () => {
      current = false;
    };
  }, [activeSessionId, explorer]);

  const activeSessionPiFork =
    activePiFork?.branchSessionId === activeSessionId
      ? activePiFork
      : undefined;

  const explore = (entry: PiExplorerMessage) => {
    if (!isTauriRuntime()) return;
    return explorer.explore({
      source: activeSession,
      entry,
      timeline,
    });
  };

  const resume = async () => {
    const branch = activeSession;
    const fork = activeSessionPiFork;
    if (!fork || fork.status === "ready" || !branch || piForkRecoveryBusy) {
      return;
    }
    setPiForkRecoveryBusy(true);
    try {
      const result = await explorer.resume({
        fork,
        branch,
        sessionsByProject,
      });
      if (result?.activePiFork) setActivePiFork(result.activePiFork);
      if (result?.relatedPiForks) setRelatedPiForks(result.relatedPiForks);
    } finally {
      setPiForkRecoveryBusy(false);
    }
  };

  const bringBack = (entry: PiExplorerMessage) =>
    explorer.bringBack({
      fork: activeSessionPiFork,
      branch: activeSession,
      entry,
      timeline,
      sessionsByProject,
    });

  return {
    activeSessionPiFork,
    relatedPiForks,
    piForkRecoveryBusy,
    explore,
    resume,
    bringBack,
  };
}
