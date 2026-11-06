import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { containsControlCharacters } from "@melody/agent-contract";
import type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";
import { isPiSubagentType } from "./subagent-policy-normalization.ts";
import type {
  PiSubagentIsolation,
  PiSubagentType,
} from "./subagent-policy-normalization.ts";
export { isPiSubagentType } from "./subagent-policy-normalization.ts";
export type { PiSubagentType } from "./subagent-policy-normalization.ts";

const PI_SUBAGENT_RECORD_DIRECTORY = "subagent-tasks";
const MAX_PERSISTED_MCP_TOOLS = 64;
const PI_MCP_TOOL_PATTERN =
  /^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$/u;

export type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Durable metadata kept beside Pi's native JSONL for completed child
 * sessions. The task id is the lookup key, while the session file and cwd are
 * validated again before a transcript is opened. This makes `resume_from`
 * survive a worker restart without turning a user-provided string into a
 * filesystem path.
 */
export interface PersistedPiSubagent {
  taskId: string;
  rootSessionId: string;
  parentSessionId: string;
  parentTaskId?: string;
  subagentType: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
  capabilityMode: PiSubagentCapabilityMode;
  /** Exact MCP tool grants retained so a resumed child keeps its ceiling. */
  mcpTools?: string[];
  /** Approval mode retained across worker restarts for safe resume. */
  permissionMode?: "ask" | "auto" | "always-approve";
  isolation: PiSubagentIsolation;
  worktreePath?: string;
  resumedFrom?: string;
  sessionFile: string;
  cwd: string;
  modelId?: string;
  reasoningEffort: PiThinkingLevel;
  status: "running" | "completed" | "failed" | "cancelled";
  output?: string;
  updatedAt: number;
}

export type PiSubagentRecordLoadResult =
  | { kind: "missing" }
  | { kind: "loaded"; record: PersistedPiSubagent }
  | { kind: "unavailable"; message: string }
  | { kind: "invalid"; message: string };

/**
 * Derive the sidecar filename from an opaque task identity. Task IDs never
 * become path components, keeping the record layout portable and private.
 */
export const piSubagentRecordFileFor = (
  sessionRoot: string,
  taskId: string,
): string => {
  const key = createHash("sha256").update(taskId).digest("hex");
  return join(sessionRoot, PI_SUBAGENT_RECORD_DIRECTORY, `task-${key}.json`);
};

const piThinkingLevels = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const piSubagentCapabilities = new Set<PiSubagentCapabilityMode>([
  "read-only",
  "read-write",
  "read-write-execute",
  "execute",
  "all",
]);

const piSubagentIsolations = new Set<PiSubagentIsolation>(["none", "worktree"]);
const piPermissionModes = new Set<"ask" | "auto" | "always-approve">([
  "ask",
  "auto",
  "always-approve",
]);

export const isPiThinkingLevel = (value: string): value is PiThinkingLevel =>
  piThinkingLevels.has(value as PiThinkingLevel);

const persistedString = (
  source: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined => {
  const value = source[key];
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`missing ${key}`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`invalid ${key}`);
  }
  const normalized = value.trim();
  if (
    normalized.length > (options.maxLength ?? 4_096) ||
    containsControlCharacters(normalized)
  ) {
    throw new Error(`invalid ${key}`);
  }
  return normalized;
};

const requiredPersistedString = (
  source: Record<string, unknown>,
  key: string,
  maxLength = 4_096,
): string => {
  const value = persistedString(source, key, { required: true, maxLength });
  if (!value) throw new Error(`missing ${key}`);
  return value;
};

/**
 * Validate a sidecar before the Pi SDK opens its JSONL. The session file is
 * canonicalized and checked against the trusted root on every load.
 */
export const parsePersistedPiSubagentRecord = (
  value: unknown,
  expectedTaskId: string,
  sessionRoot: string,
): PersistedPiSubagent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const taskId = requiredPersistedString(record, "taskId", 512);
  if (taskId !== expectedTaskId) throw new Error("task id mismatch");
  const rootSessionId = requiredPersistedString(record, "rootSessionId", 512);
  const parentSessionId = requiredPersistedString(
    record,
    "parentSessionId",
    512,
  );
  const subagentType = requiredPersistedString(record, "subagentType", 64);
  if (!isPiSubagentType(subagentType)) {
    throw new Error("invalid subagent type");
  }
  const capabilityMode = requiredPersistedString(record, "capabilityMode", 32);
  if (!piSubagentCapabilities.has(capabilityMode as PiSubagentCapabilityMode)) {
    throw new Error("invalid capability mode");
  }
  const persistedMcpTools = record.mcpTools;
  if (
    persistedMcpTools !== undefined &&
    (!Array.isArray(persistedMcpTools) ||
      persistedMcpTools.length > MAX_PERSISTED_MCP_TOOLS ||
      persistedMcpTools.some(
        (entry) =>
          typeof entry !== "string" ||
          entry.length > 128 ||
          !PI_MCP_TOOL_PATTERN.test(entry),
      ))
  ) {
    throw new Error("invalid MCP tool grants");
  }
  const isolation = requiredPersistedString(record, "isolation", 32);
  if (!piSubagentIsolations.has(isolation as PiSubagentIsolation)) {
    throw new Error("invalid isolation");
  }
  const sessionFile = requiredPersistedString(record, "sessionFile");
  const cwd = requiredPersistedString(record, "cwd");
  const reasoningEffort = requiredPersistedString(
    record,
    "reasoningEffort",
    32,
  );
  if (!isPiThinkingLevel(reasoningEffort)) {
    throw new Error("invalid reasoning effort");
  }
  const status = requiredPersistedString(record, "status", 32);
  if (!new Set(["running", "completed", "failed", "cancelled"]).has(status)) {
    throw new Error("invalid status");
  }
  const updatedAt = record.updatedAt;
  if (
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    throw new Error("invalid updatedAt");
  }
  const canonicalRoot = realpathSync(sessionRoot);
  const canonicalSessionFile = realpathSync(sessionFile);
  if (
    !canonicalSessionFile.startsWith(`${canonicalRoot}${sep}`) ||
    !lstatSync(canonicalSessionFile).isFile()
  ) {
    throw new Error("session file is outside the Pi session root");
  }
  const optional = (key: string, maxLength = 4_096) =>
    persistedString(record, key, { maxLength });
  const parentTaskId = optional("parentTaskId", 512);
  const role = optional("role", 128);
  const persona = optional("persona", 128);
  const agent = optional("agent", 128);
  const worktreePath = optional("worktreePath");
  const resumedFrom = optional("resumedFrom", 512);
  const modelId = optional("modelId", 256);
  const permissionMode = optional("permissionMode", 32);
  if (
    permissionMode &&
    !piPermissionModes.has(permissionMode as "ask" | "auto" | "always-approve")
  ) {
    throw new Error("invalid permission mode");
  }
  const output = optional("output", 64 * 1024);
  return {
    taskId,
    rootSessionId,
    parentSessionId,
    ...(parentTaskId ? { parentTaskId } : {}),
    subagentType: subagentType as PiSubagentType,
    ...(role ? { role } : {}),
    ...(persona ? { persona } : {}),
    ...(agent ? { agent } : {}),
    capabilityMode: capabilityMode as PiSubagentCapabilityMode,
    ...(persistedMcpTools
      ? { mcpTools: [...(persistedMcpTools as string[])] }
      : {}),
    isolation: isolation as PiSubagentIsolation,
    ...(worktreePath ? { worktreePath } : {}),
    ...(resumedFrom ? { resumedFrom } : {}),
    sessionFile: canonicalSessionFile,
    cwd,
    ...(modelId ? { modelId } : {}),
    ...(permissionMode
      ? {
          permissionMode: permissionMode as "ask" | "auto" | "always-approve",
        }
      : {}),
    reasoningEffort: reasoningEffort as PiThinkingLevel,
    status: status as PersistedPiSubagent["status"],
    ...(output ? { output } : {}),
    updatedAt,
  };
};

/**
 * Read and validate one sidecar. Returning a tagged failure lets the session
 * lifecycle preserve its existing user-facing error codes without owning
 * filesystem or schema details.
 */
export const loadPiSubagentRecord = async (
  sessionRoot: string,
  taskId: string,
): Promise<PiSubagentRecordLoadResult> => {
  let text: string;
  try {
    text = await readFile(piSubagentRecordFileFor(sessionRoot, taskId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return {
      kind: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return {
      kind: "loaded",
      record: parsePersistedPiSubagentRecord(
        JSON.parse(text),
        taskId,
        sessionRoot,
      ),
    };
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Persist a record only after its Pi transcript exists. Writes use a sibling
 * temporary file and atomic rename so a worker crash cannot expose partial
 * JSON as a resumable session.
 */
export const savePiSubagentRecord = async (
  sessionRoot: string,
  record: PersistedPiSubagent,
): Promise<boolean> => {
  try {
    if (!lstatSync(record.sessionFile).isFile()) return false;
  } catch {
    return false;
  }
  const directory = join(sessionRoot, PI_SUBAGENT_RECORD_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const path = piSubagentRecordFileFor(sessionRoot, record.taskId);
  const temporary = join(
    directory,
    `.${record.taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-32)}-${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf8");
  await rename(temporary, path);
  return true;
};
