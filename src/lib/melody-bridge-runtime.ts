import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import type { AgentStatus } from "@/domain/acp";
import type {
  AgentCommandEnvelope,
  AgentEventEnvelope,
} from "@/domain/agent/contract";
import {
  parsePiModelCatalogEvent,
  type PiModelCatalogSnapshot,
} from "@/domain/agent/model-catalog";
import {
  projectPiModelCatalog,
  type PiModelOptionsProjection,
} from "@/domain/agent/pi-model-options";
import {
  parseAgentEventLogRecord,
  type AgentEventLogRecord,
} from "@/domain/agent/event-log";
import {
  emptyPiRecoveryPlan,
  parsePiRecoveryPlan,
  type PiRecoveryPlan,
} from "@/domain/agent/recovery";
import type { UsageStatistics } from "@/domain/statistics";
import type { FileOpener, UpdateChannel } from "@/stores/app-settings-store";
import { isTauriRuntime } from "./melody-bridge-runtime-context";

export { isTauriRuntime };
export { sendAcp, subscribeToAcp } from "./melody-bridge-acp";

export interface AppUpdateStatus {
  channel: UpdateChannel;
  configured: boolean;
  available: boolean;
  version?: string;
  notes?: string;
  installed: boolean;
}

export type AppUpdateProgressPhase = "downloading" | "installing";

export interface AppUpdateProgress {
  phase: AppUpdateProgressPhase;
  downloadedBytes: number;
  totalBytes: number | null;
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
const PI_AGENT_EVENT = "melody://pi-agent-event";

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

/**
 * Pi worker bridge used by Desktop Agent sessions. Browser preview reports a
 * stopped worker and uses its local ACP fixture through a separate adapter.
 */
export const getPiWorkerStatus = async (): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return { phase: "stopped", message: "浏览器预览" };
  }
  return invoke<AgentStatus>("pi_worker_status");
};

export const startPiWorker = async (cwd: string): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return { phase: "stopped", message: "浏览器预览" };
  }
  return invoke<AgentStatus>("start_pi_worker", {
    request: { cwd },
  });
};

export const sendPiAgentCommand = async (
  command: AgentCommandEnvelope,
): Promise<void> => {
  if (!isTauriRuntime()) {
    throw new Error("Pi worker 仅在桌面运行时可用。");
  }
  await invoke("send_pi_agent_command", { command });
};

/**
 * Request a correlated, validated Pi model snapshot. The listener is
 * installed before sending the command so a fast worker cannot race the
 * response; unrelated session events remain invisible to this helper.
 */
export const requestPiModelCatalog = async (
  refresh = false,
  timeoutMs = 10_000,
  sessionId?: string,
): Promise<PiModelCatalogSnapshot> => {
  if (!isTauriRuntime()) {
    return { revision: 0, models: [] };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Pi 模型目录请求超时必须是正整数。 ");
  }
  const requestId = `pi-models-${crypto.randomUUID()}`;
  let resolveResponse!: (snapshot: PiModelCatalogSnapshot) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<PiModelCatalogSnapshot>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const unlisten = await listen<unknown>(PI_AGENT_EVENT, ({ payload }) => {
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      (payload as { requestId?: unknown }).requestId !== requestId
    ) {
      return;
    }
    const event = (payload as { event?: unknown }).event;
    if (
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type === "runtime.error"
    ) {
      const error = (event as { error?: unknown }).error;
      const message =
        error !== null &&
        typeof error === "object" &&
        !Array.isArray(error) &&
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "Pi 模型目录请求失败。";
      rejectResponse(new Error(message));
      return;
    }
    try {
      const snapshot = parsePiModelCatalogEvent(payload, requestId);
      if (snapshot) resolveResponse(snapshot);
    } catch (error) {
      rejectResponse(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const timeout = globalThis.setTimeout(
    () => rejectResponse(new Error("Pi 模型目录请求超时。")),
    timeoutMs,
  );
  try {
    await sendPiAgentCommand({
      protocolVersion: 1,
      requestId,
      ...(sessionId ? { sessionId } : {}),
      command: {
        type: "runtime.models.list",
        ...(sessionId ? { sessionId } : {}),
        refresh,
      },
    });
    return await response;
  } finally {
    globalThis.clearTimeout(timeout);
    unlisten();
  }
};

/**
 * Product-facing model request. Keep the wire snapshot available for
 * diagnostics, but expose a ready-to-consume picker projection as the normal
 * integration point for future Pi settings/session stores.
 */
export const requestPiModelOptions = async (
  refresh = false,
  timeoutMs = 10_000,
): Promise<PiModelOptionsProjection> =>
  projectPiModelCatalog(await requestPiModelCatalog(refresh, timeoutMs));

/**
 * The logical Melody session id is stable across engine restarts while Pi's
 * native session id is an implementation detail of one worker process.  The
 * host persists that mapping so an eventual Pi adapter can resume without
 * making the renderer own worker lifecycle state.
 */
export interface PiAgentSessionBinding {
  sessionId: string;
  engine: "melody-acp" | "pi";
  nativeSessionId?: string | null;
  workerEpoch?: string | null;
  lastSeq?: number | null;
  sessionModeId?: string | null;
  permissionMode?: "ask" | "auto" | "always-approve" | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
  updatedAt: number;
}

export interface UpsertPiAgentSessionBindingInput {
  sessionId: string;
  engine: "melody-acp" | "pi";
  nativeSessionId?: string | null;
  workerEpoch?: string | null;
  lastSeq?: number | null;
  sessionModeId?: string | null;
  permissionMode?: "ask" | "auto" | "always-approve" | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
}

/** One Host-committed normalized Pi event, kept separate from the UI timeline. */
export const getPiAgentSessionBinding = async (
  sessionId: string,
): Promise<PiAgentSessionBinding | undefined> => {
  if (!isTauriRuntime()) {
    return undefined;
  }
  return (
    (await invoke<PiAgentSessionBinding | null>("get_agent_session_binding", {
      sessionId,
    })) ?? undefined
  );
};

export const upsertPiAgentSessionBinding = async (
  request: UpsertPiAgentSessionBindingInput,
): Promise<PiAgentSessionBinding> => {
  if (!isTauriRuntime()) {
    throw new Error("Pi 会话绑定仅在桌面运行时可用。");
  }
  return invoke<PiAgentSessionBinding>("upsert_agent_session_binding", {
    request,
  });
};

export const deletePiAgentSessionBinding = async (
  sessionId: string,
): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("delete_agent_session_binding", { sessionId });
};

/**
 * Read a bounded slice of the Host-owned Pi event log for replay/diagnostics.
 * The renderer never writes this log and cannot request an unbounded result.
 */
export const readPiAgentEventLog = async (
  sessionId: string,
  afterOrdinal = -1,
  limit = 256,
): Promise<AgentEventLogRecord[]> => {
  if (!isTauriRuntime()) {
    return [];
  }
  const payload = await invoke<unknown>("read_agent_event_log", {
    sessionId,
    afterOrdinal,
    limit,
  });
  if (!Array.isArray(payload)) {
    throw new Error("Pi 事件日志返回了无法识别的数据。 ");
  }
  return payload.map(parseAgentEventLogRecord);
};

/**
 * Ask the Host for a bounded, payload-free crash-recovery summary. The
 * browser preview intentionally reports that Pi recovery is not applicable;
 * it must not pretend that a local SQLite/native session exists.
 */
export const inspectPiSessionRecovery = async (
  sessionId: string,
): Promise<PiRecoveryPlan> => {
  if (!isTauriRuntime()) {
    return emptyPiRecoveryPlan(sessionId);
  }
  const payload = await invoke<unknown>("inspect_pi_session_recovery", {
    sessionId,
  });
  return parsePiRecoveryPlan(payload);
};

export const stopPiWorker = async (): Promise<AgentStatus> => {
  if (!isTauriRuntime()) {
    return { phase: "stopped", message: "浏览器预览" };
  }
  return invoke<AgentStatus>("stop_pi_worker");
};

export const subscribeToPiAgentEvents = async (
  onEvent: (event: AgentEventEnvelope) => void,
  onStderr: (line: string) => void,
  onStatus?: (status: AgentStatus) => void,
): Promise<UnlistenFn[]> => {
  if (!isTauriRuntime()) {
    return [];
  }
  const unlistenEvent = await listen<AgentEventEnvelope>(
    PI_AGENT_EVENT,
    (event) => onEvent(event.payload),
  );
  const unlistenStderr = await listen<string>(
    "melody://pi-agent-stderr",
    (event) => onStderr(event.payload),
  );
  const unlistenStatus = onStatus
    ? await listen<AgentStatus>("melody://pi-agent-status", (event) =>
        onStatus(event.payload),
      )
    : undefined;
  return [
    unlistenEvent,
    unlistenStderr,
    ...(unlistenStatus ? [unlistenStatus] : []),
  ];
};

export const checkAppUpdate = async (
  channel: UpdateChannel = "stable",
  install = false,
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<AppUpdateStatus> => {
  if (!isTauriRuntime()) {
    return {
      channel,
      configured: false,
      available: false,
      installed: false,
    };
  }

  const progressChannel = new Channel<AppUpdateProgress>();
  if (onProgress) {
    progressChannel.onmessage = onProgress;
  }
  return invoke<AppUpdateStatus>("check_app_update", {
    channel,
    install,
    onProgress: progressChannel,
  });
};
