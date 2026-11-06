import { containsControlCharacters } from "./contract.ts";

type ConfigSnapshot = { values: unknown };

export interface PiConfigCapabilityPolicies {
  sandbox: {
    configured: boolean;
    configuredByEnvironment: boolean;
  };
  codebaseIndexPolicyInvalid: boolean;
  externalAuthCommandConfigured: boolean;
  oidcConfigured: boolean;
  subagentDefinitionPolicyUnsupported: boolean;
  terminalPolicyInvalid: boolean;
  questionTimeoutPolicyInvalid: boolean;
  lspConfigPresent: boolean;
  semanticMemoryNeedsDegradation: boolean;
  advancedGoalOrchestrationConfigured: boolean;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const objectHasEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  const record = recordValue(value);
  return Boolean(record && Object.keys(record).length > 0);
};

const valueAtKey = (value: unknown, key: string): unknown => {
  const record = recordValue(value);
  return record?.[key];
};

const valueAtPath = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => valueAtKey(current, key), value);

const hasConfiguredSection = (
  snapshots: ConfigSnapshot[],
  keys: string[],
  predicate: (value: unknown) => boolean = objectHasEntries,
): boolean =>
  snapshots.some((snapshot) =>
    keys.some((key) => predicate(valueAtKey(snapshot.values, key))),
  );

const hasConfiguredPath = (
  snapshots: ConfigSnapshot[],
  paths: string[][],
  predicate: (value: unknown) => boolean = objectHasEntries,
): boolean =>
  snapshots.some((snapshot) =>
    paths.some((path) => predicate(valueAtPath(snapshot.values, path))),
  );

const memoryIsEnabled = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  const record = recordValue(value);
  if (!record) return false;
  // `enabled = false` is an explicit opt-out in Melody-build. Nested
  // lifecycle settings must not accidentally re-enable the entire feature.
  if (record.enabled === false) return false;
  // A non-empty memory table without an explicit `enabled = false` uses
  // Melody's enabled-by-configuration default and must not be silently lost.
  return Object.keys(record).length > 0;
};

/**
 * Pi keeps the bounded Markdown memory lifecycle and compaction flush; only
 * semantic/vector indexing and dream consolidation are unavailable.
 */
const memoryNeedsPiDegradation = (value: unknown): boolean => {
  if (!memoryIsEnabled(value)) return false;
  const memory = recordValue(value);
  const embedding = recordValue(memory?.embedding);
  if (
    embedding &&
    (configuredString(embedding.model) || embedding.dimensions !== undefined)
  ) {
    return true;
  }
  return objectHasEntries(memory?.dream);
};

/** Pi projects deterministic goal safety rails but not autonomous orchestration. */
const hasUnsupportedGoalOrchestration = (value: unknown): boolean => {
  const goal = recordValue(value);
  if (!goal) return false;
  const advancedKeys = [
    "classifier_enabled",
    "classifierEnabled",
    "planner_enabled",
    "plannerEnabled",
    "verification_enabled",
    "verificationEnabled",
    "verifier_enabled",
    "verifierEnabled",
    "classifier_max_runs",
    "classifierMaxRuns",
    "max_classifier_runs",
    "maxClassifierRuns",
    "retry_limit",
    "retryLimit",
    "max_retries",
    "maxRetries",
    "budget",
    "planner_model",
    "plannerModel",
    "strategist_model",
    "strategistModel",
    "skeptic_model",
    "skepticModel",
    "skeptic_models",
    "skepticModels",
    "completion_gate",
    "completionGate",
    "adversarial_verification",
    "adversarialVerification",
  ];
  return advancedKeys.some((key) => {
    const candidate = goal[key];
    if (candidate === undefined || candidate === null) return false;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) && candidate > 0;
    }
    if (typeof candidate === "string") return candidate.trim().length > 0;
    return objectHasEntries(candidate);
  });
};

const hasAdvancedGoalOrchestration = (snapshots: ConfigSnapshot[]): boolean =>
  snapshots.some((snapshot) => {
    const root = recordValue(snapshot.values);
    if (!root) return false;
    if (hasUnsupportedGoalOrchestration(root.goal)) return true;
    if (hasUnsupportedGoalOrchestration(root.goal_orchestration)) return true;
    return [
      "goal_classifier_enabled",
      "goal_planner_enabled",
      "goal_verification_enabled",
      "goal_retry_limit",
    ].some((key) => {
      const candidate = root[key];
      if (candidate === undefined || candidate === null) return false;
      if (typeof candidate === "boolean") return candidate;
      if (typeof candidate === "number") {
        return Number.isFinite(candidate) && candidate > 0;
      }
      if (typeof candidate === "string") return candidate.trim().length > 0;
      return objectHasEntries(candidate);
    });
  });

const MAX_CODEBASE_INDEX_PATTERNS = 64;
const MAX_CODEBASE_INDEX_PATTERN_BYTES = 512;

/**
 * The Host tree-sitter bridge supports the default switch and bounded path
 * globs; malformed values must not be silently ignored.
 */
const codebaseIndexingPolicyInvalid = (value: unknown): boolean => {
  if (
    value === undefined ||
    value === null ||
    value === false ||
    value === true
  ) {
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CODEBASE_INDEX_PATTERNS) return true;
    return value.some((entry) => {
      if (typeof entry !== "string") return true;
      const pattern = entry.trim();
      if (
        pattern.length === 0 ||
        pattern.length > MAX_CODEBASE_INDEX_PATTERN_BYTES ||
        containsControlCharacters(pattern)
      ) {
        return true;
      }
      const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
      if (!body) return true;
      let characterClassDepth = 0;
      for (const character of body) {
        if (character === "[") characterClassDepth += 1;
        if (character === "]") characterClassDepth -= 1;
        if (characterClassDepth < 0) return true;
      }
      return characterClassDepth !== 0;
    });
  }
  const record = recordValue(value);
  return record ? Object.keys(record).length > 0 : true;
};

const configuredString = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

/** Terminal values can be projected only when positive finite numbers. */
const invalidTerminalPolicyValue = (value: unknown): boolean =>
  value !== undefined &&
  (typeof value !== "number" || !Number.isFinite(value) || value <= 0);

const invalidQuestionTimeoutEnabledValue = (value: unknown): boolean =>
  value !== undefined && typeof value !== "boolean";

const invalidQuestionTimeoutSecondsValue = (value: unknown): boolean =>
  value !== undefined &&
  (typeof value !== "number" || !Number.isFinite(value) || value <= 0);

/**
 * Pi projects declarative agent settings; dynamic tool-graph/prompt surfaces
 * remain outside the bounded Host manifest.
 */
const SAFE_AGENT_DEFINITION_KEYS = new Set([
  "name",
  "description",
  "model",
  "modelId",
  "model_id",
  "effort",
  "reasoningEffort",
  "reasoning_effort",
  "capabilityMode",
  "capability_mode",
  "defaultCapabilityMode",
  "default_capability_mode",
  "isolation",
  "defaultIsolation",
  "default_isolation",
  "permissionMode",
  "permission_mode",
  "instructions",
  "prompt",
  "prompt_file",
  "promptFile",
  // The Host resolves a tool allowlist into the narrowest Pi capability
  // ceiling; a list it cannot bound makes the definition unavailable and is
  // reported through the Host inventory, not through this key allowlist.
  "tools",
  "disallowedTools",
  "disallowed_tools",
]);

const agentDefinitionEntryUnsupported = (value: unknown): boolean => {
  const record = recordValue(value);
  if (!record) return true;
  return Object.keys(record).some(
    (key) => !SAFE_AGENT_DEFINITION_KEYS.has(key),
  );
};

const unsupportedAgentDefinitions = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(agentDefinitionEntryUnsupported);
  }
  const record = recordValue(value);
  if (!record || Object.keys(record).length === 0) return false;
  // A single inline definition may itself be supplied as an object.
  if (Object.keys(record).some((key) => SAFE_AGENT_DEFINITION_KEYS.has(key))) {
    return agentDefinitionEntryUnsupported(record);
  }
  // The common TOML shape is [subagents.agents.<name>]. Treat each value as
  // an independent definition and fail closed for scalar/nested dynamic data.
  return Object.values(record).some(agentDefinitionEntryUnsupported);
};

const unsupportedSubagentPolicy = (value: unknown): boolean => {
  const record = recordValue(value);
  if (!record) return false;
  return ["agents", "agent_definitions", "agentDefinitions"].some((key) =>
    unsupportedAgentDefinitions(record[key]),
  );
};

/** Active OS-level sandbox profiles are a security boundary, not a degradation. */
const configuredSandbox = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized.length > 0 && !["off", "false", "none"].includes(normalized)
    );
  }
  if (value === true) return true;
  const record = recordValue(value);
  if (!record) return false;
  if ("profile" in record) {
    return configuredSandbox(record.profile);
  }
  if (record.enabled === false) return false;
  return Object.entries(record).some(
    ([key, nested]) => key !== "enabled" && configuredSandbox(nested),
  );
};

/**
 * Classify the config-derived Pi compatibility boundary once, independently
 * of Host-projected runtime inventories. The report composer decides where
 * each resulting policy appears in the final diagnostic order.
 */
export const inspectPiConfigCapabilityPolicies = (
  configs: ConfigSnapshot[],
  environment?: { sandboxProfile?: string },
): PiConfigCapabilityPolicies => {
  const sandboxConfiguredByEnvironment = configuredSandbox(
    environment?.sandboxProfile,
  );
  const sandboxConfiguredByConfig = hasConfiguredSection(
    configs,
    ["sandbox"],
    configuredSandbox,
  );
  return {
    sandbox: {
      configured: sandboxConfiguredByConfig || sandboxConfiguredByEnvironment,
      configuredByEnvironment: sandboxConfiguredByEnvironment,
    },
    codebaseIndexPolicyInvalid: hasConfiguredPath(
      configs,
      [["features", "codebase_indexing"]],
      codebaseIndexingPolicyInvalid,
    ),
    externalAuthCommandConfigured: hasConfiguredPath(
      configs,
      [
        ["auth", "auth_provider_command"],
        ["grok_com_config", "auth_provider_command"],
      ],
      configuredString,
    ),
    oidcConfigured: hasConfiguredPath(
      configs,
      [
        ["grok_com_config", "oidc"],
        ["auth", "oidc"],
      ],
      objectHasEntries,
    ),
    subagentDefinitionPolicyUnsupported: hasConfiguredPath(
      configs,
      [["subagents"]],
      unsupportedSubagentPolicy,
    ),
    terminalPolicyInvalid: hasConfiguredPath(
      configs,
      [
        ["toolset", "bash", "timeout_secs"],
        ["toolset", "bash", "max_timeout_secs"],
        ["toolset", "bash", "output_byte_limit"],
      ],
      invalidTerminalPolicyValue,
    ),
    questionTimeoutPolicyInvalid:
      hasConfiguredPath(
        configs,
        [["toolset", "ask_user_question", "timeout_enabled"]],
        invalidQuestionTimeoutEnabledValue,
      ) ||
      hasConfiguredPath(
        configs,
        [["toolset", "ask_user_question", "timeout_secs"]],
        invalidQuestionTimeoutSecondsValue,
      ),
    lspConfigPresent:
      hasConfiguredSection(configs, [
        "lsp_servers",
        "lspServers",
        "lsp",
        "lsps",
      ]) ||
      hasConfiguredPath(
        configs,
        [["features", "lsp_tools"]],
        (value) => value === true,
      ),
    semanticMemoryNeedsDegradation: hasConfiguredSection(
      configs,
      ["memory"],
      memoryNeedsPiDegradation,
    ),
    advancedGoalOrchestrationConfigured: hasAdvancedGoalOrchestration(configs),
  };
};
