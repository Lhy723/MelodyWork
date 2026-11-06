import { appendExplorerSessionReferenceToDraft } from "../../domain/agent/explorer-branch.ts";
import type { TimelineEntry } from "../../domain/acp";
import type { PiSessionFork } from "../../domain/agent/pi-session-fork";
import type {
  ProjectRecord,
  SessionRecord,
  UpdateSessionRequest,
} from "../../domain/workspace";

export type PiExplorerMessage = Extract<TimelineEntry, { kind: "message" }>;

export interface PiSessionExplorerWorkspaceState {
  activeProject?: ProjectRecord;
  activeSession?: SessionRecord;
  sessions?: SessionRecord[];
  sessionsByProject: Record<string, SessionRecord[]>;
  error?: string;
}

export type PiSessionExplorerWorkspacePatch =
  Partial<PiSessionExplorerWorkspaceState>;

export interface PiSessionExplorerWorkspaceAdapter {
  setState: (
    update:
      | PiSessionExplorerWorkspacePatch
      | ((
          state: PiSessionExplorerWorkspaceState,
        ) => PiSessionExplorerWorkspacePatch),
  ) => void;
}

export interface PiSessionExplorerDependencies {
  createStoredSession: (
    projectId: string,
    cwd: string,
  ) => Promise<SessionRecord>;
  updateStoredSession: (
    request: UpdateSessionRequest,
  ) => Promise<SessionRecord>;
  forkPiSession: (
    source: SessionRecord,
    target: SessionRecord,
    nativeEntryId: string,
  ) => Promise<void>;
  getPiSessionFork: (
    branchSessionId: string,
  ) => Promise<PiSessionFork | undefined>;
  listPiSessionForks: (sessionId: string) => Promise<PiSessionFork[]>;
  listStoredSessions: (projectId: string) => Promise<SessionRecord[]>;
  readComposerDraft: (sessionId: string) => string;
  writeComposerDraft: (sessionId: string, value: string) => boolean;
  selectSession: (session: SessionRecord) => void | Promise<void>;
  toUserMessage: (reason: unknown, fallback: string) => string;
  workspace: PiSessionExplorerWorkspaceAdapter;
}

export interface PiSessionExplorerResumeResult {
  activePiFork?: PiSessionFork;
  relatedPiForks?: PiSessionFork[];
}

export const createPiSessionExplorer = (
  dependencies: PiSessionExplorerDependencies,
) => {
  const load = async (
    branchSessionId: string,
  ): Promise<{
    activePiFork?: PiSessionFork;
    relatedPiForks: PiSessionFork[];
  }> => {
    try {
      const [activePiFork, relatedPiForks] = await Promise.all([
        dependencies.getPiSessionFork(branchSessionId),
        dependencies.listPiSessionForks(branchSessionId),
      ]);
      return { activePiFork, relatedPiForks };
    } catch {
      return { activePiFork: undefined, relatedPiForks: [] };
    }
  };

  const publishBranch = (
    source: SessionRecord,
    branch: SessionRecord,
    activateIfSourceIsCurrent: boolean,
    error?: string,
  ) => {
    dependencies.workspace.setState((state) => {
      const projectSessions = [
        branch,
        ...(state.sessionsByProject[source.projectId] ?? []).filter(
          (session) => session.id !== branch.id,
        ),
      ];
      const shouldActivate =
        activateIfSourceIsCurrent && state.activeSession?.id === source.id;
      return {
        sessionsByProject: {
          ...state.sessionsByProject,
          [source.projectId]: projectSessions,
        },
        ...(state.activeProject?.id === source.projectId
          ? { sessions: projectSessions }
          : {}),
        ...(shouldActivate
          ? {
              activeProject: state.activeProject,
              activeSession: branch,
            }
          : {}),
        error,
      };
    });
  };

  const explore = async (input: {
    source?: SessionRecord;
    entry: PiExplorerMessage;
    timeline: TimelineEntry[];
  }): Promise<void> => {
    const { source, entry, timeline } = input;
    if (!source || entry.role !== "assistant" || !entry.nativeEntryId) {
      return;
    }
    const anchorIndex = timeline.findIndex(
      (candidate) => candidate.kind === "message" && candidate.id === entry.id,
    );
    if (anchorIndex < 0) return;

    let recoveryRecord: SessionRecord | undefined;
    try {
      const branch = await dependencies.createStoredSession(
        source.projectId,
        source.cwd,
      );
      recoveryRecord = branch;
      const titleSeed = entry.content.replace(/\s+/gu, " ").trim();
      const title = `探索：${(titleSeed || source.title).slice(0, 32)}`;
      const branchTimeline = timeline.slice(0, anchorIndex + 1);
      const preparedBranch = await dependencies.updateStoredSession({
        id: branch.id,
        title,
        timelineJson: JSON.stringify(branchTimeline),
        timelineVersion: source.timelineVersion ?? 0,
      });
      recoveryRecord = preparedBranch;
      await dependencies.forkPiSession(
        source,
        preparedBranch,
        entry.nativeEntryId,
      );
      publishBranch(source, preparedBranch, true);
    } catch (reason) {
      const message = dependencies.toUserMessage(
        reason,
        "创建 Pi 探索分支失败。",
      );
      if (recoveryRecord) {
        publishBranch(source, recoveryRecord, false, message);
        return;
      }
      dependencies.workspace.setState({ error: message });
    }
  };

  const resume = async (input: {
    fork?: PiSessionFork;
    branch?: SessionRecord;
    sessionsByProject: Record<string, SessionRecord[]>;
  }): Promise<PiSessionExplorerResumeResult | undefined> => {
    const { fork, branch, sessionsByProject } = input;
    if (!fork || fork.status === "ready" || !branch) return undefined;
    try {
      let sessions = sessionsByProject[branch.projectId] ?? [];
      if (!sessions.some((session) => session.id === fork.sourceSessionId)) {
        sessions = await dependencies.listStoredSessions(branch.projectId);
      }
      const source = sessions.find(
        (session) => session.id === fork.sourceSessionId,
      );
      if (!source) throw new Error("找不到 Explorer 分支对应的源会话。");
      await dependencies.forkPiSession(
        source,
        branch,
        fork.anchorNativeEntryId,
      );
      const recovered = await dependencies.getPiSessionFork(branch.id);
      const relatedPiForks = await dependencies.listPiSessionForks(branch.id);
      dependencies.workspace.setState({ error: undefined });
      return { activePiFork: recovered, relatedPiForks };
    } catch (reason) {
      const activePiFork = await dependencies
        .getPiSessionFork(branch.id)
        .catch(() => undefined);
      dependencies.workspace.setState({
        error: dependencies.toUserMessage(reason, "恢复 Pi 探索分支失败。"),
      });
      return { activePiFork };
    }
  };

  const bringBack = async (input: {
    fork?: PiSessionFork;
    branch?: SessionRecord;
    entry: PiExplorerMessage;
    timeline: TimelineEntry[];
    sessionsByProject: Record<string, SessionRecord[]>;
  }): Promise<void> => {
    const { fork, branch, entry, timeline, sessionsByProject } = input;
    if (
      !fork ||
      fork.status !== "ready" ||
      !branch ||
      entry.role !== "assistant" ||
      entry.streaming ||
      !entry.content.trim()
    ) {
      return;
    }
    const anchorIndex = timeline.findIndex(
      (candidate) =>
        candidate.kind === "message" &&
        candidate.nativeEntryId === fork.anchorNativeEntryId,
    );
    const conclusionIndex = timeline.findIndex(
      (candidate) => candidate.kind === "message" && candidate.id === entry.id,
    );
    if (anchorIndex < 0 || conclusionIndex <= anchorIndex) return;

    let sessions = sessionsByProject[branch.projectId] ?? [];
    try {
      if (!sessions.some((session) => session.id === fork.sourceSessionId)) {
        sessions = await dependencies.listStoredSessions(branch.projectId);
      }
    } catch (reason) {
      dependencies.workspace.setState({
        error: dependencies.toUserMessage(reason, "读取 Explorer 源会话失败。"),
      });
      return;
    }
    const source = sessions.find(
      (session) => session.id === fork.sourceSessionId,
    );
    if (!source) {
      dependencies.workspace.setState({
        error: "找不到 Explorer 分支对应的源会话。",
      });
      return;
    }

    const nextDraft = appendExplorerSessionReferenceToDraft(
      dependencies.readComposerDraft(source.id),
      {
        sourceSessionId: source.id,
        branchSessionId: branch.id,
        anchorNativeEntryId: fork.anchorNativeEntryId,
      },
    );
    if (!nextDraft) return;
    if (!dependencies.writeComposerDraft(source.id, nextDraft)) {
      dependencies.workspace.setState({
        error: "无法保存源会话草稿，请检查本机存储空间。",
      });
      return;
    }
    await dependencies.selectSession(source);
  };

  return { load, explore, resume, bringBack };
};
