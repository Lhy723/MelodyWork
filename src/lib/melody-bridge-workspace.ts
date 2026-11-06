import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  INDEPENDENT_PROJECT_ID,
  type ProjectRecord,
  type SessionRecord,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type UpdateSessionRequest,
  type WorkspaceEntry,
} from "@/domain/workspace";
import {
  buildPiMigrationReportForSession,
  type PiMigrationReport,
} from "@/domain/agent/session-migration";
import {
  buildPiSessionImportPlanForSession,
  type PiSessionImportPlan,
} from "@/domain/agent/pi-session-import";
import type { JsonObject } from "@/domain/agent/contract";
import type { ExplorerSessionReference } from "@/domain/agent/explorer-branch";
import type { PiSessionFork } from "@/domain/agent/pi-session-fork";
import type { AgentPermissionMode } from "@/domain/acp";
export { forkPiSession } from "./melody-bridge-pi-fork";
import {
  isTauriRuntime,
  sendPiAgentCommand,
  startPiWorker,
} from "./melody-bridge-runtime";

const previewProject: ProjectRecord = {
  id: "preview-project",
  name: "MelodyWork",
  path: ".",
  lastOpenedAt: Math.floor(Date.now() / 1000),
  archived: false,
  isIndependent: false,
};

const previewIndependentProject: ProjectRecord = {
  id: INDEPENDENT_PROJECT_ID,
  name: "任务",
  path: ".",
  lastOpenedAt: 0,
  archived: false,
  isIndependent: true,
};

const previewSessions: SessionRecord[] = [
  {
    id: "implement-acp-bridge",
    projectId: previewProject.id,
    title: "实现 ACP 连接",
    cwd: ".",
    timelineJson: "[]",
    timelineVersion: 0,
    createdAt: Math.floor(Date.now() / 1000) - 120,
    updatedAt: Math.floor(Date.now() / 1000),
  },
  {
    id: "settings-ui",
    projectId: previewProject.id,
    title: "设计设置编辑器",
    cwd: ".",
    timelineJson: "[]",
    timelineVersion: 0,
    createdAt: Math.floor(Date.now() / 1000) - 86_400,
    updatedAt: Math.floor(Date.now() / 1000) - 86_400,
  },
  {
    id: "git-worktree",
    projectId: previewProject.id,
    title: "规划 Git 工作树",
    cwd: ".",
    timelineJson: "[]",
    timelineVersion: 0,
    createdAt: Math.floor(Date.now() / 1000) - 172_800,
    updatedAt: Math.floor(Date.now() / 1000) - 172_800,
  },
];
const previewTimelineArchives = new Map<string, Map<number, string>>();
const previewProjects: ProjectRecord[] = [
  previewProject,
  previewIndependentProject,
];

const findPreviewProject = (id: string) =>
  previewProjects.find((project) => project.id === id);

export const listProjects = async (): Promise<ProjectRecord[]> =>
  isTauriRuntime()
    ? invoke<ProjectRecord[]>("list_projects")
    : previewProjects.map((project) => ({ ...project }));

export const upsertProject = async (path: string): Promise<ProjectRecord> =>
  isTauriRuntime()
    ? invoke<ProjectRecord>("upsert_project", { path })
    : { ...previewProject, archived: false };

export const archiveProject = async (id: string): Promise<ProjectRecord> => {
  if (isTauriRuntime()) {
    return invoke<ProjectRecord>("archive_project", { id });
  }
  const project = findPreviewProject(id);
  if (!project || project.isIndependent) {
    throw new Error("该项目不能归档。");
  }
  project.archived = true;
  return { ...project };
};

export const restoreProject = async (id: string): Promise<ProjectRecord> => {
  if (isTauriRuntime()) {
    return invoke<ProjectRecord>("restore_project", { id });
  }
  const project = findPreviewProject(id);
  if (!project || project.isIndependent) {
    throw new Error("该项目不能恢复。");
  }
  project.archived = false;
  return { ...project };
};

export const deleteProject = async (id: string): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("delete_project", { id });
    return;
  }
  const index = previewProjects.findIndex((project) => project.id === id);
  if (index < 0 || previewProjects[index]?.isIndependent) {
    throw new Error("该项目不能删除。");
  }
  previewProjects.splice(index, 1);
};

export const pickWorkspaceDirectory = async (): Promise<string | undefined> => {
  if (!isTauriRuntime()) {
    return undefined;
  }
  return invoke<string | undefined>("pick_workspace_directory");
};

export const listStoredSessions = async (
  projectId: string,
): Promise<SessionRecord[]> =>
  isTauriRuntime()
    ? invoke<SessionRecord[]>("list_sessions", { projectId })
    : previewSessions.filter((session) => session.projectId === projectId);

export const createStoredSession = async (
  projectId: string,
  cwd: string,
): Promise<SessionRecord> => {
  if (!isTauriRuntime()) {
    return {
      id: `preview-${Date.now()}`,
      projectId,
      title: "新会话",
      cwd,
      timelineJson: "[]",
      timelineVersion: 0,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  return invoke<SessionRecord>("create_session", { projectId, cwd });
};

export const getPiSessionFork = async (
  branchSessionId: string,
): Promise<PiSessionFork | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return (
    (await invoke<PiSessionFork | null>("get_pi_session_fork", {
      branchSessionId,
    })) ?? undefined
  );
};

export const listPiSessionForks = async (
  sessionId: string,
): Promise<PiSessionFork[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<PiSessionFork[]>("list_pi_session_forks", { sessionId });
};

export const readPiSessionForkReference = async (
  sourceSessionId: string,
  branchSessionId: string,
): Promise<ExplorerSessionReference> => {
  if (!isTauriRuntime()) {
    throw new Error(
      "Explorer session references are available only in the desktop app.",
    );
  }
  return invoke<ExplorerSessionReference>("read_pi_session_fork_reference", {
    sourceSessionId,
    branchSessionId,
  });
};

export const updateStoredSession = async (
  request: UpdateSessionRequest,
): Promise<SessionRecord> => {
  if (!isTauriRuntime()) {
    const existing = previewSessions.find(
      (session) => session.id === request.id,
    );
    if (request.timelineEntries?.length) {
      const archive =
        previewTimelineArchives.get(request.id) ?? new Map<number, string>();
      for (const entry of request.timelineEntries) {
        archive.set(entry.ordinal, entry.entryJson);
      }
      previewTimelineArchives.set(request.id, archive);
    }
    return {
      ...(existing ?? previewSessions[0]),
      ...request,
      acpCursor:
        request.acpCursor === null
          ? undefined
          : (request.acpCursor ?? existing?.acpCursor),
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  return invoke<SessionRecord>("update_session", { request });
};

export const readStoredSessionTimeline = async (
  id: string,
): Promise<string | undefined> => {
  if (isTauriRuntime()) {
    return (
      (await invoke<string | null>("read_session_timeline", { id })) ??
      undefined
    );
  }
  const archive = previewTimelineArchives.get(id);
  if (!archive || archive.size === 0) {
    return undefined;
  }
  return (
    "[" +
    [...archive.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, entryJson]) => entryJson)
      .join(",") +
    "]"
  );
};

/**
 * Produce a conservative, read-only Pi migration report for one persisted
 * session. The full Host archive is preferred when it is available; an archive
 * read failure is carried into the report as a blocker instead of silently
 * falling back to a potentially partial snapshot.
 */
export const getPiMigrationReportForSession = async (
  session: SessionRecord,
): Promise<PiMigrationReport> => {
  let timelineArchiveJson: string | undefined;
  let timelineArchiveReadFailed = false;
  try {
    timelineArchiveJson = await readStoredSessionTimeline(session.id);
  } catch {
    timelineArchiveReadFailed = true;
  }
  return buildPiMigrationReportForSession({
    id: session.id,
    ...(session.acpSessionId ? { acpSessionId: session.acpSessionId } : {}),
    ...(session.acpCursor ? { acpCursor: session.acpCursor } : {}),
    timelineJson: session.timelineJson,
    timelineVersion: session.timelineVersion,
    ...(timelineArchiveJson !== undefined ? { timelineArchiveJson } : {}),
    ...(timelineArchiveReadFailed ? { timelineArchiveReadFailed: true } : {}),
  });
};

/**
 * Produce a bounded, read-only ACP → Pi import plan. The plan contains only
 * converter-local records and source mappings; it never creates a Pi session,
 * changes an engine binding, or writes an archive.
 */
export const getPiSessionImportPlanForSession = async (
  session: SessionRecord,
): Promise<PiSessionImportPlan> => {
  let timelineArchiveJson: string | undefined;
  let timelineArchiveReadFailed = false;
  try {
    timelineArchiveJson = await readStoredSessionTimeline(session.id);
  } catch {
    timelineArchiveReadFailed = true;
  }
  return buildPiSessionImportPlanForSession({
    id: session.id,
    ...(session.acpSessionId ? { acpSessionId: session.acpSessionId } : {}),
    ...(session.acpCursor ? { acpCursor: session.acpCursor } : {}),
    timelineJson: session.timelineJson,
    timelineVersion: session.timelineVersion,
    ...(timelineArchiveJson !== undefined ? { timelineArchiveJson } : {}),
    ...(timelineArchiveReadFailed ? { timelineArchiveReadFailed: true } : {}),
  });
};

export interface PiMigrationJournalRecord {
  migrationId: string;
  sessionId: string;
  sourceEngine: "melody-acp";
  targetEngine: "pi";
  sourceDigest: string;
  converterVersion: string;
  stage: "planned" | "materializing" | "applied" | "failed" | "rolled-back";
  validationReport: JsonObject;
  plan: JsonObject;
  backupRequested: boolean;
  backupRef?: string | null;
  targetNativeSessionId?: string | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BeginPiMigrationInput {
  sessionId: string;
  sourceDigest: string;
  converterVersion: string;
  validationReport: JsonObject;
  plan: JsonObject;
  backup?: boolean;
}

/** Create or resume the Host-owned journal entry for one ACP → Pi attempt. */
export const beginPiMigration = async (
  request: BeginPiMigrationInput,
): Promise<PiMigrationJournalRecord> => {
  if (!isTauriRuntime()) {
    throw new Error("Pi 会话迁移日志仅在桌面运行时可用。 ");
  }
  return invoke<PiMigrationJournalRecord>("begin_pi_migration", { request });
};

export const listPiMigrationJournal = async (
  sessionId: string,
): Promise<PiMigrationJournalRecord[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<PiMigrationJournalRecord[]>("list_pi_migration_journal", {
    sessionId,
  });
};

/** Preserve a bounded failure reason so a later retry receives a new ID. */
export const failPiMigration = async (
  migrationId: string,
  sessionId: string,
  error: unknown,
): Promise<PiMigrationJournalRecord> => {
  if (!isTauriRuntime()) {
    throw new Error("Pi 会话迁移日志仅在桌面运行时可用。 ");
  }
  const message = error instanceof Error ? error.message : String(error);
  return invoke<PiMigrationJournalRecord>("fail_pi_migration", {
    request: { migrationId, sessionId, error: message.slice(0, 16_384) },
  });
};

/**
 * Execute the explicit ACP → Pi migration for a stored session. The planner
 * remains side-effect-free; this function is the one narrow, user-invoked
 * mutation that starts the Pi worker and asks it to materialize the validated
 * plan. Automatic session opening uses the same command, so this helper is
 * also useful to settings/recovery UI without duplicating conversion logic.
 */
export const migrateStoredSessionToPi = async (
  session: SessionRecord,
  options: {
    modelId?: string;
    reasoningEffort?: string;
    sessionModeId?: string;
    permissionMode?: AgentPermissionMode;
    backup?: boolean;
  } = {},
): Promise<PiSessionImportPlan> => {
  if (!isTauriRuntime()) {
    throw new Error("Pi 会话迁移仅在桌面运行时可用。 ");
  }
  const plan = await getPiSessionImportPlanForSession(session);
  if (plan.readiness === "blocked") {
    throw new Error(
      `该会话暂时不能迁移到 Pi：${plan.blockers[0] ?? "迁移计划未通过安全检查。"}`,
    );
  }
  const planValue = plan as unknown as JsonObject;
  const journal = await beginPiMigration({
    sessionId: session.id,
    sourceDigest: plan.sourceDigest,
    converterVersion: plan.converterVersion,
    validationReport: planValue,
    plan: planValue,
    backup: options.backup ?? true,
  });
  if (journal.stage === "applied") return plan;
  try {
    await startPiWorker(session.cwd);
    await sendPiAgentCommand({
      protocolVersion: 1,
      requestId: `pi-migrate-${session.id}-${Date.now()}`,
      sessionId: session.id,
      command: {
        type: "session.import",
        sessionId: session.id,
        migrationId: journal.migrationId,
        cwd: session.cwd,
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        ...(options.sessionModeId
          ? { sessionModeId: options.sessionModeId }
          : {}),
        ...(options.permissionMode
          ? { permissionMode: options.permissionMode }
          : {}),
        plan: planValue,
        // The journal is authoritative on retries.  Never let a caller
        // replace an active attempt's backup choice after it has been
        // materialized, otherwise the worker could overwrite native JSONL
        // without the recovery copy recorded by the Host.
        backup: journal.backupRequested,
      },
    });
  } catch (error) {
    try {
      await failPiMigration(journal.migrationId, session.id, error);
    } catch {
      // Keep the original worker error; the Host journal remains inspectable.
    }
    throw error;
  }
  return plan;
};

export const deleteStoredSession = async (id: string): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("delete_session", { id });
    return;
  }
  previewTimelineArchives.delete(id);
};

export const getWorkspaceTree = async (
  root: string,
): Promise<WorkspaceEntry[]> => {
  if (!isTauriRuntime()) {
    return [
      { path: "src", name: "src", isDirectory: true, depth: 0 },
      {
        path: "src/features",
        name: "features",
        isDirectory: true,
        depth: 1,
      },
      {
        path: "src/features/chat",
        name: "chat",
        isDirectory: true,
        depth: 2,
      },
      {
        path: "src/features/chat/agent-workspace.tsx",
        name: "agent-workspace.tsx",
        isDirectory: false,
        depth: 3,
      },
      {
        path: "src/stores/agent-store.ts",
        name: "agent-store.ts",
        isDirectory: false,
        depth: 1,
      },
      {
        path: "src-tauri",
        name: "src-tauri",
        isDirectory: true,
        depth: 0,
      },
      {
        path: "src-tauri/src/agent_runtime.rs",
        name: "agent_runtime.rs",
        isDirectory: false,
        depth: 1,
      },
    ];
  }
  return invoke<WorkspaceEntry[]>("workspace_tree", { root });
};

export const readWorkspaceFile = async (
  root: string,
  path: string,
): Promise<string> => {
  if (!isTauriRuntime()) {
    return `// Browser preview: ${path}\n\nexport const workspace = \"${root}\";\n`;
  }
  return invoke<string>("read_workspace_file", { root, path });
};

export const readWorkspaceBinaryFile = async (
  root: string,
  path: string,
): Promise<ArrayBuffer> => {
  if (!isTauriRuntime()) {
    const bytes = new TextEncoder().encode(`Browser preview: ${root}/${path}`);
    return bytes.buffer as ArrayBuffer;
  }
  return invoke<ArrayBuffer>("read_workspace_binary_file", { root, path });
};

export const writeWorkspaceFile = async (
  root: string,
  path: string,
  content: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("write_workspace_file", { root, path, content });
  }
};

export const createTerminalSession = async (cwd: string): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("create_terminal_session", { cwd })
    : `preview-terminal-${Date.now()}`;

export const writeTerminalInput = async (
  terminalId: string,
  data: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("write_terminal_input", { terminalId, data });
  }
};

export const resizeTerminalSession = async (
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("resize_terminal_session", { terminalId, cols, rows });
  }
};

export const closeTerminalSession = async (
  terminalId: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("close_terminal_session", { terminalId });
  }
};

export const subscribeToTerminal = async (
  onOutput: (event: TerminalOutputEvent) => void,
  onExit: (event: TerminalExitEvent) => void,
): Promise<UnlistenFn[]> => {
  if (!isTauriRuntime()) {
    return [];
  }
  return Promise.all([
    listen<TerminalOutputEvent>("melody://terminal-output", (event) =>
      onOutput(event.payload),
    ),
    listen<TerminalExitEvent>("melody://terminal-exit", (event) =>
      onExit(event.payload),
    ),
  ]);
};
