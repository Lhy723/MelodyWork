import type {
  AgentSubagentCapabilityMode,
  AgentSubagentAgentPolicy,
  AgentSubagentIsolation,
  AgentSubagentPersonaPolicy,
  AgentSubagentPolicyManifest,
  AgentSubagentRolePolicy,
} from "@melody/agent-contract";
import { containsControlCharacters } from "@melody/agent-contract";

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

type PolicyError = Error & {
  agentError: {
    code: string;
    message: string;
    retriable: false;
    scope: "run";
  };
};

const policyError = (code: string, message: string): PolicyError => {
  const error = new Error(message) as PolicyError;
  error.agentError = {
    code,
    message,
    retriable: false,
    scope: "run",
  };
  return error;
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
      throw policyError(
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
    throw policyError(
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
    throw policyError("pi.subagent_policy_invalid", `${field} 不能为空。`);
  }
  return name;
};

const optionalCapability = (
  value: unknown,
  field: string,
): AgentSubagentCapabilityMode | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw policyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 capabilityMode。`,
    );
  }
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
  if (!mode || !CAPABILITY_MODES.has(mode)) {
    throw policyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 capabilityMode。`,
    );
  }
  return mode;
};

const MAX_MCP_TOOLS = 64;
const MAX_MCP_NAME_LENGTH = 128;
const MCP_TOOL_PATTERN = /^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$/u;

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
    throw policyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 MCP 授权列表。`,
    );
  }
  const tools = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw policyError(
        "pi.subagent_policy_invalid",
        `${field} 只能包含 mcp__<server>__<tool> 形式的字符串。`,
      );
    }
    const name = entry.trim();
    if (!MCP_TOOL_PATTERN.test(name) || name.length > MAX_MCP_NAME_LENGTH) {
      throw policyError(
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
    throw policyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 isolation。`,
    );
  }
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const isolation = normalized === "work-tree" ? "worktree" : normalized;
  if (!ISOLATIONS.has(isolation as AgentSubagentIsolation)) {
    throw policyError(
      "pi.subagent_policy_invalid",
      `${field} 不是受支持的 isolation。`,
    );
  }
  return isolation as AgentSubagentIsolation;
};

const normalizeRole = (
  value: unknown,
  index: number,
): AgentSubagentRolePolicy => {
  if (!isRecord(value)) {
    throw policyError(
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
    throw policyError(
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
    throw policyError(
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
    throw policyError(
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
    throw policyError(
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
    throw policyError("pi.subagent_policy_invalid", `${field} 必须是对象。`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_TOGGLE_COUNT) {
    throw policyError(
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
    throw policyError(
      "pi.subagent_policy_invalid",
      "subagentPolicies 必须是对象。",
    );
  }
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") {
    throw policyError(
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
    throw policyError(
      "pi.subagent_policy_invalid",
      "subagentPolicies.roles/personas/agents 必须是数组。",
    );
  }
  if (
    rawRoles.length > MAX_POLICY_COUNT ||
    rawPersonas.length > MAX_POLICY_COUNT ||
    rawAgents.length > MAX_POLICY_COUNT
  ) {
    throw policyError(
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
        throw policyError(
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
        throw policyError(
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
        throw policyError(
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
      throw policyError(
        "pi.subagent_policy_invalid",
        "subagentPolicies.unsupportedAgents 必须是数组。",
      );
    }
    if (value.unsupportedAgents.length > MAX_POLICY_COUNT) {
      throw policyError(
        "pi.subagent_policy_invalid",
        `subagentPolicies.unsupportedAgents 不能超过 ${MAX_POLICY_COUNT} 项。`,
      );
    }
    unsupportedAgents = value.unsupportedAgents.map((entry, index) =>
      policyName(entry, `subagentPolicies.unsupportedAgents[${index}]`),
    );
    if (new Set(unsupportedAgents).size !== unsupportedAgents.length) {
      throw policyError(
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

export interface PiSubagentPolicyInput {
  subagentType?: string;
  role?: string;
  persona?: string;
  agent?: string;
  modelId?: string;
  reasoningEffort?: string;
  isolation?: AgentSubagentIsolation;
  capabilityMode?: AgentSubagentCapabilityMode;
}

export interface PiSubagentPolicyResolution {
  role?: AgentSubagentRolePolicy;
  persona?: AgentSubagentPersonaPolicy;
  agent?: AgentSubagentAgentPolicy;
  modelId?: string;
  reasoningEffort?: string;
  isolation: AgentSubagentIsolation;
  capabilityMode: AgentSubagentCapabilityMode;
  /** Exact MCP tool grants carried by the selected agent definition. */
  mcpTools?: string[];
  permissionMode?: "ask" | "auto" | "always-approve";
}

const findNamed = <T extends { name: string }>(
  entries: readonly T[],
  name: string | undefined,
  field: string,
): T | undefined => {
  if (!name) return undefined;
  const normalized = name.trim();
  if (!normalized) return undefined;
  const entry = entries.find((candidate) => candidate.name === normalized);
  if (!entry) {
    throw policyError(
      field === "role"
        ? "pi.subagent_role_not_found"
        : field === "persona"
          ? "pi.subagent_persona_not_found"
          : "pi.subagent_definition_not_found",
      `未找到配置的 ${field}：${normalized}。`,
    );
  }
  return entry;
};

/** Resolve policy defaults. Explicit request values always win. */
export const resolvePiSubagentPolicy = (
  manifest: AgentSubagentPolicyManifest,
  input: PiSubagentPolicyInput,
): PiSubagentPolicyResolution => {
  const policies = normalizePiSubagentPolicyManifest(manifest);
  if (!policies.enabled) {
    throw policyError("pi.subagent_disabled", "当前配置已禁用 Pi 子代理。");
  }
  const type = input.subagentType?.trim() || "general-purpose";
  const agentName =
    input.agent?.trim() ||
    (policies.agents.some((candidate) => candidate.name === type)
      ? type
      : undefined);
  if (agentName && policies.unsupportedAgents?.includes(agentName)) {
    throw policyError(
      "pi.subagent_definition_unavailable",
      `当前 Pi 会话无法使用包含动态能力的子代理定义：${agentName}。该定义不可用；请调整定义后重试。`,
    );
  }
  const agent = findNamed(policies.agents, agentName, "agent");
  const roleName =
    input.role?.trim() ||
    (policies.roles.some((candidate) => candidate.name === type)
      ? type
      : undefined);
  const role = findNamed(policies.roles, roleName, "role");
  const persona = findNamed(
    policies.personas,
    input.persona?.trim(),
    "persona",
  );
  for (const name of [type, role?.name, persona?.name, agent?.name]) {
    if (name && policies.toggle[name] === false) {
      throw policyError(
        "pi.subagent_disabled",
        `配置已禁用 Pi 子代理类型或策略：${name}。`,
      );
    }
  }
  const capabilityMode =
    input.capabilityMode ??
    agent?.defaultCapabilityMode ??
    role?.defaultCapabilityMode ??
    (type === "general-purpose" ? "all" : "read-only");
  const isolation =
    input.isolation ??
    agent?.isolation ??
    role?.isolation ??
    persona?.isolation ??
    "none";
  const modelId =
    input.modelId?.trim() ||
    agent?.modelId ||
    role?.modelId ||
    persona?.modelId ||
    policies.models[type];
  const reasoningEffort =
    input.reasoningEffort?.trim() ||
    agent?.reasoningEffort ||
    role?.reasoningEffort ||
    persona?.reasoningEffort;
  const permissionMode = agent?.permissionMode;
  // MCP grants belong to the definition, not to the request, so a caller
  // cannot widen them by naming an agent and asking for more tools.
  const mcpTools =
    agent?.mcpTools && agent.mcpTools.length > 0 ? agent.mcpTools : undefined;
  return {
    ...(agent ? { agent } : {}),
    ...(role ? { role } : {}),
    ...(persona ? { persona } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(mcpTools ? { mcpTools } : {}),
    isolation,
    capabilityMode,
    ...(permissionMode ? { permissionMode } : {}),
  };
};

/** Compose role/persona guidance once, before the child starts its transcript. */
export const composePiSubagentPrompt = (
  resolution: PiSubagentPolicyResolution,
  task: string,
): string => {
  const sections: string[] = [];
  if (resolution.agent?.instructions) {
    sections.push(
      `<agent-instructions>\n${resolution.agent.instructions}\n</agent-instructions>`,
    );
  }
  if (resolution.role?.instructions) {
    sections.push(
      `<role-instructions>\n${resolution.role.instructions}\n</role-instructions>`,
    );
  }
  if (resolution.persona?.instructions) {
    sections.push(`<persona>\n${resolution.persona.instructions}\n</persona>`);
  }
  sections.push(task);
  return sections.join("\n\n");
};
