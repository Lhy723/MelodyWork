import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type { AcpEnvelope, AgentStatus } from "@/domain/acp";
import type {
  MelodyConfigDocument,
  MelodyConfigScope,
  MelodyExtension,
} from "@/domain/config";
import type {
  GitBranch,
  GitChange,
  GitDiff,
  GitWorktree,
} from "@/domain/git";
import type {
  PermissionDecision,
  PermissionRule,
} from "@/domain/permission";
import type {
  ProjectRecord,
  SessionRecord,
  TerminalExitEvent,
  TerminalOutputEvent,
  UpdateSessionRequest,
  WorkspaceEntry,
} from "@/domain/workspace";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface AppUpdateStatus {
  configured: boolean;
  available: boolean;
  version?: string;
  notes?: string;
  installed: boolean;
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const getAgentStatus = async (): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return {
      phase: "stopped",
      message: "Browser preview",
    };
  }
  return invoke<AgentStatus>("agent_status");
};

export const startAgent = async (cwd: string): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return {
      phase: "stopped",
      message: "Browser preview",
    };
  }
  return invoke<AgentStatus>("start_agent", {
    request: { cwd },
  });
};

export const stopAgent = async (): Promise<AgentStatus> =>
  invoke<AgentStatus>("stop_agent");

export const sendAcp = async (message: AcpEnvelope): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  return invoke("send_acp", { message });
};

export const getGitChanges = async (cwd: string): Promise<GitChange[]> => {
  if (!isTauriRuntime()) {
    return [
      {
        path: "src-tauri/src/agent_runtime.rs",
        status: " M",
        staged: false,
        additions: 48,
        deletions: 6,
      },
      {
        path: "src/stores/agent-store.ts",
        status: " M",
        staged: false,
        additions: 72,
        deletions: 21,
      },
      {
        path: "src/features/git/change-review.tsx",
        status: "??",
        staged: false,
        additions: 184,
        deletions: 0,
      },
    ];
  }
  return invoke<GitChange[]>("git_changes", { cwd });
};

export const getGitDiff = async (
  cwd: string,
  path: string,
): Promise<GitDiff> => {
  if (!isTauriRuntime()) {
    return {
      path,
      binary: false,
      content: [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -18,6 +18,10 @@",
        " export function AgentWorkspace() {",
        "+  const changes = useGitChanges();",
        "+  const [reviewOpen, setReviewOpen] = useState(false);",
        "+",
        "   useAgentBridge();",
        "-  const status = \"Preview\";",
        "+  const status = useAgentStore((state) => state.status);",
      ].join("\n"),
    };
  }
  return invoke<GitDiff>("git_diff", { cwd, path });
};

export const getGitBranches = async (cwd: string): Promise<GitBranch[]> =>
  isTauriRuntime()
    ? invoke<GitBranch[]>("git_branches", { cwd })
    : [
        { name: "main", current: true },
        { name: "feature/acp-bridge", current: false },
      ];

export const stageGitPaths = async (
  cwd: string,
  paths: string[],
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_stage", { cwd, paths });
  }
};

export const unstageGitPaths = async (
  cwd: string,
  paths: string[],
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_unstage", { cwd, paths });
  }
};

export const commitGitChanges = async (
  cwd: string,
  message: string,
): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("git_commit", { cwd, message })
    : `[main preview] ${message}`;

export const checkoutGitBranch = async (
  cwd: string,
  branch: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_checkout_branch", { cwd, branch });
  }
};

export const createGitBranch = async (
  cwd: string,
  branch: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_create_branch", { cwd, branch });
  }
};

export const getGitWorktrees = async (
  cwd: string,
): Promise<GitWorktree[]> =>
  isTauriRuntime()
    ? invoke<GitWorktree[]>("git_worktrees", { cwd })
    : [
        {
          path: cwd,
          branch: "main",
          head: "a1b2c3d",
          bare: false,
          detached: false,
        },
      ];

export const createGitWorktree = async (request: {
  cwd: string;
  path: string;
  branch: string;
  createBranch: boolean;
}): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_create_worktree", request);
  }
};

export const removeGitWorktree = async (
  cwd: string,
  path: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("git_remove_worktree", { cwd, path });
  }
};

export const subscribeToAcp = async (
  onMessage: (message: AcpEnvelope) => void,
  onStderr: (line: string) => void,
): Promise<UnlistenFn[]> => {
  if (!isTauriRuntime()) {
    return [];
  }

  const unlistenMessage = await listen<AcpEnvelope>(
    "melody://acp-message",
    (event) => onMessage(event.payload),
  );
  const unlistenStderr = await listen<string>(
    "melody://acp-stderr",
    (event) => onStderr(event.payload),
  );
  return [unlistenMessage, unlistenStderr];
};

const previewProject: ProjectRecord = {
  id: "preview-project",
  name: "MelodyWork",
  path: ".",
  lastOpenedAt: Math.floor(Date.now() / 1000),
};

const previewSessions: SessionRecord[] = [
  {
    id: "implement-acp-bridge",
    projectId: previewProject.id,
    title: "Implement ACP bridge",
    cwd: ".",
    timelineJson: "[]",
    createdAt: Math.floor(Date.now() / 1000) - 120,
    updatedAt: Math.floor(Date.now() / 1000),
  },
  {
    id: "settings-ui",
    projectId: previewProject.id,
    title: "Design settings editor",
    cwd: ".",
    timelineJson: "[]",
    createdAt: Math.floor(Date.now() / 1000) - 86_400,
    updatedAt: Math.floor(Date.now() / 1000) - 86_400,
  },
  {
    id: "git-worktree",
    projectId: previewProject.id,
    title: "Plan Git worktrees",
    cwd: ".",
    timelineJson: "[]",
    createdAt: Math.floor(Date.now() / 1000) - 172_800,
    updatedAt: Math.floor(Date.now() / 1000) - 172_800,
  },
];

export const listProjects = async (): Promise<ProjectRecord[]> =>
  isTauriRuntime()
    ? invoke<ProjectRecord[]>("list_projects")
    : [previewProject];

export const upsertProject = async (
  path: string,
): Promise<ProjectRecord> =>
  isTauriRuntime()
    ? invoke<ProjectRecord>("upsert_project", { path })
    : previewProject;

export const pickWorkspaceDirectory = async (): Promise<string | undefined> => {
  if (!isTauriRuntime()) {
    return undefined;
  }
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open workspace",
  });
  return typeof selected === "string" ? selected : undefined;
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
      title: "New session",
      cwd,
      timelineJson: "[]",
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
    return {
      ...(existing ?? previewSessions[0]),
      ...request,
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  return invoke<SessionRecord>("update_session", { request });
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

export const writeWorkspaceFile = async (
  root: string,
  path: string,
  content: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("write_workspace_file", { root, path, content });
  }
};

export const runTerminalCommand = async (
  cwd: string,
  command: string,
): Promise<string> => {
  if (!isTauriRuntime()) {
    return `preview-${Date.now()}`;
  }
  return invoke<string>("run_terminal_command", { cwd, command });
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

export const readMelodyConfig = async (
  scope: MelodyConfigScope,
  cwd: string,
): Promise<MelodyConfigDocument> => {
  if (!isTauriRuntime()) {
    return {
      scope,
      path:
        scope === "user"
          ? "~/.melody/config.toml"
          : `${cwd}/.melody/config.toml`,
      exists: scope === "user",
      content:
        scope === "user"
          ? '[agent]\nmodel = "default"\n\n[mcp_servers.filesystem]\ncommand = "mcp-server-filesystem"\n'
          : "# Project-specific Melody configuration\n",
    };
  }
  return invoke<MelodyConfigDocument>("read_melody_config", { scope, cwd });
};

export const writeMelodyConfig = async (
  scope: MelodyConfigScope,
  cwd: string,
  content: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("write_melody_config", { scope, cwd, content });
  }
};

export const listMelodyExtensions = async (
  cwd: string,
): Promise<MelodyExtension[]> =>
  isTauriRuntime()
    ? invoke<MelodyExtension[]>("list_melody_extensions", { cwd })
    : [
        {
          kind: "skills",
          name: "code-review",
          path: "~/.melody/skills/code-review",
          scope: "user",
        },
        {
          kind: "plugins",
          name: "git-tools",
          path: `${cwd}/.melody/plugins/git-tools`,
          scope: "project",
        },
        {
          kind: "hooks",
          name: "after-tool.sh",
          path: `${cwd}/.melody/hooks/after-tool.sh`,
          scope: "project",
        },
      ];

export const listPermissionRules = async (
  projectId: string,
): Promise<PermissionRule[]> =>
  isTauriRuntime()
    ? invoke<PermissionRule[]>("list_permission_rules", { projectId })
    : [];

export const findPermissionRule = async (
  projectId: string,
  toolKey: string,
): Promise<PermissionRule | undefined> =>
  isTauriRuntime()
    ? (await invoke<PermissionRule | null>("find_permission_rule", {
        projectId,
        toolKey,
      })) ?? undefined
    : undefined;

export const upsertPermissionRule = async (request: {
  projectId: string;
  toolKey: string;
  title: string;
  command: string;
  decision: PermissionDecision;
}): Promise<PermissionRule> =>
  isTauriRuntime()
    ? invoke<PermissionRule>("upsert_permission_rule", request)
    : {
        id: `preview-rule-${Date.now()}`,
        ...request,
        createdAt: Math.floor(Date.now() / 1000),
      };

export const deletePermissionRule = async (
  projectId: string,
  id: string,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("delete_permission_rule", { projectId, id });
  }
};

export const checkAppUpdate = async (
  install = false,
): Promise<AppUpdateStatus> =>
  isTauriRuntime()
    ? invoke<AppUpdateStatus>("check_app_update", { install })
    : {
        configured: false,
        available: false,
        installed: false,
      };
