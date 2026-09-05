import type { AcpSessionPhase, AgentSubagent } from "@/domain/acp";

import type { WorkspaceMode } from "@/features/sessions/sidebar-types";

export const statusLabel = {
  stopped: "预览",
  starting: "正在启动",
  running: "已连接",
  missing: "未找到内置服务",
  failed: "连接错误",
} as const;

export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 420;
export const SIDEBAR_WIDTH_STORAGE_KEY = "melodywork.sidebar.width";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "melodywork.sidebar.collapsed";
export const DEFAULT_WORKSPACE_PANEL_WIDTH = 560;
export const MIN_WORKSPACE_PANEL_WIDTH = 360;
export const MAX_WORKSPACE_PANEL_WIDTH = 960;
export const WORKSPACE_PANEL_WIDTH_STORAGE_KEY =
  "melodywork.workspace-panel.width";
export const WORKSPACE_MODE_STORAGE_KEY = "melodywork.workspace-mode";
export const DEFAULT_CHAT_DOCK_SPACE = 168;
export const SESSION_INFO_MOTION_MS = 220;

export const isMacOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

const isAbsoluteWorkspacePath = (path: string) =>
  path.startsWith("/") || /^\\\\/u.test(path) || /^[A-Za-z]:[\\/]/u.test(path);

export const resolveWorkspacePath = (root: string, path: string) => {
  if (isAbsoluteWorkspacePath(path) || root === ".") {
    return path;
  }
  const separator = root.includes("\\") ? "\\" : "/";
  const normalizedRoot = root.replace(/[\\/]+$/u, "");
  const normalizedPath = path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replaceAll("/", separator);
  return `${normalizedRoot}${separator}${normalizedPath}`;
};

export const storedSidebarWidth = () => {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stored))
    : DEFAULT_SIDEBAR_WIDTH;
};

export const storedSidebarCollapsed = () =>
  typeof window !== "undefined" &&
  window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";

export const storedWorkspaceMode = (): WorkspaceMode =>
  typeof window !== "undefined" &&
  window.localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY) === "research"
    ? "research"
    : "work";

export const maxWorkspacePanelWidth = () =>
  typeof window === "undefined"
    ? MAX_WORKSPACE_PANEL_WIDTH
    : Math.max(
        MIN_WORKSPACE_PANEL_WIDTH,
        Math.min(MAX_WORKSPACE_PANEL_WIDTH, window.innerWidth * 0.65),
      );

export const storedWorkspacePanelWidth = () => {
  if (typeof window === "undefined") {
    return DEFAULT_WORKSPACE_PANEL_WIDTH;
  }
  const stored = Number(
    window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_STORAGE_KEY),
  );
  return Number.isFinite(stored)
    ? Math.min(
        maxWorkspacePanelWidth(),
        Math.max(MIN_WORKSPACE_PANEL_WIDTH, stored),
      )
    : Math.min(DEFAULT_WORKSPACE_PANEL_WIDTH, maxWorkspacePanelWidth());
};

export interface SessionNavigationHistory {
  entries: string[];
  index: number;
}

export const subagentsForSession = (
  subagents: Record<string, AgentSubagent>,
  rootSessionId?: string,
) => {
  if (!rootSessionId) {
    return [];
  }
  const descendants: AgentSubagent[] = [];
  const pending = [rootSessionId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const parentSessionId = pending.shift();
    if (!parentSessionId || visited.has(parentSessionId)) {
      continue;
    }
    visited.add(parentSessionId);
    for (const subagent of Object.values(subagents)) {
      if (subagent.parentSessionId === parentSessionId) {
        descendants.push(subagent);
        pending.push(subagent.childSessionId);
      }
    }
  }
  return descendants.sort(
    (left, right) =>
      Number(left.status !== "running") - Number(right.status !== "running") ||
      right.updatedAt - left.updatedAt,
  );
};

export const sessionStatusLabel = (
  agentPhase: keyof typeof statusLabel,
  sessionPhase: AcpSessionPhase,
) => {
  if (agentPhase !== "running") {
    return statusLabel[agentPhase];
  }
  if (
    sessionPhase === "initializing" ||
    sessionPhase === "authenticating" ||
    sessionPhase === "creating"
  ) {
    return "正在启动会话";
  }
  if (sessionPhase === "prompting") {
    return "处理中";
  }
  return sessionPhase === "ready" ? "已连接" : statusLabel.running;
};
