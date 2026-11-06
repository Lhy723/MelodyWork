import type {
  AgentSubagentCapabilityMode,
  AgentSubagentAgentPolicy,
  AgentSubagentIsolation,
  AgentSubagentPersonaPolicy,
  AgentSubagentPolicyManifest,
  AgentSubagentRolePolicy,
} from "@melody/agent-contract";
import {
  createPiSubagentPolicyError as policyError,
  isPiSubagentType,
  normalizePiSubagentCapabilityMode,
  normalizePiSubagentIsolation,
  normalizePiSubagentPolicyManifest,
  normalizePiSubagentType,
} from "./subagent-policy-normalization.ts";
import type {
  PiSubagentIsolation,
  PiSubagentType,
} from "./subagent-policy-normalization.ts";
import {
  intersectPiSubagentCapabilityModes,
  type PiSubagentCapabilityMode,
} from "./tool-access-policy.ts";

export {
  emptyPiSubagentPolicyManifest,
  isPiSubagentType,
  normalizePiSubagentCapabilityMode,
  normalizePiSubagentIsolation,
  normalizePiSubagentPolicyManifest,
  normalizePiSubagentType,
} from "./subagent-policy-normalization.ts";
export type {
  PiSubagentIsolation,
  PiSubagentType,
} from "./subagent-policy-normalization.ts";

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

/** Default capability ceiling for the built-in worker subagent types. */
export const defaultPiSubagentCapabilityMode = (
  subagentType: string,
): AgentSubagentCapabilityMode =>
  subagentType === "general-purpose" ? "all" : "read-only";

type PiPermissionMode = NonNullable<
  PiSubagentPolicyResolution["permissionMode"]
>;

const permissionModeRank: Record<PiPermissionMode, number> = {
  ask: 0,
  auto: 1,
  "always-approve": 2,
};

/** A child cannot request a less restrictive approval mode than its parent. */
export const intersectPiPermissionModes = (
  parent: PiPermissionMode,
  requested?: PiPermissionMode,
): PiPermissionMode => {
  if (!requested) return parent;
  return permissionModeRank[requested] <= permissionModeRank[parent]
    ? requested
    : parent;
};

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
    defaultPiSubagentCapabilityMode(type);
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

export interface PiSubagentLaunchPolicyRequest {
  subagentType?: unknown;
  role?: string;
  persona?: string;
  agent?: string;
  capabilityMode?: unknown;
  isolation?: unknown;
  modelId?: string;
  reasoningEffort?: string;
}

export interface PiSubagentResumePolicy {
  subagentType?: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
  capabilityMode?: unknown;
  isolation?: unknown;
  mcpTools?: Iterable<string>;
  permissionMode?: PiPermissionMode;
  modelId?: string;
  reasoningEffort?: string;
}

export interface PiSubagentLaunchPolicyInput {
  manifest: AgentSubagentPolicyManifest;
  request: PiSubagentLaunchPolicyRequest;
  parent: {
    capabilityMode: PiSubagentCapabilityMode;
    permissionMode: PiPermissionMode;
    mcpTools?: ReadonlySet<string>;
    modelId?: string;
    reasoningEffort?: string;
  };
  resume?: PiSubagentResumePolicy;
}

export interface PiSubagentLaunchPolicy {
  subagentType: PiSubagentType;
  role?: string;
  persona?: string;
  agent?: string;
  capabilityMode: PiSubagentCapabilityMode;
  permissionMode: PiPermissionMode;
  isolation: PiSubagentIsolation;
  /** Undefined only when the child has the unrestricted `all` capability. */
  mcpTools?: ReadonlySet<string>;
  requestedModelId?: string;
  requestedReasoningEffort?: string;
  /** Fresh launches compose policy instructions; resumed transcripts do not. */
  policyResolution?: PiSubagentPolicyResolution;
}

/**
 * Resolve the pure policy projection for a child launch. The caller supplies
 * snapshots of the request, parent, and optional durable child state; session
 * creation, Host worktree calls, and task/event lifecycle remain outside.
 */
export const resolvePiSubagentLaunchPolicy = (
  input: PiSubagentLaunchPolicyInput,
): PiSubagentLaunchPolicy => {
  const policies = normalizePiSubagentPolicyManifest(input.manifest);
  const requestedType = input.request.subagentType;
  const requestedName =
    typeof requestedType === "string" ? requestedType.trim() : "";
  const requestedTypeIsBuiltIn =
    typeof requestedType === "string" && isPiSubagentType(requestedType);
  let subagentType: PiSubagentType;
  let requestedRole = input.request.role;
  let requestedAgent = input.request.agent;

  if (input.resume) {
    subagentType = input.resume.subagentType ?? "general-purpose";
  } else if (
    requestedName &&
    !requestedTypeIsBuiltIn &&
    (policies.agents.some((candidate) => candidate.name === requestedName) ||
      policies.roles.some((candidate) => candidate.name === requestedName))
  ) {
    // Older Melody callers sometimes put a named definition in
    // `subagent_type`; preserve that compatibility without accepting an
    // arbitrary type or changing the selected role/agent.
    subagentType = "general-purpose";
    if (policies.agents.some((candidate) => candidate.name === requestedName)) {
      requestedAgent ??= requestedName;
    } else {
      requestedRole ??= requestedName;
    }
  } else {
    subagentType = normalizePiSubagentType(requestedType);
  }

  const policyResolution = input.resume
    ? undefined
    : resolvePiSubagentPolicy(policies, {
        subagentType,
        role: requestedRole,
        persona: input.request.persona,
        agent: requestedAgent,
        modelId: input.request.modelId,
        reasoningEffort: input.request.reasoningEffort,
        isolation: normalizePiSubagentIsolation(input.request.isolation),
        capabilityMode: normalizePiSubagentCapabilityMode(
          input.request.capabilityMode,
        ),
      });
  // Keep validating an explicit request even when durable resume state owns
  // the effective isolation. The prior launch path rejected malformed values
  // before choosing the persisted boundary.
  if (input.resume) {
    normalizePiSubagentIsolation(input.request.isolation);
  }
  const requestedCapabilityMode = input.resume
    ? normalizePiSubagentCapabilityMode(
        input.request.capabilityMode ?? input.resume.capabilityMode,
      )
    : policyResolution?.capabilityMode;
  const capabilityMode =
    intersectPiSubagentCapabilityModes(
      requestedCapabilityMode,
      intersectPiSubagentCapabilityModes(
        defaultPiSubagentCapabilityMode(subagentType),
        input.parent.capabilityMode,
      ),
    ) ?? "read-only";
  const isolation = input.resume
    ? (normalizePiSubagentIsolation(input.resume.isolation) ?? "none")
    : (policyResolution?.isolation ?? "none");
  const requestedMcpTools = input.resume
    ? Array.from(input.resume.mcpTools ?? [])
    : (policyResolution?.mcpTools ?? []);
  const mcpTools =
    capabilityMode === "all"
      ? undefined
      : new Set(
          requestedMcpTools.filter((tool) =>
            input.parent.capabilityMode === "all"
              ? true
              : (input.parent.mcpTools?.has(tool) ?? false),
          ),
        );
  const permissionMode = intersectPiPermissionModes(
    input.parent.permissionMode,
    input.resume?.permissionMode ?? policyResolution?.permissionMode,
  );
  const requestedModelId =
    input.resume?.modelId ??
    policyResolution?.modelId ??
    input.request.modelId ??
    input.parent.modelId;
  const requestedReasoningEffort =
    input.resume?.reasoningEffort ??
    policyResolution?.reasoningEffort ??
    input.request.reasoningEffort ??
    input.parent.reasoningEffort;
  const role = input.resume?.role ?? policyResolution?.role?.name;
  const persona = input.resume?.persona ?? policyResolution?.persona?.name;
  const agent = input.resume?.agent ?? policyResolution?.agent?.name;

  return {
    subagentType,
    ...(role ? { role } : {}),
    ...(persona ? { persona } : {}),
    ...(agent ? { agent } : {}),
    capabilityMode,
    permissionMode,
    isolation,
    ...(mcpTools ? { mcpTools } : {}),
    ...(requestedModelId ? { requestedModelId } : {}),
    ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
    ...(policyResolution ? { policyResolution } : {}),
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
