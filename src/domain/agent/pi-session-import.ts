import type { AgentPlanStatus, TimelineEntry } from "../acp.ts";
import type {
  AgentAssistantMetadata,
  AgentAssistantUsage,
} from "./contract.ts";
import type {
  PiMigrationSource,
  StoredPiMigrationSource,
} from "./session-migration.ts";
import {
  TIMELINE_PROJECTION_VERSION,
  readTimelineProjection,
} from "../session-projection-persistence.ts";

/**
 * Versioned, side-effect-free description of an ACP → Pi import.
 *
 * This is intentionally not Pi's private JSONL entry type. The eventual
 * converter can use this plan to call the pinned public SessionManager API,
 * while the plan itself remains safe to show in diagnostics and tests.
 */
export const PI_SESSION_IMPORT_PLAN_VERSION = 1 as const;
export const PI_SESSION_IMPORT_CONVERTER_VERSION = "pi-import-v1" as const;
export const PI_SESSION_TARGET_FORMAT = "pi-coding-agent-v3" as const;

export const MAX_PI_IMPORT_ENTRIES = 4096;
export const MAX_PI_IMPORT_ENTRY_TEXT = 256_000;
export const MAX_PI_IMPORT_TOTAL_TEXT = 4_000_000;
export const MAX_PI_IMPORT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type PiImportReadiness = "native-ready" | "display-only" | "blocked";
export type PiImportTarget = "native-message" | "custom-entry";
export type PiImportAttachmentKind = "image" | "text" | "binary" | "external";

export interface PiImportAttachmentRef {
  id: string;
  filename?: string;
  mediaType: string;
  kind: PiImportAttachmentKind;
  byteLength?: number;
  /** The converter must materialize this from the source archive later. */
  materialization: "deferred" | "unavailable";
}

interface PiImportRecordBase {
  recordId: string;
  sourceIndex: number;
  sourceEntryId: string;
  target: PiImportTarget;
  textTruncated?: boolean;
}

export type PiImportRecord =
  | (PiImportRecordBase & {
      kind: "message";
      role: "user" | "assistant";
      content: string;
      attachments: PiImportAttachmentRef[];
      assistantMetadata?: AgentAssistantMetadata;
      /** Why a message is not safe to put into Pi's model context directly. */
      displayOnlyReason?:
        "assistant-metadata-missing" | "attachment-materialization-deferred";
    })
  | (PiImportRecordBase & {
      kind: "thought";
      content: string;
    })
  | (PiImportRecordBase & {
      kind: "plan";
      content: string;
      status: AgentPlanStatus;
    })
  | (PiImportRecordBase & {
      kind: "tool";
      title: string;
      command: string;
      output: string;
      status?: string;
      operation?: string;
      hasPendingPermission: boolean;
      hasPendingQuestion: boolean;
    });

export interface PiImportMapping {
  sourceIndex: number;
  sourceEntryId: string;
  recordId: string;
  target: PiImportTarget;
}

export interface PiSessionImportPlan {
  planVersion: typeof PI_SESSION_IMPORT_PLAN_VERSION;
  converterVersion: typeof PI_SESSION_IMPORT_CONVERTER_VERSION;
  targetFormat: typeof PI_SESSION_TARGET_FORMAT;
  sourceSessionId: string;
  sourceEngine: "melody-acp";
  targetEngine: "pi";
  sourceDigest: string;
  /** False when limits prevented hashing the complete source timeline. */
  sourceDigestComplete: boolean;
  sourceTimelineComplete: boolean;
  sourceEntryCount: number;
  nativeCandidateCount: number;
  displayOnlyCount: number;
  records: PiImportRecord[];
  mapping: PiImportMapping[];
  readiness: PiImportReadiness;
  blockers: string[];
  warnings: string[];
}

const MAX_ID_LENGTH = 256;
const MAX_STATUS_LENGTH = 256;
const MAX_DIAGNOSTICS = 32;
const PLAN_STATUSES = new Set<AgentPlanStatus>([
  "streaming",
  "awaiting-approval",
  "approved",
  "changes-requested",
  "abandoned",
  "superseded",
]);

const requireSessionId = (value: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new Error(`sessionId 必须是 1-${MAX_ID_LENGTH} 个字符的非空字符串。`);
  }
  return value;
};

const addUnique = (target: string[], value: string, max = MAX_DIAGNOSTICS) => {
  if (target.length >= max || target.includes(value)) return;
  target.push(value);
};

const boundedText = (
  value: string,
  total: { value: number },
): { text: string; truncated: boolean } => {
  const remaining = Math.max(0, MAX_PI_IMPORT_TOTAL_TEXT - total.value);
  const limit = Math.min(MAX_PI_IMPORT_ENTRY_TEXT, remaining);
  const text = value.slice(0, limit);
  total.value += text.length;
  return { text, truncated: text.length !== value.length };
};

const attachmentBytes = (url: string): number | undefined => {
  if (!url.startsWith("data:")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const body = url.slice(comma + 1);
  const header = url.slice(5, comma);
  if (header.endsWith(";base64")) {
    if (!/^[A-Za-z0-9+/\s]*={0,2}$/u.test(body)) return undefined;
    const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.max(
      0,
      Math.floor((body.replace(/\s/g, "").length * 3) / 4) - padding,
    );
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(body)).byteLength;
  } catch {
    return undefined;
  }
};

const attachmentKind = (mediaType: string): PiImportAttachmentKind => {
  const normalized = mediaType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (
    normalized.startsWith("text/") ||
    [
      "application/json",
      "application/javascript",
      "application/typescript",
      "application/xml",
    ].includes(normalized)
  ) {
    return "text";
  }
  return "binary";
};

const digestText = (value: string): string => {
  // Two independent 32-bit FNV-1a lanes keep this helper synchronous and
  // available in the browser, without importing Node's crypto module into
  // the domain layer. The sourceDigest is an identity/fingerprint, not a
  // security boundary; the Host still validates the source before writing.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code ^ (index & 0xff);
    second = Math.imul(second, 0x01000193);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
};

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return "null";
};

const recordIdFor = (index: number, entryId: string): string =>
  `pi-import-${index}-${digestText(entryId).slice(0, 12)}`;

const planStatus = (
  entry: Extract<TimelineEntry, { kind: "plan" }>,
  blockers: string[],
): AgentPlanStatus => {
  if (PLAN_STATUSES.has(entry.status)) return entry.status;
  addUnique(blockers, `计划 ${entry.id} 的状态无法识别，不能安全导入。`);
  return "abandoned";
};

const attachmentRefs = (
  entry: Extract<TimelineEntry, { kind: "message" }>,
  blockers: string[],
  warnings: string[],
): PiImportAttachmentRef[] => {
  const rawAttachments = (entry as { attachments?: unknown }).attachments;
  if (rawAttachments === undefined) return [];
  if (!Array.isArray(rawAttachments)) {
    addUnique(blockers, `消息 ${entry.id} 的附件字段不是数组。`);
    return [];
  }
  return rawAttachments.map((rawAttachment, attachmentIndex) => {
    const attachment =
      rawAttachment !== null && typeof rawAttachment === "object"
        ? (rawAttachment as Record<string, unknown>)
        : undefined;
    const validId =
      typeof attachment?.id === "string" &&
      attachment.id.trim().length > 0 &&
      attachment.id.length <= MAX_ID_LENGTH;
    const validMediaType =
      typeof attachment?.mediaType === "string" &&
      attachment.mediaType.trim().length > 0 &&
      attachment.mediaType.length <= MAX_STATUS_LENGTH;
    const validUrl = typeof attachment?.url === "string";
    if (!validId || !validMediaType || !validUrl) {
      addUnique(
        blockers,
        `消息 ${entry.id} 的第 ${attachmentIndex + 1} 个附件字段不完整。`,
      );
    }
    const id = validId
      ? (attachment.id as string)
      : `invalid-${entry.id}-${attachmentIndex}`;
    const mediaType = validMediaType
      ? (attachment.mediaType as string)
      : "application/octet-stream";
    const url = validUrl ? (attachment.url as string) : "";
    const kind = url.startsWith("data:")
      ? attachmentKind(mediaType)
      : "external";
    const bytes = attachmentBytes(url);
    if (!url.startsWith("data:")) {
      addUnique(
        blockers,
        `消息 ${entry.id} 的附件不是 data URL，导入时无法在不猜测路径的情况下重建。`,
      );
    } else if (bytes === undefined) {
      addUnique(blockers, `消息 ${entry.id} 的附件 data URL 无法解码。`);
    } else if (bytes > MAX_PI_IMPORT_ATTACHMENT_BYTES) {
      addUnique(
        blockers,
        `消息 ${entry.id} 的附件超过 Pi 单文件 10 MiB 限额。`,
      );
    }
    if (kind === "binary") {
      addUnique(
        warnings,
        `消息 ${entry.id} 含二进制附件；Pi 导入器需要单独的资源物化步骤。`,
      );
    }
    return {
      id,
      ...(typeof attachment?.filename === "string" &&
      attachment.filename.length <= MAX_STATUS_LENGTH
        ? { filename: attachment.filename }
        : {}),
      mediaType,
      kind,
      ...(bytes !== undefined ? { byteLength: bytes } : {}),
      materialization:
        kind === "external" || bytes === undefined ? "unavailable" : "deferred",
    };
  });
};

const pushMapping = (
  mapping: PiImportMapping[],
  sourceIndex: number,
  sourceEntryId: string,
  recordId: string,
  target: PiImportTarget,
) => {
  mapping.push({ sourceIndex, sourceEntryId, recordId, target });
};

const ASSISTANT_STOP_REASONS = new Set([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);

const boundedMetadataString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256
    ? value.trim()
    : undefined;

const nonNegativeMetadataNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Strip malformed or oversized metadata before it enters an import plan. */
const normalizeAssistantMetadata = (
  raw: unknown,
): AgentAssistantMetadata | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const provider = boundedMetadataString(value.provider);
  const api = boundedMetadataString(value.api);
  const model = boundedMetadataString(value.model);
  const responseId = boundedMetadataString(value.responseId);
  const stopReason = boundedMetadataString(value.stopReason);
  const rawUsage = value.usage;
  let usage: AgentAssistantUsage | undefined;
  if (
    rawUsage !== null &&
    typeof rawUsage === "object" &&
    !Array.isArray(rawUsage)
  ) {
    const source = rawUsage as Record<string, unknown>;
    const input = nonNegativeMetadataNumber(source.input);
    const output = nonNegativeMetadataNumber(source.output);
    const cacheRead = nonNegativeMetadataNumber(source.cacheRead);
    const cacheWrite = nonNegativeMetadataNumber(source.cacheWrite);
    const totalTokens = nonNegativeMetadataNumber(source.totalTokens);
    const costValue = source.cost;
    const cost =
      costValue !== null &&
      typeof costValue === "object" &&
      !Array.isArray(costValue)
        ? (costValue as Record<string, unknown>)
        : undefined;
    const costInput = nonNegativeMetadataNumber(cost?.input);
    const costOutput = nonNegativeMetadataNumber(cost?.output);
    const costCacheRead = nonNegativeMetadataNumber(cost?.cacheRead);
    const costCacheWrite = nonNegativeMetadataNumber(cost?.cacheWrite);
    const costTotal = nonNegativeMetadataNumber(cost?.total);
    if (
      input !== undefined &&
      output !== undefined &&
      cacheRead !== undefined &&
      cacheWrite !== undefined &&
      totalTokens !== undefined
    ) {
      usage = {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        ...(costInput !== undefined &&
        costOutput !== undefined &&
        costCacheRead !== undefined &&
        costCacheWrite !== undefined &&
        costTotal !== undefined
          ? {
              cost: {
                input: costInput,
                output: costOutput,
                cacheRead: costCacheRead,
                cacheWrite: costCacheWrite,
                total: costTotal,
              },
            }
          : {}),
      };
    }
  }
  const normalized: AgentAssistantMetadata = {
    ...(provider ? { provider } : {}),
    ...(api ? { api } : {}),
    ...(model ? { model } : {}),
    ...(responseId ? { responseId } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(usage ? { usage } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const assistantMetadataIsNativeReady = (
  metadata: AgentAssistantMetadata | undefined,
): metadata is AgentAssistantMetadata & {
  provider: string;
  api: string;
  model: string;
  stopReason: string;
  usage: AgentAssistantUsage & {
    cost: NonNullable<AgentAssistantUsage["cost"]>;
  };
} => {
  if (
    !metadata?.provider ||
    !metadata.api ||
    !metadata.model ||
    !metadata.stopReason ||
    !ASSISTANT_STOP_REASONS.has(metadata.stopReason)
  ) {
    return false;
  }
  const usage = metadata.usage;
  return Boolean(
    usage &&
    usage.cost &&
    [
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.totalTokens,
      usage.cost.input,
      usage.cost.output,
      usage.cost.cacheRead,
      usage.cost.cacheWrite,
      usage.cost.total,
    ].every((value) => nonNegativeMetadataNumber(value) !== undefined),
  );
};

/**
 * Build an auditable import plan without opening Pi or mutating any storage.
 * Assistant messages become native only when the projection carries the
 * provider/api/model/usage/stop metadata emitted by Pi itself. Legacy ACP
 * rows without that proof remain display-only; the planner never invents
 * provider or usage values.
 */
export const buildPiSessionImportPlan = (
  source: PiMigrationSource,
): PiSessionImportPlan => {
  const sourceSessionId = requireSessionId(source.sessionId);
  if (!Array.isArray(source.timeline))
    throw new Error("timeline 必须是数组。 ");

  const blockers: string[] = [];
  const warnings: string[] = [];
  const records: PiImportRecord[] = [];
  const mapping: PiImportMapping[] = [];
  const textTotal = { value: 0 };
  let nativeCandidateCount = 0;
  let displayOnlyCount = 0;
  const digestableTimeline = source.timeline.slice(0, MAX_PI_IMPORT_ENTRIES);
  const sourceDigestComplete = source.timeline.length <= MAX_PI_IMPORT_ENTRIES;
  const seenSourceEntryIds = new Set<string>();

  if (!source.timelineComplete) {
    addUnique(
      blockers,
      "源会话时间线不是完整投影，不能把导入结果当作完整上下文。",
    );
  }
  if (!sourceDigestComplete) {
    addUnique(
      blockers,
      `时间线超过 Pi 导入器的 ${MAX_PI_IMPORT_ENTRIES} 条上限，必须分批演练。`,
    );
  }

  digestableTimeline.forEach((entry, sourceIndex) => {
    const rawEntry =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : undefined;
    const rawEntryId = rawEntry?.id;
    const validEntryId =
      typeof rawEntryId === "string" &&
      rawEntryId.trim().length > 0 &&
      rawEntryId.length <= MAX_ID_LENGTH;
    const sourceEntryId = validEntryId
      ? (rawEntryId as string)
      : `invalid-entry-${sourceIndex}`;
    if (!validEntryId) {
      addUnique(
        blockers,
        `时间线条目 ${sourceIndex + 1} 的 id 无效，不能建立稳定映射。`,
      );
    } else if (seenSourceEntryIds.has(sourceEntryId)) {
      addUnique(
        blockers,
        `时间线条目 id ${sourceEntryId} 重复，不能建立无歧义映射。`,
      );
    }
    seenSourceEntryIds.add(sourceEntryId);
    const recordId = recordIdFor(sourceIndex, sourceEntryId);
    if (!rawEntry || typeof rawEntry.kind !== "string") {
      addUnique(
        blockers,
        `时间线条目 ${sourceIndex + 1} 缺少可识别的 kind，不能导入。`,
      );
      return;
    }
    if (!["message", "thought", "plan", "tool"].includes(rawEntry.kind)) {
      addUnique(
        blockers,
        `时间线条目 ${sourceEntryId} 的 kind ${rawEntry.kind} 暂不支持。`,
      );
      return;
    }
    if (entry.kind === "message") {
      const role =
        entry.role === "user" || entry.role === "assistant"
          ? entry.role
          : "user";
      if (rawEntry.role !== "user" && rawEntry.role !== "assistant") {
        addUnique(
          blockers,
          `消息 ${sourceEntryId} 的 role 无法识别，不能安全导入。`,
        );
      }
      const content =
        typeof rawEntry.content === "string" ? rawEntry.content : "";
      if (typeof rawEntry.content !== "string") {
        addUnique(
          blockers,
          `消息 ${sourceEntryId} 缺少文本内容，不能安全导入。`,
        );
      }
      const bounded = boundedText(content, textTotal);
      const attachments = attachmentRefs(entry, blockers, warnings);
      const isStreaming = entry.streaming === true;
      const assistant = role === "assistant";
      const hasAttachments = attachments.length > 0;
      const assistantMetadata = assistant
        ? normalizeAssistantMetadata(rawEntry.assistantMetadata)
        : undefined;
      const assistantNativeReady =
        assistant && assistantMetadataIsNativeReady(assistantMetadata);
      const displayOnlyReason = assistant
        ? assistantNativeReady && !hasAttachments
          ? undefined
          : "assistant-metadata-missing"
        : hasAttachments
          ? "attachment-materialization-deferred"
          : undefined;
      const target: PiImportTarget = displayOnlyReason
        ? "custom-entry"
        : "native-message";
      if (assistant && !assistantNativeReady) {
        addUnique(
          warnings,
          `助手消息 ${entry.id} 缺少完整的 Pi provider/api/usage/model/stop 元数据，只能作为展示归档。`,
        );
      }
      if (isStreaming) {
        addUnique(
          blockers,
          `消息 ${entry.id} 仍处于流式状态，必须先在旧引擎中结束。`,
        );
      }
      if (bounded.truncated) {
        addUnique(
          blockers,
          `消息 ${entry.id} 超过 ${MAX_PI_IMPORT_ENTRY_TEXT} 字符或总文本预算，不能无损导入。`,
        );
      }
      if (displayOnlyReason) displayOnlyCount += 1;
      else nativeCandidateCount += 1;
      const record: PiImportRecord = {
        recordId,
        sourceIndex,
        sourceEntryId,
        target,
        kind: "message",
        role,
        content: bounded.text,
        attachments,
        ...(assistantMetadata ? { assistantMetadata } : {}),
        ...(displayOnlyReason ? { displayOnlyReason } : {}),
        ...(bounded.truncated ? { textTruncated: true } : {}),
      };
      records.push(record);
      pushMapping(mapping, sourceIndex, sourceEntryId, recordId, target);
      return;
    }

    if (entry.kind === "thought") {
      const content =
        typeof rawEntry.content === "string" ? rawEntry.content : "";
      if (typeof rawEntry.content !== "string") {
        addUnique(
          blockers,
          `思考条目 ${sourceEntryId} 缺少文本内容，不能安全导入。`,
        );
      }
      const bounded = boundedText(content, textTotal);
      if (entry.streaming === true) {
        addUnique(
          blockers,
          `思考条目 ${entry.id} 仍处于流式状态，必须先结束。`,
        );
      }
      if (bounded.truncated) {
        addUnique(
          blockers,
          `思考条目 ${entry.id} 超出导入文本预算，不能无损归档。`,
        );
      }
      displayOnlyCount += 1;
      const record: PiImportRecord = {
        recordId,
        sourceIndex,
        sourceEntryId,
        target: "custom-entry",
        kind: "thought",
        content: bounded.text,
        ...(bounded.truncated ? { textTruncated: true } : {}),
      };
      records.push(record);
      pushMapping(
        mapping,
        sourceIndex,
        sourceEntryId,
        recordId,
        "custom-entry",
      );
      return;
    }

    if (entry.kind === "plan") {
      const content =
        typeof rawEntry.content === "string" ? rawEntry.content : "";
      if (typeof rawEntry.content !== "string") {
        addUnique(
          blockers,
          `计划 ${sourceEntryId} 缺少文本内容，不能安全导入。`,
        );
      }
      const bounded = boundedText(content, textTotal);
      if (
        entry.status === "streaming" ||
        entry.status === "awaiting-approval"
      ) {
        addUnique(
          blockers,
          `计划 ${entry.id} 仍有未结束交互（${entry.status}），不能带入 Pi。`,
        );
      }
      if (bounded.truncated) {
        addUnique(
          blockers,
          `计划 ${entry.id} 超出导入文本预算，不能无损归档。`,
        );
      }
      displayOnlyCount += 1;
      const record: PiImportRecord = {
        recordId,
        sourceIndex,
        sourceEntryId,
        target: "custom-entry",
        kind: "plan",
        content: bounded.text,
        status: planStatus(entry, blockers),
        ...(bounded.truncated ? { textTruncated: true } : {}),
      };
      records.push(record);
      pushMapping(
        mapping,
        sourceIndex,
        sourceEntryId,
        recordId,
        "custom-entry",
      );
      return;
    }

    const rawTitle = rawEntry.title;
    const rawCommand = rawEntry.command;
    const rawOutput = rawEntry.output;
    if (
      typeof rawTitle !== "string" ||
      typeof rawCommand !== "string" ||
      typeof rawOutput !== "string"
    ) {
      addUnique(
        blockers,
        `工具条目 ${sourceEntryId} 缺少标题、命令或输出，不能安全导入。`,
      );
    }
    const command = boundedText(
      typeof rawCommand === "string" ? rawCommand : "",
      textTotal,
    );
    const output = boundedText(
      typeof rawOutput === "string" ? rawOutput : "",
      textTotal,
    );
    const title =
      typeof rawTitle === "string"
        ? rawTitle.slice(0, MAX_STATUS_LENGTH)
        : "未知工具";
    const activity =
      rawEntry.activity !== null && typeof rawEntry.activity === "object"
        ? (rawEntry.activity as Record<string, unknown>)
        : undefined;
    const operation =
      typeof activity?.operation === "string" ? activity.operation : undefined;
    const hasPendingPermission = entry.permission === "pending";
    const hasPendingQuestion = entry.question?.outcome === "pending";
    if (hasPendingPermission || hasPendingQuestion) {
      addUnique(
        blockers,
        `工具 ${entry.id} 仍有未决审批或问题，不能把旧交互静默带入 Pi。`,
      );
    }
    if (entry.status === "pending" || entry.status === "running") {
      addUnique(
        blockers,
        `工具 ${entry.id} 仍在运行，不能在副作用不明时迁移。`,
      );
    }
    if (command.truncated || output.truncated) {
      addUnique(
        blockers,
        `工具 ${entry.id} 的命令或输出超出导入文本预算，不能无损归档。`,
      );
    }
    addUnique(
      warnings,
      `工具 ${entry.id} 只作为展示归档，不会在 Pi 导入期间重放或重新执行。`,
    );
    displayOnlyCount += 1;
    const record: PiImportRecord = {
      recordId,
      sourceIndex,
      sourceEntryId,
      target: "custom-entry",
      kind: "tool",
      title,
      command: command.text,
      output: output.text,
      ...(typeof entry.status === "string" && entry.status
        ? { status: entry.status.slice(0, MAX_STATUS_LENGTH) }
        : {}),
      ...(operation ? { operation } : {}),
      hasPendingPermission,
      hasPendingQuestion,
      ...(command.truncated || output.truncated ? { textTruncated: true } : {}),
    };
    records.push(record);
    pushMapping(mapping, sourceIndex, sourceEntryId, recordId, "custom-entry");
  });

  const sourceDigest = digestText(
    canonicalJson({
      sessionId: sourceSessionId,
      entryCount: source.timeline.length,
      timeline: digestableTimeline,
      complete: sourceDigestComplete,
    }),
  );
  const readiness: PiImportReadiness =
    blockers.length > 0
      ? "blocked"
      : displayOnlyCount > 0
        ? "display-only"
        : "native-ready";

  return {
    planVersion: PI_SESSION_IMPORT_PLAN_VERSION,
    converterVersion: PI_SESSION_IMPORT_CONVERTER_VERSION,
    targetFormat: PI_SESSION_TARGET_FORMAT,
    sourceSessionId,
    sourceEngine: "melody-acp",
    targetEngine: "pi",
    sourceDigest,
    sourceDigestComplete,
    sourceTimelineComplete: source.timelineComplete,
    sourceEntryCount: source.timeline.length,
    nativeCandidateCount,
    displayOnlyCount,
    records,
    mapping,
    readiness,
    blockers,
    warnings,
  };
};

/** Build the same dry-run plan from the persisted session/archive boundary. */
export const buildPiSessionImportPlanForSession = (
  source: StoredPiMigrationSource,
): PiSessionImportPlan => {
  const timelineJson = source.timelineArchiveJson ?? source.timelineJson;
  const projection = readTimelineProjection(timelineJson);
  const complete =
    !source.timelineArchiveReadFailed &&
    projection.status === "valid" &&
    (projection.timeline.length === 0 ||
      source.timelineArchiveJson !== undefined ||
      (source.timelineVersion === TIMELINE_PROJECTION_VERSION &&
        Boolean(source.acpCursor)));
  return buildPiSessionImportPlan({
    sessionId: source.id,
    ...(source.acpSessionId ? { acpSessionId: source.acpSessionId } : {}),
    ...(source.acpCursor ? { acpCursor: source.acpCursor } : {}),
    timelineComplete: complete,
    timeline: projection.timeline,
  });
};
