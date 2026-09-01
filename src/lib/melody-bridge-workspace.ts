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
import { isTauriRuntime } from "./melody-bridge-runtime";

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
    return new TextEncoder().encode(`Browser preview: ${root}/${path}`).buffer;
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
