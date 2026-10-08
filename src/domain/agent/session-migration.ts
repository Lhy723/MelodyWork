import type { TimelineEntry } from "../acp.ts";
import type { SessionRecord } from "../workspace.ts";
import {
  TIMELINE_PROJECTION_VERSION,
  readTimelineProjection,
} from "../session-projection-persistence.ts";

export type PiMigrationClassification =
  "lossless-candidate" | "display-only" | "blocked";

export interface PiMigrationSource {
  sessionId: string;
  acpSessionId?: string;
  acpCursor?: string;
  /** False when the projection was compacted or an archive read failed. */
  timelineComplete: boolean;
  timeline: TimelineEntry[];
}

export interface StoredPiMigrationSource extends Pick<
  SessionRecord,
  "id" | "acpSessionId" | "acpCursor" | "timelineJson" | "timelineVersion"
> {
  /** Full archive returned by the Host, when it is available. */
  timelineArchiveJson?: string;
  /** Set when the archive read failed and the snapshot cannot be trusted. */
  timelineArchiveReadFailed?: boolean;
}

export interface PiMigrationCounts {
  entries: number;
  messages: number;
  thoughts: number;
  plans: number;
  tools: number;
  questions: number;
  permissions: number;
  attachments: number;
}

export interface PiMigrationReport {
  reportVersion: 1;
  sourceSessionId: string;
  sourceEngine: "melody-acp";
  targetEngine: "pi";
  source: {
    acpSessionId?: string;
    hasAcpCursor: boolean;
    timelineComplete: boolean;
  };
  classification: PiMigrationClassification;
  counts: PiMigrationCounts;
  blockers: string[];
  warnings: string[];
}

const MAX_ID_LENGTH = 256;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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

const attachmentBytes = (url: string): number | undefined => {
  if (!url.startsWith("data:")) return undefined;
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const body = url.slice(comma + 1);
  if (url.slice(0, comma).endsWith(";base64")) {
    const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.floor((body.length * 3) / 4) - padding;
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(body)).byteLength;
  } catch {
    return undefined;
  }
};

const addUnique = (target: string[], value: string) => {
  if (!target.includes(value)) target.push(value);
};

/**
 * Classify an ACP projection before any engine binding is changed.
 *
 * This deliberately reports a conservative result. A display-only report is
 * still useful for a new Pi branch, but it is never presented as an exact
 * context conversion. The function performs no I/O and never mutates the
 * source timeline, so it can be used for dry-runs and CI fixtures.
 */
export const buildPiMigrationReport = (
  source: PiMigrationSource,
): PiMigrationReport => {
  const sourceSessionId = requireSessionId(source.sessionId);
  if (!Array.isArray(source.timeline)) {
    throw new Error("timeline 必须是数组。 ");
  }

  const counts: PiMigrationCounts = {
    entries: source.timeline.length,
    messages: 0,
    thoughts: 0,
    plans: 0,
    tools: 0,
    questions: 0,
    permissions: 0,
    attachments: 0,
  };
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!source.timelineComplete) {
    addUnique(
      blockers,
      "源会话时间线不是完整投影，不能在不丢失上下文的前提下续聊。",
    );
  }

  for (const entry of source.timeline) {
    if (entry.kind === "message") {
      counts.messages += 1;
      for (const attachment of entry.attachments ?? []) {
        counts.attachments += 1;
        const bytes = attachmentBytes(attachment.url);
        if (bytes === undefined && attachment.url.startsWith("data:")) {
          addUnique(
            blockers,
            `附件 ${attachment.filename ?? attachment.id} 无法解码，不能保证迁移后可用。`,
          );
        } else if (bytes !== undefined && bytes > MAX_ATTACHMENT_BYTES) {
          addUnique(
            blockers,
            `附件 ${attachment.filename ?? attachment.id} 超过 Pi 单文件 10 MiB 限额。`,
          );
        }
      }
      if (!entry.content.trim()) {
        addUnique(warnings, "存在空消息，迁移时只能保留其消息边界。 ");
      }
      continue;
    }
    if (entry.kind === "thought") {
      counts.thoughts += 1;
      continue;
    }
    if (entry.kind === "plan") {
      counts.plans += 1;
      addUnique(
        warnings,
        "计划历史会作为展示记录导入；迁移后新的计划审批由 Pi 适配器重新创建。",
      );
      if (
        entry.status === "awaiting-approval" ||
        entry.status === "streaming"
      ) {
        addUnique(
          blockers,
          "源会话含有尚未结束的计划交互，必须在原引擎中结束后才能迁移。",
        );
      }
      continue;
    }

    counts.tools += 1;
    if (entry.permission === "pending") counts.permissions += 1;
    if (entry.question) counts.questions += 1;
    if (
      entry.permission === "pending" ||
      entry.question?.outcome === "pending"
    ) {
      addUnique(
        blockers,
        `工具 ${entry.title} 有未决审批或问题，不能把旧交互静默带入 Pi。`,
      );
    }
    const operation = entry.activity?.operation ?? "other";
    if (operation === "read" || operation === "search") continue;
    if (entry.status === "pending" || entry.status === "running") {
      addUnique(
        blockers,
        `工具 ${entry.title} 仍处于运行状态，不能在副作用不明时迁移。`,
      );
    } else {
      addUnique(
        warnings,
        `工具 ${entry.title} 的 ${operation} 操作历史只作为展示记录导入；迁移后再次执行必须通过受控 ToolGateway 并重新审批。`,
      );
    }
  }

  const classification: PiMigrationClassification =
    blockers.length > 0
      ? "blocked"
      : warnings.length > 0
        ? "display-only"
        : "lossless-candidate";

  return {
    reportVersion: 1,
    sourceSessionId,
    sourceEngine: "melody-acp",
    targetEngine: "pi",
    source: {
      ...(source.acpSessionId ? { acpSessionId: source.acpSessionId } : {}),
      hasAcpCursor: Boolean(source.acpCursor),
      timelineComplete: source.timelineComplete,
    },
    classification,
    counts,
    blockers,
    warnings,
  };
};

/**
 * Build a dry-run report from a persisted Melody session without mutating it.
 * Prefer the unbounded Host archive when supplied; a valid current snapshot
 * with an ACP cursor is otherwise accepted as a complete projection. An
 * archive read failure is intentionally conservative and blocks migration.
 */
export const buildPiMigrationReportForSession = (
  source: StoredPiMigrationSource,
): PiMigrationReport => {
  const timelineJson = source.timelineArchiveJson ?? source.timelineJson;
  const projection = readTimelineProjection(timelineJson);
  const complete =
    !source.timelineArchiveReadFailed &&
    projection.status === "valid" &&
    (projection.timeline.length === 0 ||
      source.timelineArchiveJson !== undefined ||
      (source.timelineVersion === TIMELINE_PROJECTION_VERSION &&
        Boolean(source.acpCursor)));
  return buildPiMigrationReport({
    sessionId: source.id,
    ...(source.acpSessionId ? { acpSessionId: source.acpSessionId } : {}),
    ...(source.acpCursor ? { acpCursor: source.acpCursor } : {}),
    timelineComplete: complete,
    timeline: projection.timeline,
  });
};
