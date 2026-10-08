import type { AgentEventEnvelope } from "./contract.ts";

const MAX_ID_BYTES = 256;
const MAX_PAGE_SIZE = 2048;
const DEFAULT_PAGE_SIZE = 256;
const DEFAULT_MAX_EVENTS = 4096;
const MAX_EVENTS = 8192;

export interface AgentEventLogRecord {
  sessionId: string;
  ordinal: number;
  eventId: string;
  sourceEventId?: string | null;
  workerEpoch?: string | null;
  seq?: number | null;
  event: AgentEventEnvelope;
  createdAt: number;
}

export interface AgentEventLogReplayOptions {
  afterOrdinal?: number;
  pageSize?: number;
  maxEvents?: number;
}

export interface AgentEventLogReplayResult {
  delivered: number;
  nextOrdinal: number;
  complete: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_BYTES
  ) {
    throw new Error(`${field} 必须是 1-${MAX_ID_BYTES} 个字符的非空字符串。`);
  }
  return value;
};

const optionalString = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
};

const optionalNonNegativeInteger = (
  value: unknown,
  field: string,
): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} 必须是非负安全整数。`);
  }
  return value as number;
};

const normalizeBoundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number => {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > maximum
  ) {
    throw new Error(`${field} 必须是 1-${maximum} 的安全整数。`);
  }
  return candidate;
};

const parseEnvelope = (
  value: unknown,
  sessionId: string,
  eventId: string,
): AgentEventEnvelope => {
  if (!isRecord(value)) {
    throw new Error("事件日志 event 必须是对象。 ");
  }
  if (value.protocolVersion !== 1) {
    throw new Error("事件日志 event 使用了不支持的协议版本。 ");
  }
  if (requiredString(value.eventId, "事件日志 event.eventId") !== eventId) {
    throw new Error("事件日志 eventId 与记录不一致。 ");
  }
  if (value.sessionId !== sessionId) {
    throw new Error("事件日志 sessionId 与记录不一致。 ");
  }
  if (
    value.streamSessionId !== undefined &&
    (typeof value.streamSessionId !== "string" ||
      value.streamSessionId.trim().length === 0 ||
      value.streamSessionId.length > MAX_ID_BYTES)
  ) {
    throw new Error("事件日志 streamSessionId 必须是有界的非空字符串。 ");
  }
  if (typeof value.replay !== "boolean") {
    throw new Error("事件日志 event.replay 必须是布尔值。 ");
  }
  if (!isRecord(value.event) || typeof value.event.type !== "string") {
    throw new Error("事件日志 event.event 必须包含 type。 ");
  }
  const requestId = value.requestId;
  if (
    requestId !== undefined &&
    !(
      (typeof requestId === "string" && requestId.trim().length > 0) ||
      (typeof requestId === "number" && Number.isSafeInteger(requestId))
    )
  ) {
    throw new Error("事件日志 requestId 不是稳定 ID。 ");
  }
  return value as unknown as AgentEventEnvelope;
};

/** Validate one Host-returned log row before it reaches a renderer projection. */
export const parseAgentEventLogRecord = (
  value: unknown,
): AgentEventLogRecord => {
  if (!isRecord(value)) throw new Error("事件日志记录必须是对象。 ");
  const sessionId = requiredString(value.sessionId, "事件日志 sessionId");
  const ordinal = value.ordinal;
  if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0) {
    throw new Error("事件日志 ordinal 必须是非负安全整数。 ");
  }
  const eventId = requiredString(value.eventId, "事件日志 eventId");
  const sourceEventId = optionalString(
    value.sourceEventId,
    "事件日志 sourceEventId",
  );
  const workerEpoch = optionalString(value.workerEpoch, "事件日志 workerEpoch");
  const seq = optionalNonNegativeInteger(value.seq, "事件日志 seq");
  const createdAt = value.createdAt;
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) {
    throw new Error("事件日志 createdAt 必须是非负安全整数。 ");
  }
  return {
    sessionId,
    ordinal: ordinal as number,
    eventId,
    ...(sourceEventId !== null ? { sourceEventId } : {}),
    ...(workerEpoch !== null ? { workerEpoch } : {}),
    ...(seq !== null ? { seq } : {}),
    event: parseEnvelope(value.event, sessionId, eventId),
    createdAt: createdAt as number,
  };
};

/**
 * Turn a persisted fact into a replay delivery without changing its identity.
 * The event ID, sequence and source ID remain stable; only transport metadata
 * changes so subscribers can reset their replay checkpoint once.
 */
export const asReplayAgentEvent = (
  record: AgentEventLogRecord,
): AgentEventEnvelope => ({
  ...record.event,
  replay: true,
});

/**
 * Read and deliver a bounded event-log slice. Subscribe to live events before
 * calling this helper. A future resume coordinator can add a live/replay
 * barrier; this primitive intentionally reports `complete: false` when its
 * budget is exhausted instead of silently pretending the session is caught up.
 */
export const replayAgentEventLog = async (
  sessionId: string,
  readPage: (
    sessionId: string,
    afterOrdinal: number,
    limit: number,
  ) => Promise<unknown[]>,
  onEvent: (event: AgentEventEnvelope) => void,
  options: AgentEventLogReplayOptions = {},
): Promise<AgentEventLogReplayResult> => {
  const normalizedSessionId = requiredString(sessionId, "sessionId");
  const afterOrdinal = options.afterOrdinal ?? -1;
  if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1) {
    throw new Error("afterOrdinal 必须是 -1 或非负安全整数。 ");
  }
  const pageSize = normalizeBoundedInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    "pageSize",
  );
  const maxEvents = normalizeBoundedInteger(
    options.maxEvents,
    DEFAULT_MAX_EVENTS,
    MAX_EVENTS,
    "maxEvents",
  );

  let cursor = afterOrdinal;
  let delivered = 0;
  while (delivered < maxEvents) {
    const limit = Math.min(pageSize, maxEvents - delivered);
    const rawPage = await readPage(normalizedSessionId, cursor, limit);
    if (!Array.isArray(rawPage)) {
      throw new Error("事件日志分页结果必须是数组。 ");
    }
    if (rawPage.length > limit) {
      throw new Error("事件日志分页结果超过了请求上限。 ");
    }
    if (rawPage.length === 0) {
      return { delivered, nextOrdinal: cursor, complete: true };
    }

    let previousOrdinal = cursor;
    for (const rawRecord of rawPage) {
      const record = parseAgentEventLogRecord(rawRecord);
      if (record.sessionId !== normalizedSessionId) {
        throw new Error("事件日志记录属于另一个会话。 ");
      }
      if (record.ordinal <= previousOrdinal) {
        throw new Error("事件日志 ordinal 必须严格递增。 ");
      }
      previousOrdinal = record.ordinal;
      cursor = record.ordinal;
      onEvent(asReplayAgentEvent(record));
      delivered += 1;
      if (delivered >= maxEvents) break;
    }

    if (rawPage.length < limit) {
      return { delivered, nextOrdinal: cursor, complete: true };
    }
  }

  return { delivered, nextOrdinal: cursor, complete: false };
};
