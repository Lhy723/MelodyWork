/**
 * Bounded normalization of Host-owned Pi subagent policy snapshots and launch aliases.
 */
import type {
  AgentSubagentCapabilityMode,
  AgentSubagentAgentPolicy,
  AgentSubagentIsolation,
  AgentSubagentPersonaPolicy,
  AgentSubagentPolicyManifest,
  AgentSubagentRolePolicy,
} from "@melody/agent-contract";
import { containsControlCharacters } from "@melody/agent-contract";
import type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";

export type PiSubagentType = "general-purpose" | "explore" | "plan";
export type PiSubagentIsolation = AgentSubagentIsolation;

const PI_SUBAGENT_TYPES = new Set<PiSubagentType>([
  "general-purpose",
  "explore",
  "plan",
]);

export const isPiSubagentType = (value: string): value is PiSubagentType =>
  PI_SUBAGENT_TYPES.has(value as PiSubagentType);

const MAX_POLICY_COUNT = 128;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_INSTRUCTIONS_LENGTH = 32 * 1024;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_REASONING_LENGTH = 32;
const MAX_TOGGLE_COUNT = 256;

const CAPABILITY_MODES = new Set<AgentSubagentCapabilityMode>([
  "read-only",
  "read-write",
  "read-write-execute",
  "execute",
  "all",
]);
const ISOLATIONS = new Set<AgentSubagentIsolation>(["none", "worktree"]);

const capabilityModeFor = (
  value: string,
): AgentSubagentCapabilityMode | undefined => {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const aliases: Record<string, AgentSubagentCapabilityMode> = {
    readonly: "read-only",
    "read-only": "read-only",
    readwrite: "read-write",
    "read-write": "read-write",
    readwriteexecute: "read-write-execute",
    "read-write-execute": "read-write-execute",
    execute: "execute",
    all: "all",
  };
  const mode = aliases[normalized];
  return mode && CAPABILITY_MODES.has(mode) ? mode : undefined;
};

const isolationFor = (value: string): AgentSubagentIsolation | undefined => {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const isolation = normalized === "work-tree" ? "worktree" : normalized;
  return ISOLATIONS.has(isolation as AgentSubagentIsolation)
    ? (isolation as AgentSubagentIsolation)
    : undefined;
};

export type PiSubagentPolicyError = Error & {
  agentError: {
    code: string;
    message: string;
    retriable: false;
    scope: "run";
  };
};

export const createPiSubagentPolicyError = (
  code: string,
  message: string,
): PiSubagentPolicyError => {
  const error = new Error(message) as PiSubagentPolicyError;
  error.agentError = {
    code,
    message,
    retriable: false,
    scope: "run",
  };
  return error;
};

export const normalizePiSubagentType = (value: unknown): PiSubagentType => {
  if (value === undefined || value === null || value === "") {
    return "general-purpose";
  }
  if (typeof value === "string" && isPiSubagentType(value)) {
    return value;
  }
  throw createPiSubagentPolicyError(
    "pi.unsupported_subagent_type",
    `Pi 迁移版暂不支持子代理类型：${String(value)}。可选值为 general-purpose、explore、plan。`,
  );
};

export const normalizePiSubagentIsolation = (
  value: unknown,
): PiSubagentIsolation | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw createPiSubagentPolicyError(
      "pi.invalid_subagent_isolation",
      "子代理 isolation 必须是 none 或 worktree。",
    );
  }
  const isolation = isolationFor(value);
  if (isolation) return isolation;
  throw createPiSubagentPolicyError(
    "pi.invalid_subagent_isolation",
    `不支持的子代理 isolation：${value}。可选值为 none、worktree。`,
  );
};

export const normalizePiSubagentCapabilityMode = (
  value: unknown,
): PiSubagentCapabilityMode | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw createPiSubagentPolicyError(
      "pi.invalid_subagent_capability_mode",
      "子代理 capabilityMode 必须是 read-only、read-write、read-write-execute、execute 或 all。",
    );
  }
  const mode = capabilityModeFor(value);
  if (!mode) {
    throw createPiSubagentPolicyError(
      "pi.invalid_subagent_capability_mode",
      `不支持的子代理 capabilityMode：${value}。可选值为 read-only、read-write、read-write-execute、execute、all。`,
    );
  }
  return mode;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const text = (
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): string | undefined => {
  if (value === undefined || value === null) {
    if (required) {
      throw createPiSubagentPolicyError(
        "pi.subagent_policy_invalid",
        `${field} 必须是非空字符串。`,
      );
    }
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    containsControlCharacters(value)
  ) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 必须是长度不超过 ${maxLength} 且不含控制字符的非空字符串。`,
    );
  }
  return value.trim();
};

const policyName = (value: unknown, field: string): string => {
  const name = text(value, field, MAX_NAME_LENGTH, true);
  // The required branch above always returns a string; keep this guard for
  // TypeScript and for callers that use a transpiler without narrowing.
  if (!name) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不能为空。`,
    );
  }
  return name;
};

const optionalCapability = (
  value: unknown,
  field: string,
): AgentSubagentCapabilityMode | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 capabilityMode。`,
    );
  }
  const mode = capabilityModeFor(value);
  if (!mode) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 capabilityMode。`,
    );
  }
  return mode;
};

const MAX_MCP_TOOLS = 64;
const MAX_MCP_SERVER_NAME_LENGTH = 64;
const MAX_MCP_TOOL_NAME_LENGTH = 96;
const MAX_MCP_NAME_LENGTH = 128;
const MCP_TOOL_PATTERN = new RegExp(
  `^mcp__[A-Za-z0-9_.-]{1,${MAX_MCP_SERVER_NAME_LENGTH}}__[A-Za-z0-9_.-]{1,${MAX_MCP_TOOL_NAME_LENGTH}}$`,
  "u",
);

/**
 * Exact MCP tool grants. A malformed entry fails closed: silently dropping it
 * would either remove a granted tool or, if the list were ignored entirely,
 * hand the child the whole server surface.
 */
const optionalMcpTools = (
  value: unknown,
  field: string,
): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MCP_TOOLS) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 MCP 授权列表。`,
    );
  }
  const tools = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw createPiSubagentPolicyError(
        "pi.subagent_policy_invalid",
        `${field} 只能包含 mcp__<server>__<tool> 形式的字符串。`,
      );
    }
    const name = entry.trim();
    if (!MCP_TOOL_PATTERN.test(name) || name.length > MAX_MCP_NAME_LENGTH) {
      throw createPiSubagentPolicyError(
        "pi.subagent_policy_invalid",
        `${field} 包含无法校验的 MCP 工具名。`,
      );
    }
    tools.add(name);
  }
  return [...tools].sort();
};

const optionalIsolation = (
  value: unknown,
  field: string,
): AgentSubagentIsolation | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 isolation。`,
    );
  }
  const isolation = isolationFor(value);
  if (!isolation) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 isolation。`,
    );
  }
  return isolation;
};

const normalizeRole = (
  value: unknown,
  index: number,
): AgentSubagentRolePolicy => {
  if (!isRecord(value)) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `subagentPolicies.roles[${index}] 必须是对象。`,
    );
  }
  const name = policyName(value.name, `subagentPolicies.roles[${index}].name`);
  const description = text(
    value.description,
    `subagentPolicies.roles[${index}].description`,
    MAX_DESCRIPTION_LENGTH,
  );
  const instructions = text(
    value.instructions ?? value.prompt,
    `subagentPolicies.roles[${index}].instructions`,
    MAX_INSTRUCTIONS_LENGTH,
  );
  const modelId = text(
    value.modelId ?? value.model,
    `subagentPolicies.roles[${index}].modelId`,
    MAX_MODEL_ID_LENGTH,
  );
  const reasoningEffort = text(
    value.reasoningEffort ?? value.reasoning_effort,
    `subagentPolicies.roles[${index}].reasoningEffort`,
    MAX_REASONING_LENGTH,
  );
  const isolation = optionalIsolation(
    value.isolation ?? value.defaultIsolation ?? value.default_isolation,
    `subagentPolicies.roles[${index}].isolation`,
  );
  const defaultCapabilityMode = optionalCapability(
    value.defaultCapabilityMode ?? value.default_capability_mode,
    `subagentPolicies.roles[${index}].defaultCapabilityMode`,
  );
  return {
    name,
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
    ...(defaultCapabilityMode ? { defaultCapabilityMode } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isolation ? { isolation } : {}),
  };
};

const normalizePersona = (
  value: unknown,
  index: number,
): AgentSubagentPersonaPolicy => {
  if (!isRecord(value)) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `subagentPolicies.personas[${index}] 必须是对象。`,
    );
  }
  const name = policyName(
    value.name,
    `subagentPolicies.personas[${index}].name`,
  );
  const description = text(
    value.description,
    `subagentPolicies.personas[${index}].description`,
    MAX_DESCRIPTION_LENGTH,
  );
  const instructions = text(
    value.instructions ?? value.prompt,
    `subagentPolicies.personas[${index}].instructions`,
    MAX_INSTRUCTIONS_LENGTH,
    true,
  );
  if (!instructions) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `subagentPolicies.personas[${index}].instructions 不能为空。`,
    );
  }
  const modelId = text(
    value.modelId ?? value.model,
    `subagentPolicies.personas[${index}].modelId`,
    MAX_MODEL_ID_LENGTH,
  );
  const reasoningEffort = text(
    value.reasoningEffort ?? value.reasoning_effort,
    `subagentPolicies.personas[${index}].reasoningEffort`,
    MAX_REASONING_LENGTH,
  );
  const isolation = optionalIsolation(
    value.isolation ?? value.defaultIsolation ?? value.default_isolation,
    `subagentPolicies.personas[${index}].isolation`,
  );
  return {
    name,
    description,
    instructions,
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isolation ? { isolation } : {}),
  };
};

const normalizeAgent = (
  value: unknown,
  index: number,
): AgentSubagentAgentPolicy => {
  if (!isRecord(value)) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `subagentPolicies.agents[${index}] 必须是对象。`,
    );
  }
  const name = policyName(value.name, `subagentPolicies.agents[${index}].name`);
  const description = text(
    value.description,
    `subagentPolicies.agents[${index}].description`,
    MAX_DESCRIPTION_LENGTH,
  );
  const instructions = text(
    value.instructions ?? value.prompt,
    `subagentPolicies.agents[${index}].instructions`,
    MAX_INSTRUCTIONS_LENGTH,
  );
  const defaultCapabilityMode = optionalCapability(
    value.defaultCapabilityMode ?? value.default_capability_mode,
    `subagentPolicies.agents[${index}].defaultCapabilityMode`,
  );
  const permissionMode = value.permissionMode ?? value.permission_mode;
  if (
    permissionMode !== undefined &&
    permissionMode !== "ask" &&
    permissionMode !== "auto" &&
    permissionMode !== "always-approve"
  ) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `subagentPolicies.agents[${index}].permissionMode 不是受支持的值。`,
    );
  }
  const modelId = text(
    value.modelId ?? value.model,
    `subagentPolicies.agents[${index}].modelId`,
    MAX_MODEL_ID_LENGTH,
  );
  const reasoningEffort = text(
    value.reasoningEffort ?? value.reasoning_effort ?? value.effort,
    `subagentPolicies.agents[${index}].reasoningEffort`,
    MAX_REASONING_LENGTH,
  );
  const isolation = optionalIsolation(
    value.isolation ?? value.defaultIsolation ?? value.default_isolation,
    `subagentPolicies.agents[${index}].isolation`,
  );
  const mcpTools = optionalMcpTools(
    value.mcpTools ?? value.mcp_tools,
    `subagentPolicies.agents[${index}].mcpTools`,
  );
  return {
    name,
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
    ...(defaultCapabilityMode ? { defaultCapabilityMode } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isolation ? { isolation } : {}),
    ...(mcpTools ? { mcpTools } : {}),
  };
};

const normalizeMap = <T>(
  value: unknown,
  field: string,
  mapper: (entry: unknown, name: string) => T,
): Record<string, T> => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 必须是对象。`,
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_TOGGLE_COUNT) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `${field} 不能超过 ${MAX_TOGGLE_COUNT} 项。`,
    );
  }
  const result: Record<string, T> = {};
  for (const [rawName, entry] of entries) {
    const name = policyName(rawName, `${field} 名称`);
    result[name] = mapper(entry, name);
  }
  return result;
};

export const emptyPiSubagentPolicyManifest =
  (): AgentSubagentPolicyManifest => ({
    enabled: true,
    models: {},
    toggle: {},
    roles: [],
    personas: [],
    agents: [],
  });

/**
 * Normalize the Host-projected policy snapshot at the worker boundary. The
 * Host is the source of truth, but keeping this validation in the worker
 * prevents a malformed refresh or stale sidecar from widening child access.
 */
export const normalizePiSubagentPolicyManifest = (
  value: unknown,
): AgentSubagentPolicyManifest => {
  if (value === undefined || value === null) {
    return emptyPiSubagentPolicyManifest();
  }
  if (!isRecord(value)) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      "subagentPolicies 必须是对象。",
    );
  }
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      "subagentPolicies.enabled 必须是布尔值。",
    );
  }
  const rawRoles = value.roles === undefined ? [] : value.roles;
  const rawPersonas = value.personas === undefined ? [] : value.personas;
  const rawAgents = value.agents === undefined ? [] : value.agents;
  if (
    !Array.isArray(rawRoles) ||
    !Array.isArray(rawPersonas) ||
    !Array.isArray(rawAgents)
  ) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      "subagentPolicies.roles/personas/agents 必须是数组。",
    );
  }
  if (
    rawRoles.length > MAX_POLICY_COUNT ||
    rawPersonas.length > MAX_POLICY_COUNT ||
    rawAgents.length > MAX_POLICY_COUNT
  ) {
    throw createPiSubagentPolicyError(
      "pi.subagent_policy_invalid",
      `subagentPolicies 每类不能超过 ${MAX_POLICY_COUNT} 项。`,
    );
  }
  const roles = rawRoles.map(normalizeRole);
  const personas = rawPersonas.map(normalizePersona);
  const agents = rawAgents.map(normalizeAgent);
  for (const entries of [roles, personas, agents]) {
    const names = new Set<string>();
    for (const entry of entries) {
      if (names.has(entry.name)) {
        throw createPiSubagentPolicyError(
          "pi.subagent_policy_invalid",
          `subagentPolicies 中不能包含重复的 ${entry.name}。`,
        );
      }
      names.add(entry.name);
    }
  }
  const models = normalizeMap(
    value.models,
    "subagentPolicies.models",
    (entry, name) => {
      const modelId = text(
        entry,
        `subagentPolicies.models.${name}`,
        MAX_MODEL_ID_LENGTH,
        true,
      );
      if (!modelId) {
        throw createPiSubagentPolicyError(
          "pi.subagent_policy_invalid",
          `subagentPolicies.models.${name} 不能为空。`,
        );
      }
      return modelId;
    },
  );
  const toggle = normalizeMap(
    value.toggle,
    "subagentPolicies.toggle",
    (entry, name) => {
      if (typeof entry !== "boolean") {
        throw createPiSubagentPolicyError(
          "pi.subagent_policy_invalid",
          `subagentPolicies.toggle.${name} 必须是布尔值。`,
        );
      }
      return entry;
    },
  );
  let unsupportedAgents: string[] | undefined;
  if (value.unsupportedAgents !== undefined) {
    if (!Array.isArray(value.unsupportedAgents)) {
      throw createPiSubagentPolicyError(
        "pi.subagent_policy_invalid",
        "subagentPolicies.unsupportedAgents 必须是数组。",
      );
    }
    if (value.unsupportedAgents.length > MAX_POLICY_COUNT) {
      throw createPiSubagentPolicyError(
        "pi.subagent_policy_invalid",
        `subagentPolicies.unsupportedAgents 不能超过 ${MAX_POLICY_COUNT} 项。`,
      );
    }
    unsupportedAgents = value.unsupportedAgents.map((entry, index) =>
      policyName(entry, `subagentPolicies.unsupportedAgents[${index}]`),
    );
    if (new Set(unsupportedAgents).size !== unsupportedAgents.length) {
      throw createPiSubagentPolicyError(
        "pi.subagent_policy_invalid",
        "subagentPolicies.unsupportedAgents 不能包含重复名称。",
      );
    }
  }
  return {
    enabled,
    models,
    toggle,
    roles,
    personas,
    agents,
    ...(unsupportedAgents?.length ? { unsupportedAgents } : {}),
  };
};
