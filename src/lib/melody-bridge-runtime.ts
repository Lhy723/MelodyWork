import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import type { AcpEnvelope, AgentStatus } from "@/domain/acp";
import type { UsageStatistics } from "@/domain/statistics";
import type { FileOpener, UpdateChannel } from "@/stores/app-settings-store";
import { PREVIEW_AGENT_MESSAGE, PREVIEW_FIXTURE_VERSION } from "@/lib/preview-fixtures";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface AppUpdateStatus {
  channel: UpdateChannel;
  configured: boolean;
  available: boolean;
  version?: string;
  notes?: string;
  installed: boolean;
}

export interface AppReleaseHistoryItem {
  tagName: string;
  name: string;
  body?: string;
  publishedAt?: string;
  isPrerelease: boolean;
  url: string;
}

export interface EnvironmentCapability {
  name: string;
  version?: string;
  installed: boolean;
  description: string;
}

export interface FileOpenerAvailability {
  id: FileOpener;
  installed: boolean;
}

interface ResearchHttpResponse {
  body: string;
  contentType?: string;
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isMacOSRuntime = () =>
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X/u.test(navigator.userAgent);

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

const preferredEditorCommand = (target: FileOpener) => {
  if (target === "system") {
    return undefined;
  }
  const macOS = isMacOSRuntime();
  if (target === "vscode") {
    return macOS ? "Visual Studio Code" : "code";
  }
  return macOS ? "Cursor" : "cursor";
};

/**
 * Opens a local file with the configured desktop application.
 *
 * The browser preview cannot access local paths, and a missing editor should
 * not prevent the caller from falling back to MelodyWork's own file preview.
 */
export const openFileWithPreferredApp = async (
  path: string,
  target: FileOpener,
): Promise<boolean> => {
  if (!isTauriRuntime()) {
    return false;
  }
  try {
    const application = preferredEditorCommand(target);
    if (application) {
      await openPath(path, application);
    } else {
      await openPath(path);
    }
    return true;
  } catch {
    return false;
  }
};

const APP_RELEASES_URL =
  "https://api.github.com/repos/Lhy723/MelodyWork/releases?per_page=12";

export const getAppReleaseHistory = async (): Promise<
  AppReleaseHistoryItem[]
> => {
  const response = await fetch(APP_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases 请求失败（${response.status}）。`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("GitHub Releases 返回了无法识别的数据。");
  }
  return payload.flatMap((item): AppReleaseHistoryItem[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const release = item as Record<string, unknown>;
    const tagName =
      typeof release.tag_name === "string" ? release.tag_name : "";
    const htmlUrl =
      typeof release.html_url === "string" ? release.html_url : "";
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName) || !htmlUrl) {
      return [];
    }
    return [
      {
        tagName,
        name:
          typeof release.name === "string" && release.name.trim()
            ? release.name
            : tagName,
        body: typeof release.body === "string" ? release.body : undefined,
        publishedAt:
          typeof release.published_at === "string"
            ? release.published_at
            : undefined,
        isPrerelease: release.prerelease === true,
        url: htmlUrl,
      },
    ];
  });
};

export const getEnvironmentCapabilities = async (): Promise<
  EnvironmentCapability[]
> =>
  isTauriRuntime()
    ? invoke<EnvironmentCapability[]>("get_environment_capabilities")
    : [];

export const getFileOpenerAvailability = async (): Promise<
  FileOpenerAvailability[]
> => {
  if (!isTauriRuntime()) {
    return [
      { id: "system", installed: true },
      { id: "vscode", installed: false },
      { id: "cursor", installed: false },
    ];
  }
  const payload = await invoke<unknown>("get_file_opener_availability");
  if (!Array.isArray(payload)) {
    throw new Error("文件打开应用检测返回了无法识别的数据。");
  }
  const validIds: FileOpener[] = ["system", "vscode", "cursor"];
  const byId = new Map<FileOpener, FileOpenerAvailability>();
  for (const item of payload) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const id = candidate.id;
    if (
      typeof id !== "string" ||
      !validIds.includes(id as FileOpener) ||
      typeof candidate.installed !== "boolean"
    ) {
      continue;
    }
    byId.set(id as FileOpener, {
      id: id as FileOpener,
      installed: candidate.installed,
    });
  }
  return validIds.map(
    (id) => byId.get(id) ?? { id, installed: id === "system" },
  );
};

export const setMenuBarVisibility = async (visible: boolean): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("set_menu_bar_visibility", { visible });
  }
};

export const setSystemSleepPrevention = async (
  enabled: boolean,
): Promise<void> => {
  if (isTauriRuntime()) {
    await invoke("set_system_sleep_prevention", { enabled });
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

export const checkAppUpdate = async (
  channel: UpdateChannel = "stable",
  install = false,
): Promise<AppUpdateStatus> =>
  isTauriRuntime()
    ? invoke<AppUpdateStatus>("check_app_update", { channel, install })
    : {
        channel,
        configured: false,
        available: false,
        installed: false,
      };
