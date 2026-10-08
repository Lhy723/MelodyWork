import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const PI_IMPORT_PLAN_VERSION = 1;
export const PI_IMPORT_TARGET_FORMAT = "pi-coding-agent-v3";
const MAX_RECORDS = 4096;
const MAX_TEXT = 4_000_000;

type ImportRecord = {
  recordId?: unknown;
  sourceEntryId?: unknown;
  target?: unknown;
  kind?: unknown;
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

export interface MaterializedPiImport {
  path: string;
  nativeSessionId: string;
  records: number;
  nativeMessages: number;
  displayEntries: number;
  backupPath?: string;
}

const requiredText = (value: unknown, field: string, max = 256): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new Error(`${field} must be a bounded non-empty string`);
  }
  return value;
};

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

const ASSISTANT_STOP_REASONS = new Set([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);

const nonNegativeNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
};

const assistantMessageFromRecord = (
  record: ImportRecord,
  content: string,
  timestamp: number,
): Record<string, unknown> => {
  const metadata = record.assistantMetadata;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error("native assistant record must include Pi metadata");
  }
  const value = metadata as Record<string, unknown>;
  const provider = requiredText(value.provider, "assistantMetadata.provider");
  const api = requiredText(value.api, "assistantMetadata.api");
  const model = requiredText(value.model, "assistantMetadata.model");
  const stopReason = requiredText(
    value.stopReason,
    "assistantMetadata.stopReason",
  );
  if (!ASSISTANT_STOP_REASONS.has(stopReason)) {
    throw new Error(`unsupported assistant stop reason: ${stopReason}`);
  }
  const rawUsage = value.usage;
  if (
    rawUsage === null ||
    typeof rawUsage !== "object" ||
    Array.isArray(rawUsage)
  ) {
    throw new Error("native assistant record must include Pi usage");
  }
  const usage = rawUsage as Record<string, unknown>;
  const costValue = usage.cost;
  if (
    costValue === null ||
    typeof costValue !== "object" ||
    Array.isArray(costValue)
  ) {
    throw new Error("native assistant record must include Pi usage cost");
  }
  const cost = costValue as Record<string, unknown>;
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api,
    provider,
    model,
    usage: {
      input: nonNegativeNumber(usage.input, "assistantMetadata.usage.input"),
      output: nonNegativeNumber(usage.output, "assistantMetadata.usage.output"),
      cacheRead: nonNegativeNumber(
        usage.cacheRead,
        "assistantMetadata.usage.cacheRead",
      ),
      cacheWrite: nonNegativeNumber(
        usage.cacheWrite,
        "assistantMetadata.usage.cacheWrite",
      ),
      totalTokens: nonNegativeNumber(
        usage.totalTokens,
        "assistantMetadata.usage.totalTokens",
      ),
      cost: {
        input: nonNegativeNumber(
          cost.input,
          "assistantMetadata.usage.cost.input",
        ),
        output: nonNegativeNumber(
          cost.output,
          "assistantMetadata.usage.cost.output",
        ),
        cacheRead: nonNegativeNumber(
          cost.cacheRead,
          "assistantMetadata.usage.cost.cacheRead",
        ),
        cacheWrite: nonNegativeNumber(
          cost.cacheWrite,
          "assistantMetadata.usage.cost.cacheWrite",
        ),
        total: nonNegativeNumber(
          cost.total,
          "assistantMetadata.usage.cost.total",
        ),
      },
    },
    stopReason,
    timestamp,
  };
};

/**
 * Materialize the domain import plan into Pi's public v3 JSONL shape. Only
 * records explicitly classified as `native-message` become model context;
 * everything else is persisted as a custom display/state entry and can never
 * be replayed as a tool call. Writes are atomic and optionally preserve the
 * pre-import file next to the destination.
 */
export const materializePiSessionImport = (
  value: unknown,
  options: {
    path: string;
    cwd: string;
    nativeSessionId?: string;
    backup?: boolean;
  },
): MaterializedPiImport => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session import plan must be an object");
  }
  const plan = value as Record<string, unknown>;
  if (plan.planVersion !== PI_IMPORT_PLAN_VERSION) {
    throw new Error("unsupported Pi import plan version");
  }
  if (plan.targetFormat !== PI_IMPORT_TARGET_FORMAT) {
    throw new Error("unsupported Pi import target format");
  }
  const sourceSessionId = requiredText(plan.sourceSessionId, "sourceSessionId");
  const records = plan.records;
  if (!Array.isArray(records) || records.length > MAX_RECORDS) {
    throw new Error(`records must contain at most ${MAX_RECORDS} entries`);
  }
  let totalText = 0;
  const nativeSessionId =
    options.nativeSessionId?.trim() || `pi-import-${randomUUID()}`;
  requiredText(nativeSessionId, "nativeSessionId");
  requiredText(options.cwd, "cwd", 4096);

  const header = {
    type: "session",
    version: 3,
    id: nativeSessionId,
    timestamp: new Date().toISOString(),
    cwd: options.cwd,
    parentSession: undefined,
  };
  const lines = [jsonLine(header)];
  let parentId: string | null = null;
  let nativeMessages = 0;
  let displayEntries = 0;
  const seen = new Set<string>();
  for (const [index, raw] of records.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`record ${index + 1} must be an object`);
    }
    const record = raw as ImportRecord;
    const recordId = requiredText(
      record.recordId,
      `record ${index + 1}.recordId`,
    );
    if (seen.has(recordId))
      throw new Error(`duplicate import record id: ${recordId}`);
    seen.add(recordId);
    const kind = requiredText(record.kind, `record ${index + 1}.kind`);
    const content = typeof record.content === "string" ? record.content : "";
    totalText += content.length;
    if (totalText > MAX_TEXT)
      throw new Error("import text exceeds the 4 MB limit");
    const timestamp = new Date(Date.now() + index).toISOString();
    const native =
      record.target === "native-message" &&
      kind === "message" &&
      (record.role === "user" || record.role === "assistant");
    const entry = native
      ? {
          type: "message",
          id: recordId,
          parentId,
          timestamp,
          message:
            record.role === "assistant"
              ? assistantMessageFromRecord(record, content, Date.now() + index)
              : {
                  role: "user",
                  content,
                  timestamp: Date.now() + index,
                },
        }
      : {
          type: "custom",
          id: recordId,
          parentId,
          timestamp,
          customType: "melody.import",
          data: {
            sourceSessionId,
            sourceEntryId: record.sourceEntryId,
            kind,
            content,
            record,
          },
        };
    lines.push(jsonLine(entry));
    parentId = recordId;
    if (native) nativeMessages += 1;
    else displayEntries += 1;
  }

  const path = options.path;
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(path)) {
    if (!options.backup)
      throw new Error(
        "target Pi session already exists; enable backup to replace it",
      );
    backupPath = `${path}.pre-import-${Date.now()}.bak`;
    copyFileSync(path, backupPath);
    // Reading before replacement makes an accidental empty write impossible
    // when the destination is concurrently replaced by another process.
    readFileSync(path);
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, lines.join(""), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return {
    path,
    nativeSessionId,
    records: records.length,
    nativeMessages,
    displayEntries,
    ...(backupPath ? { backupPath } : {}),
  };
};
