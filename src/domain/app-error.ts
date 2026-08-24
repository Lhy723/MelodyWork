export type AppErrorKind =
  | "validation"
  | "not-found"
  | "permission"
  | "network"
  | "timeout"
  | "conflict"
  | "storage"
  | "protocol"
  | "unknown";

const MAX_ERROR_MESSAGE_CHARS = 500;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

/** Extracts a stable transport message without leaking an Error stack. */
export const rawErrorMessage = (reason: unknown): string => {
  if (reason instanceof Error) {
    return reason.message.trim();
  }
  if (typeof reason === "string") {
    return reason.trim();
  }
  const value = objectValue(reason);
  for (const key of ["message", "error", "detail", "reason"]) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  try {
    const serialized = JSON.stringify(reason);
    return serialized && serialized !== "{}" ? serialized : "";
  } catch {
    return "";
  }
};

const statusCode = (reason: unknown): number | undefined => {
  const value = objectValue(reason);
  const status = value?.status ?? value?.statusCode;
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
};

export const classifyError = (reason: unknown): AppErrorKind => {
  const message = rawErrorMessage(reason).toLowerCase();
  const status = statusCode(reason);
  const name = reason instanceof Error ? reason.name.toLowerCase() : "";

  if (
    name === "aborterror" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("超时") ||
    message.includes("aborted")
  ) {
    return "timeout";
  }
  if (
    status === 401 ||
    status === 403 ||
    /permission|forbidden|unauthori[sz]ed|权限/.test(message)
  ) {
    return "permission";
  }
  if (
    status === 404 ||
    /not found|does not exist|不存在|未找到/.test(message)
  ) {
    return "not-found";
  }
  if (status === 409 || /conflict|already exists|冲突|已存在/.test(message)) {
    return "conflict";
  }
  if (
    (status !== undefined && (status === 429 || status >= 500)) ||
    /network|fetch failed|failed to fetch|offline|dns|连接失败|网络/.test(
      message,
    )
  ) {
    return "network";
  }
  if (
    /database|sqlite|storage|persist|disk|数据库|存储|保存失败/.test(message)
  ) {
    return "storage";
  }
  if (/protocol|json-rpc|acp|invalid response|协议|响应无效/.test(message)) {
    return "protocol";
  }
  if (
    /invalid|malformed|required|must |请输入|无效|不能为空|不支持/.test(message)
  ) {
    return "validation";
  }
  return "unknown";
};

const bounded = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_CHARS
    ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`
    : message;

/** Converts raw Rust/HTTP/IPC failures into consistent UI-facing text. */
export const toUserMessage = (
  reason: unknown,
  fallback = "操作失败，请稍后重试。",
): string => {
  const message = rawErrorMessage(reason);
  if (!message) {
    return fallback;
  }

  switch (classifyError(reason)) {
    case "timeout":
      return "请求超时，请稍后重试。";
    case "network":
      return "网络请求失败，请检查网络连接后重试。";
    case "permission":
      return "没有权限执行此操作。";
    case "not-found":
      return "目标不存在或已被移除。";
    case "conflict":
      return "数据已发生变化，请刷新后重试。";
    case "storage":
      return "本地数据保存失败，请稍后重试。";
    case "protocol":
      return "Agent 协议响应无效，请重试。";
    case "validation":
      // Preserve actionable validation text (including existing Chinese copy).
      return bounded(message);
    default:
      return bounded(message) || fallback;
  }
};
