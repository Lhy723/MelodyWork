const MAX_ID_LENGTH = 256;
const MAX_LIST_LENGTH = 4096;
const MAX_REASON_LENGTH = 1024;

export type PiRecoveryAction =
  "not-applicable" | "clean" | "replay" | "reconcile" | "blocked";

export interface PiRecoveryRun {
  runId: string;
  status: string;
}

export interface PiRecoveryTool {
  toolCallId: string;
  toolName?: string | null;
  runId?: string | null;
  status: string;
}

export interface PiRecoveryInteraction {
  interactionId: string;
  kind: "permission" | "question" | "plan" | string;
  runId?: string | null;
}

export interface PiRecoveryTask {
  taskId: string;
  status: string;
  childSessionId?: string | null;
  runId?: string | null;
}

export interface PiRecoveryMessage {
  messageId: string;
  role: "user" | "assistant";
}

export interface PiRecoveryPlan {
  sessionId: string;
  engine?: "melody-acp" | "pi" | string | null;
  nativeSessionId?: string | null;
  workerEpoch?: string | null;
  lastSeq?: number | null;
  lastOrdinal?: number | null;
  eventCount: number;
  scannedEvents: number;
  scanComplete: boolean;
  activeRuns: PiRecoveryRun[];
  pendingTools: PiRecoveryTool[];
  pendingInteractions: PiRecoveryInteraction[];
  activeTasks: PiRecoveryTask[];
  activeMessages: PiRecoveryMessage[];
  compactionInProgress: boolean;
  recommendedAction: PiRecoveryAction;
  reasons: string[];
}

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new Error(
      field + " 必须是 1-" + MAX_ID_LENGTH + " 个字符的非空字符串。",
    );
  }
  return value;
};

const optionalString = (
  value: unknown,
  field: string,
): string | null | undefined => {
  if (value === undefined || value === null) return value;
  return requiredString(value, field);
};

const optionalInteger = (
  value: unknown,
  field: string,
): number | null | undefined => {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(field + " 必须是非负安全整数。");
  }
  return value as number;
};

const requiredInteger = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(field + " 必须是非负安全整数。");
  }
  return value as number;
};

const boundedList = <T>(
  value: unknown,
  field: string,
  parse: (item: unknown, index: number) => T,
): T[] => {
  if (!Array.isArray(value)) throw new Error(field + " 必须是数组。");
  if (value.length > MAX_LIST_LENGTH) {
    throw new Error(field + " 超过了 " + MAX_LIST_LENGTH + " 项上限。");
  }
  return value.map(parse);
};

const parseRun = (value: unknown, index: number): PiRecoveryRun => {
  if (!isRecord(value))
    throw new Error("activeRuns[" + index + "] 必须是对象。");
  return {
    runId: requiredString(value.runId, "activeRuns[" + index + "].runId"),
    status: requiredString(value.status, "activeRuns[" + index + "].status"),
  };
};

const parseTool = (value: unknown, index: number): PiRecoveryTool => {
  if (!isRecord(value)) {
    throw new Error("pendingTools[" + index + "] 必须是对象。");
  }
  return {
    toolCallId: requiredString(
      value.toolCallId,
      "pendingTools[" + index + "].toolCallId",
    ),
    toolName: optionalString(
      value.toolName,
      "pendingTools[" + index + "].toolName",
    ),
    runId: optionalString(value.runId, "pendingTools[" + index + "].runId"),
    status: requiredString(value.status, "pendingTools[" + index + "].status"),
  };
};

const parseInteraction = (
  value: unknown,
  index: number,
): PiRecoveryInteraction => {
  if (!isRecord(value)) {
    throw new Error("pendingInteractions[" + index + "] 必须是对象。");
  }
  return {
    interactionId: requiredString(
      value.interactionId,
      "pendingInteractions[" + index + "].interactionId",
    ),
    kind: requiredString(value.kind, "pendingInteractions[" + index + "].kind"),
    runId: optionalString(
      value.runId,
      "pendingInteractions[" + index + "].runId",
    ),
  };
};

const parseTask = (value: unknown, index: number): PiRecoveryTask => {
  if (!isRecord(value))
    throw new Error("activeTasks[" + index + "] 必须是对象。");
  return {
    taskId: requiredString(value.taskId, "activeTasks[" + index + "].taskId"),
    status: requiredString(value.status, "activeTasks[" + index + "].status"),
    childSessionId: optionalString(
      value.childSessionId,
      "activeTasks[" + index + "].childSessionId",
    ),
    runId: optionalString(value.runId, "activeTasks[" + index + "].runId"),
  };
};

const parseMessage = (value: unknown, index: number): PiRecoveryMessage => {
  if (!isRecord(value)) {
    throw new Error("activeMessages[" + index + "] 必须是对象。");
  }
  const role = requiredString(value.role, "activeMessages[" + index + "].role");
  if (role !== "user" && role !== "assistant") {
    throw new Error("activeMessages[" + index + "].role 不是受支持的角色。");
  }
  return {
    messageId: requiredString(
      value.messageId,
      "activeMessages[" + index + "].messageId",
    ),
    role,
  };
};

const parseReasons = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("reasons 必须是数组。");
  if (value.length > 16) throw new Error("reasons 超过了 16 项上限。");
  return value.map((reason, index) => {
    if (
      typeof reason !== "string" ||
      reason.trim().length === 0 ||
      reason.length > MAX_REASON_LENGTH
    ) {
      throw new Error("reasons[" + index + "] 不是有界的非空字符串。");
    }
    return reason;
  });
};

/** Validate the Host's bounded, payload-free recovery summary. */
export const parsePiRecoveryPlan = (value: unknown): PiRecoveryPlan => {
  if (!isRecord(value)) throw new Error("Pi 恢复检查结果必须是对象。");
  const recommendedAction = value.recommendedAction;
  if (
    recommendedAction !== "not-applicable" &&
    recommendedAction !== "clean" &&
    recommendedAction !== "replay" &&
    recommendedAction !== "reconcile" &&
    recommendedAction !== "blocked"
  ) {
    throw new Error("Pi 恢复检查结果包含未知动作。");
  }
  const engine = optionalString(value.engine, "engine");
  const scanComplete = value.scanComplete;
  if (typeof scanComplete !== "boolean") {
    throw new Error("scanComplete 必须是布尔值。");
  }
  const compactionInProgress = value.compactionInProgress;
  if (typeof compactionInProgress !== "boolean") {
    throw new Error("compactionInProgress 必须是布尔值。");
  }
  return {
    sessionId: requiredString(value.sessionId, "sessionId"),
    engine,
    nativeSessionId: optionalString(value.nativeSessionId, "nativeSessionId"),
    workerEpoch: optionalString(value.workerEpoch, "workerEpoch"),
    lastSeq: optionalInteger(value.lastSeq, "lastSeq"),
    lastOrdinal: optionalInteger(value.lastOrdinal, "lastOrdinal"),
    eventCount: requiredInteger(value.eventCount, "eventCount"),
    scannedEvents: requiredInteger(value.scannedEvents, "scannedEvents"),
    scanComplete,
    activeRuns: boundedList(value.activeRuns, "activeRuns", parseRun),
    pendingTools: boundedList(value.pendingTools, "pendingTools", parseTool),
    pendingInteractions: boundedList(
      value.pendingInteractions,
      "pendingInteractions",
      parseInteraction,
    ),
    activeTasks: boundedList(value.activeTasks, "activeTasks", parseTask),
    activeMessages: boundedList(
      value.activeMessages,
      "activeMessages",
      parseMessage,
    ),
    compactionInProgress,
    recommendedAction,
    reasons: parseReasons(value.reasons),
  };
};

export const emptyPiRecoveryPlan = (sessionId: string): PiRecoveryPlan => ({
  sessionId: requiredString(sessionId, "sessionId"),
  engine: null,
  nativeSessionId: null,
  workerEpoch: null,
  lastSeq: null,
  lastOrdinal: null,
  eventCount: 0,
  scannedEvents: 0,
  scanComplete: true,
  activeRuns: [],
  pendingTools: [],
  pendingInteractions: [],
  activeTasks: [],
  activeMessages: [],
  compactionInProgress: false,
  recommendedAction: "not-applicable",
  reasons: [],
});
