import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { AcpEnvelope, AgentStatus } from "@/domain/acp";
import type {
  MelodyConfigDocument,
  MelodyConfigPatch,
  MelodyConfigScope,
  MelodyConfigValue,
  MelodyExtension,
  MarketplaceSource,
  MarketplacePlugin,
  PluginDetails,
  SkillDetails,
} from "@/domain/config";
import type { GitBranch, GitChange, GitDiff, GitWorktree } from "@/domain/git";
import type { PermissionDecision, PermissionRule } from "@/domain/permission";
import type { UsageStatistics } from "@/domain/statistics";
import type {
  ProjectRecord,
  SessionRecord,
  TerminalExitEvent,
  TerminalOutputEvent,
  UpdateSessionRequest,
  WorkspaceEntry,
} from "@/domain/workspace";
import {
  PREVIEW_AGENT_MESSAGE,
  PREVIEW_FIXTURE_VERSION,
  PREVIEW_GIT_CHANGES,
  previewGitDiff,
} from "@/lib/preview-fixtures";

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

interface ResearchHttpResponse {
  body: string;
  contentType?: string;
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const getUsageStatistics = async (): Promise<UsageStatistics> => {
  if (!isTauriRuntime()) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      totalTokens: 0,
      peakTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      reasoningTokens: 0,
      modelCalls: 0,
      apiDurationMs: 0,
      usageIncompleteTasks: 0,
      longestTaskMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      totalTasks: 0,
      quickModeTasks: 0,
      activity: [],
      reasoningEfforts: [],
      plugins: [],
      usedSkills: 0,
    };
  }
  return invoke<UsageStatistics>("get_usage_statistics");
};

export const openExternalUrl = async (candidate: string): Promise<void> => {
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持打开 HTTP 或 HTTPS 链接。");
  }
  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }
  const externalWindow = window.open(url, "_blank", "noopener,noreferrer");
  if (!externalWindow) {
    throw new Error("浏览器阻止了打开外部链接。");
  }
};

export const fetchResearchResource = async (
  url: string,
  accept?: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (!isTauriRuntime()) {
    const response = await fetch(url, {
      headers: accept ? { Accept: accept } : undefined,
      signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
  }
  const response = await invoke<ResearchHttpResponse>(
    "fetch_research_resource",
    { accept, url },
  );
  return response.body;
};

export const getAgentStatus = async (): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return {
      phase: "stopped",
      message: "浏览器预览",
    };
  }
  return invoke<AgentStatus>("agent_status");
};

export const startAgent = async (cwd: string): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return {
      phase: "stopped",
      message: "浏览器预览",
    };
  }
  return invoke<AgentStatus>("start_agent", {
    request: { cwd },
  });
};

export const stopAgent = async (): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return { phase: "stopped", message: "浏览器预览" };
  }
  return invoke<AgentStatus>("stop_agent");
};

type PreviewAcpListener = (message: AcpEnvelope) => void;
const previewAcpListeners = new Set<PreviewAcpListener>();
const previewAcpStderrListeners = new Set<(line: string) => void>();
let previewSequence = 0;

const emitPreviewAcp = (message: AcpEnvelope, delay = 0) => {
  window.setTimeout(() => {
    for (const listener of previewAcpListeners) {
      listener(message);
    }
  }, delay);
};

const dispatchPreviewAcp = (message: AcpEnvelope) => {
  const method = message.method;
  const params = message.params ?? {};
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : undefined;
  const requestMeta =
    params._meta !== null && typeof params._meta === "object"
      ? (params._meta as Record<string, unknown>)
      : undefined;
  const promptId =
    typeof requestMeta?.promptId === "string"
      ? requestMeta.promptId
      : undefined;
  const fixtureMeta = { fixtureVersion: PREVIEW_FIXTURE_VERSION };
  if (method === "initialize") {
    emitPreviewAcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        _meta: {
          ...fixtureMeta,
          modelState: {
            currentModelId: "grok-4.5",
            availableModels: [
              {
                modelId: "grok-4.5",
                name: "Grok 4.5",
                _meta: {
                  totalContextTokens: 128_000,
                  supportsReasoningEffort: true,
                },
              },
            ],
          },
        },
      },
    });
    return;
  }
  if (method === "authenticate") {
    emitPreviewAcp({ jsonrpc: "2.0", id: message.id, result: fixtureMeta });
    return;
  }
  if (method === "session/new" || method === "session/load") {
    const nextSessionId =
      typeof params.sessionId === "string"
        ? params.sessionId
        : `preview-acp-${++previewSequence}`;
    emitPreviewAcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: nextSessionId,
        _meta: fixtureMeta,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "标准" },
            { id: "fast", name: "快速", description: "降低延迟的预览模式" },
          ],
        },
      },
    });
    return;
  }
  if (method === "session/prompt" && sessionId) {
    const eventPrefix = `preview-${++previewSequence}`;
    emitPreviewAcp(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: PREVIEW_AGENT_MESSAGE },
          },
          _meta: {
            ...fixtureMeta,
            eventId: `${eventPrefix}-chunk`,
            ...(promptId ? { promptId } : {}),
          },
        },
      },
      20,
    );
    emitPreviewAcp(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "turn_completed",
            stopReason: "end_turn",
            usage: {
              inputTokens: 24,
              outputTokens: 18,
              modelCalls: 1,
              apiDurationMs: 18,
            },
          },
          _meta: {
            ...fixtureMeta,
            eventId: `${eventPrefix}-complete`,
            ...(promptId ? { promptId } : {}),
          },
        },
      },
      40,
    );
    // ACP may acknowledge session/prompt before the turn emits its final
    // session/update. Keep this ordering aligned with the desktop runtime.
    emitPreviewAcp(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          _meta: {
            ...fixtureMeta,
            ...(promptId ? { promptId } : {}),
            usage: {
              inputTokens: 24,
              outputTokens: 18,
              cachedReadTokens: 0,
              reasoningTokens: 0,
              modelCalls: 1,
              apiDurationMs: 18,
              usageIsIncomplete: false,
              costIsPartial: true,
            },
          },
        },
      },
      10,
    );
    return;
  }
  if (method === "session/cancel" && sessionId) {
    return;
  }
  if (method === "session/set_model" || method === "session/set_mode") {
    emitPreviewAcp({ jsonrpc: "2.0", id: message.id, result: fixtureMeta });
  }
};

export const sendAcp = async (message: AcpEnvelope): Promise<void> => {
  if (!isTauriRuntime()) {
    dispatchPreviewAcp(message);
    return;
  }
  return invoke("send_acp", { message });
};

export const getGitChanges = async (cwd: string): Promise<GitChange[]> => {
  if (!isTauriRuntime()) {
    return PREVIEW_GIT_CHANGES.map((change) => ({ ...change }));
  }
  return invoke<GitChange[]>("git_changes", { cwd });
};

export const getGitDiff = async (
  cwd: string,
  path: string,
): Promise<GitDiff> => {
  if (!isTauriRuntime()) {
    return previewGitDiff(path);
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

export const getGitWorktrees = async (cwd: string): Promise<GitWorktree[]> =>
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
  onStatus?: (status: AgentStatus) => void,
): Promise<UnlistenFn[]> => {
  if (!isTauriRuntime()) {
    const onMessageListener: PreviewAcpListener = onMessage;
    const onStderrListener = onStderr;
    previewAcpListeners.add(onMessageListener);
    previewAcpStderrListeners.add(onStderrListener);
    return [
      () => previewAcpListeners.delete(onMessageListener),
      () => previewAcpStderrListeners.delete(onStderrListener),
    ];
  }

  const unlistenMessage = await listen<AcpEnvelope>(
    "melody://acp-message",
    (event) => onMessage(event.payload),
  );
  const unlistenStderr = await listen<string>("melody://acp-stderr", (event) =>
    onStderr(event.payload),
  );
  const unlistenStatus = onStatus
    ? await listen<AgentStatus>("melody://agent-status", (event) =>
        onStatus(event.payload),
      )
    : undefined;
  return [
    unlistenMessage,
    unlistenStderr,
    ...(unlistenStatus ? [unlistenStatus] : []),
  ];
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

export const listProjects = async (): Promise<ProjectRecord[]> =>
  isTauriRuntime()
    ? invoke<ProjectRecord[]>("list_projects")
    : [previewProject];

export const upsertProject = async (path: string): Promise<ProjectRecord> =>
  isTauriRuntime()
    ? invoke<ProjectRecord>("upsert_project", { path })
    : previewProject;

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
          ? '[models]\ndefault = "grok-4.5"\n\n[mcp_servers.filesystem]\ncommand = "mcp-server-filesystem"\n'
          : "# Project-specific Melody configuration\n",
      values:
        scope === "user"
          ? {
              models: { default: "grok-4.5" },
              mcp_servers: {
                filesystem: { command: "mcp-server-filesystem" },
              },
            }
          : {},
    };
  }
  return invoke<MelodyConfigDocument>("read_melody_config", { scope, cwd });
};

const applyPreviewPatch = (
  target: Record<string, MelodyConfigValue>,
  patch: MelodyConfigPatch,
) => {
  const [leaf] = patch.path.slice(-1);
  if (!leaf) {
    return;
  }
  let table = target;
  for (const key of patch.path.slice(0, -1)) {
    const current = table[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      table[key] = {};
    }
    table = table[key] as Record<string, MelodyConfigValue>;
  }
  if (patch.value === null) {
    delete table[leaf];
  } else {
    table[leaf] = patch.value;
  }
};

export const updateMelodyConfig = async (
  scope: MelodyConfigScope,
  cwd: string,
  patches: MelodyConfigPatch[],
): Promise<MelodyConfigDocument> => {
  if (isTauriRuntime()) {
    return invoke<MelodyConfigDocument>("update_melody_config", {
      scope,
      cwd,
      patches,
    });
  }
  const document = await readMelodyConfig(scope, cwd);
  const values = structuredClone(document.values);
  patches.forEach((patch) => applyPreviewPatch(values, patch));
  return { ...document, exists: true, values };
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
          provider: "melody",
          managed: false,
          enabled: true,
        },
        {
          kind: "plugins",
          name: "git-tools",
          path: `${cwd}/.melody/plugins/git-tools`,
          scope: "project",
          provider: "melody",
          managed: false,
          enabled: true,
        },
        {
          kind: "hooks",
          name: "after-tool.sh",
          path: `${cwd}/.melody/hooks/after-tool.sh`,
          scope: "project",
          provider: "melody",
          managed: false,
          enabled: true,
        },
      ];

export const listMelodySkills = async (
  cwd: string,
): Promise<MelodyExtension[]> =>
  isTauriRuntime()
    ? invoke<MelodyExtension[]>("list_melody_skills", { cwd })
    : [
        {
          kind: "skills",
          name: "code-review",
          description: "检查代码质量、风险与测试覆盖。",
          path: "~/.melody/skills/code-review",
          scope: "user",
          provider: "melody",
          source: "user",
          managed: false,
          enabled: true,
          userInvocable: true,
          deletable: true,
        },
        {
          kind: "skills",
          name: "ai-elements",
          description: "构建 AI 对话界面和工具调用体验。",
          path: "~/.agents/skills/ai-elements",
          scope: "user",
          provider: "agents",
          source: "user",
          managed: false,
          enabled: true,
          userInvocable: true,
          deletable: false,
        },
        {
          kind: "skills",
          name: "swiftui-patterns",
          description: "使用成熟的 SwiftUI 模式构建 macOS 界面。",
          path: "~/.claude/skills/swiftui-patterns",
          scope: "user",
          provider: "claude",
          source: "user",
          managed: false,
          enabled: false,
          compatibilityStatus: "disabled",
          userInvocable: true,
          deletable: false,
        },
        {
          kind: "skills",
          name: "mattpocock-skills:implement",
          description: "按照既定方案实现经过验证的代码变更。",
          path: "~/.melody/installed-plugins/mattpocock-skills/skills/implement",
          scope: "user",
          provider: "plugin",
          source: "plugin",
          pluginName: "mattpocock-skills",
          managed: true,
          enabled: true,
          userInvocable: true,
          deletable: false,
        },
      ];

export const listMarketplaceSources = async (): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("list_marketplace_sources")
    : [
        {
          name: "xAI Official",
          kind: "git",
          location: "https://github.com/melody-org/plugin-marketplace.git",
        },
      ];

export const addMarketplaceSource = async (
  input: string,
): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("add_marketplace_source", { input })
    : [
        {
          name:
            input
              .split("/")
              .at(-1)
              ?.replace(/\.git$/, "") || "plugins",
          kind:
            input.startsWith(".") || input.startsWith("/") ? "local" : "git",
          location: input,
        },
      ];

export const saveMarketplaceSource = async (
  originalName: string | undefined,
  source: MarketplaceSource,
): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("save_marketplace_source", {
        originalName,
        source,
      })
    : [source];

export const deleteMarketplaceSource = async (
  name: string,
): Promise<MarketplaceSource[]> =>
  isTauriRuntime()
    ? invoke<MarketplaceSource[]>("delete_marketplace_source", { name })
    : [];

export interface PluginInstallResult {
  source: string;
  message: string;
}

export const installMelodyPlugin = async (
  cwd: string,
  source: string,
): Promise<PluginInstallResult> =>
  isTauriRuntime()
    ? invoke<PluginInstallResult>("install_melody_plugin", { cwd, source })
    : {
        source,
        message: `已从 ${source} 安装插件。`,
      };

export const scanMarketplacePlugins = async (
  cwd: string,
  refresh = false,
): Promise<MarketplacePlugin[]> =>
  isTauriRuntime()
    ? invoke<MarketplacePlugin[]>("scan_marketplace_plugins", {
        cwd,
        refresh,
      })
    : [
        {
          name: "code-review",
          marketplace: "xAI Official",
          status: "installed",
          installedVersion: "1.2.0",
          skillCount: 1,
          hasHooks: false,
          hasAgents: true,
          hasMcp: false,
        },
        {
          name: "web-tools",
          marketplace: "xAI Official",
          status: "available",
          version: "0.8.1",
          description: "网页搜索与内容提取工具。",
          skillCount: 2,
          hasHooks: false,
          hasAgents: false,
          hasMcp: true,
        },
      ];

export const updateMelodyPlugin = async (
  cwd: string,
  name: string,
): Promise<PluginInstallResult> =>
  isTauriRuntime()
    ? invoke<PluginInstallResult>("update_melody_plugin", { cwd, name })
    : {
        source: name,
        message: `${name} 已是最新版本。`,
      };

export const listInstalledMelodyPlugins = async (
  cwd: string,
): Promise<MelodyExtension[]> =>
  isTauriRuntime()
    ? invoke<MelodyExtension[]>("list_installed_melody_plugins", { cwd })
    : [];

export const setMelodyExtensionEnabled = async (
  cwd: string,
  extension: MelodyExtension,
  enabled: boolean,
): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("set_melody_extension_enabled", {
    scope: extension.scope,
    cwd,
    kind: extension.kind,
    name: extension.name,
    enabled,
  });
};

export const uninstallMelodyPlugin = async (
  cwd: string,
  name: string,
  keepData = false,
): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("uninstall_melody_plugin", { cwd, name, keepData })
    : `已删除插件 ${name}。`;

export const getMelodyPluginDetails = async (
  cwd: string,
  plugin: MelodyExtension,
): Promise<PluginDetails> =>
  isTauriRuntime()
    ? invoke<PluginDetails>("get_melody_plugin_details", {
        cwd,
        name: plugin.name,
        path: plugin.path,
      })
    : {
        name: plugin.name,
        version: "1.0.0",
        description: "为 Melody 提供额外的开发能力。",
        path: plugin.path,
        manifestPath: `${plugin.path}/plugin.json`,
        components: [
          { kind: "skills", items: ["code-review"] },
          { kind: "commands", items: ["review"] },
          { kind: "agents", items: ["reviewer"] },
          { kind: "hooks", items: ["PreToolUse"] },
          { kind: "mcps", items: ["github"] },
          { kind: "lsps", items: [] },
        ],
      };

export const getMelodySkillDetails = async (
  cwd: string,
  skill: MelodyExtension,
): Promise<SkillDetails> =>
  isTauriRuntime()
    ? invoke<SkillDetails>("get_melody_skill_details", {
        cwd,
        name: skill.name,
        path: skill.path,
      })
    : {
        name: skill.name,
        description:
          skill.description ?? "查看技能说明、包含的文件和安装位置。",
        license: "MIT",
        compatibility: "Melody 0.0.1+",
        path: skill.path,
        skillPath: `${skill.path}/SKILL.md`,
        files: ["SKILL.md", "references/checklist.md"],
        content: `---\nname: ${skill.name}\ndescription: ${
          skill.description ?? "查看技能说明、包含的文件和安装位置。"
        }\n---\n\n# ${skill.name}\n\n这是浏览器预览中的技能详情。`,
      };

export const deleteMelodySkill = async (
  cwd: string,
  skill: MelodyExtension,
): Promise<string> =>
  isTauriRuntime()
    ? invoke<string>("delete_melody_skill", {
        cwd,
        name: skill.name,
        path: skill.path,
      })
    : `已删除技能 ${skill.name}。`;

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
    ? ((await invoke<PermissionRule | null>("find_permission_rule", {
        projectId,
        toolKey,
      })) ?? undefined)
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
