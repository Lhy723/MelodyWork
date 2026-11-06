import {
  containsControlCharacters,
  isPermissionMode,
  isRecord,
  optionalString,
  requireString,
} from "./shared.ts";

const MAX_RESOURCE_ROOTS = 64;
const MAX_RESOURCE_DISABLED_NAMES = 256;
const MAX_RESOURCE_NAME_LENGTH = 255;
const MAX_RESOURCE_PATH_LENGTH = 4096;
const MAX_QUESTION_TIMEOUT_MS = 2_147_483_647;
const MAX_SUBAGENT_POLICIES = 128;
const MAX_SUBAGENT_POLICY_NAME_LENGTH = 128;
const MAX_SUBAGENT_INSTRUCTIONS_LENGTH = 32 * 1024;
const MAX_SUBAGENT_MODEL_ID_LENGTH = 256;
const MAX_SUBAGENT_TOGGLES = 256;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;
const MAX_GOAL_STALL_TIMEOUT_SECS = 7 * 24 * 60 * 60;
const MAX_GOAL_BLOCKED_ATTEMPTS = 100;

const validateResourceRoot = (
  value: unknown,
  field: string,
  allowScope: boolean,
) => {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象。 `);
  requireString(value.path, `${field}.path`);
  if (
    typeof value.path !== "string" ||
    value.path.length > MAX_RESOURCE_PATH_LENGTH
  ) {
    throw new Error(
      `${field}.path 不能超过 ${MAX_RESOURCE_PATH_LENGTH} 个字符。`,
    );
  }
  if (allowScope) optionalString(value.scope, `${field}.scope`);
  if (!Array.isArray(value.disabled)) {
    throw new Error(`${field}.disabled 必须是数组。 `);
  }
  if (value.disabled.length > MAX_RESOURCE_DISABLED_NAMES) {
    throw new Error(
      `${field}.disabled 不能超过 ${MAX_RESOURCE_DISABLED_NAMES} 项。`,
    );
  }
  for (const [index, name] of value.disabled.entries()) {
    requireString(name, `${field}.disabled[${index}]`);
    if (typeof name !== "string" || name.length > MAX_RESOURCE_NAME_LENGTH) {
      throw new Error(
        `${field}.disabled[${index}] 不能超过 ${MAX_RESOURCE_NAME_LENGTH} 个字符。`,
      );
    }
  }
};

const subagentCapabilityModes = new Set([
  "read-only",
  "read-write",
  "read-write-execute",
  "execute",
  "all",
]);
const subagentIsolations = new Set(["none", "worktree"]);

const validateSubagentPolicyName = (value: unknown, field: string) => {
  requireString(value, field);
  if (
    typeof value !== "string" ||
    value.length > MAX_SUBAGENT_POLICY_NAME_LENGTH ||
    containsControlCharacters(value)
  ) {
    throw new Error(
      `${field} 不能超过 ${MAX_SUBAGENT_POLICY_NAME_LENGTH} 个字符且不能包含控制字符。`,
    );
  }
};

const validateSubagentOptionalText = (
  value: unknown,
  field: string,
  maxLength: number,
) => {
  if (value === undefined) return;
  requireString(value, field);
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    containsControlCharacters(value)
  ) {
    throw new Error(`${field} 无效或超过大小限制。`);
  }
};

const validateSubagentPolicyEntry = (
  value: unknown,
  field: string,
  persona: boolean,
  agent = false,
) => {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象。 `);
  validateSubagentPolicyName(value.name, `${field}.name`);
  validateSubagentOptionalText(
    value.description,
    `${field}.description`,
    2_000,
  );
  validateSubagentOptionalText(
    value.instructions,
    `${field}.instructions`,
    MAX_SUBAGENT_INSTRUCTIONS_LENGTH,
  );
  if (persona && typeof value.instructions !== "string") {
    throw new Error(`${field}.instructions 必须是字符串。 `);
  }
  if (
    agent &&
    value.permissionMode !== undefined &&
    !isPermissionMode(value.permissionMode)
  ) {
    throw new Error(`${field}.permissionMode 不是受支持的值。 `);
  }
  if (
    value.defaultCapabilityMode !== undefined &&
    !subagentCapabilityModes.has(value.defaultCapabilityMode as string)
  ) {
    throw new Error(`${field}.defaultCapabilityMode 不是受支持的值。 `);
  }
  validateSubagentOptionalText(
    value.modelId,
    `${field}.modelId`,
    MAX_SUBAGENT_MODEL_ID_LENGTH,
  );
  validateSubagentOptionalText(
    value.reasoningEffort,
    `${field}.reasoningEffort`,
    32,
  );
  if (
    value.isolation !== undefined &&
    !subagentIsolations.has(value.isolation as string)
  ) {
    throw new Error(`${field}.isolation 不是受支持的值。 `);
  }
};

const validateSubagentPolicies = (value: unknown) => {
  if (!isRecord(value)) {
    throw new Error(
      "session.resources.refresh.manifest.subagentPolicies 必须是对象。 ",
    );
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error(
      "session.resources.refresh.manifest.subagentPolicies.enabled 必须是布尔值。",
    );
  }
  for (const key of ["roles", "personas", "agents"] as const) {
    const entries = value[key] ?? (key === "agents" ? [] : undefined);
    if (!Array.isArray(entries)) {
      throw new Error(
        `session.resources.refresh.manifest.subagentPolicies.${key} 必须是数组。 `,
      );
    }
    if (entries.length > MAX_SUBAGENT_POLICIES) {
      throw new Error(
        `session.resources.refresh.manifest.subagentPolicies.${key} 不能超过 ${MAX_SUBAGENT_POLICIES} 项。`,
      );
    }
    const names = new Set<string>();
    entries.forEach((entry, index) => {
      validateSubagentPolicyEntry(
        entry,
        `session.resources.refresh.manifest.subagentPolicies.${key}[${index}]`,
        key === "personas",
        key === "agents",
      );
      const name = (entry as Record<string, unknown>).name as string;
      if (names.has(name)) {
        throw new Error(
          `session.resources.refresh.manifest.subagentPolicies.${key} 不能包含重复名称。`,
        );
      }
      names.add(name);
    });
  }
  for (const key of ["models", "toggle"] as const) {
    const values = value[key];
    if (!isRecord(values)) {
      throw new Error(
        `session.resources.refresh.manifest.subagentPolicies.${key} 必须是对象。 `,
      );
    }
    const entries = Object.entries(values);
    if (entries.length > MAX_SUBAGENT_TOGGLES) {
      throw new Error(
        `session.resources.refresh.manifest.subagentPolicies.${key} 不能超过 ${MAX_SUBAGENT_TOGGLES} 项。`,
      );
    }
    for (const [name, entry] of entries) {
      validateSubagentPolicyName(name, `subagentPolicies.${key} 名称`);
      if (key === "models") {
        validateSubagentOptionalText(
          entry,
          `subagentPolicies.models.${name}`,
          MAX_SUBAGENT_MODEL_ID_LENGTH,
        );
      } else if (typeof entry !== "boolean") {
        throw new Error(`subagentPolicies.toggle.${name} 必须是布尔值。 `);
      }
    }
  }
  if (value.unsupportedAgents !== undefined) {
    if (!Array.isArray(value.unsupportedAgents)) {
      throw new Error(
        "session.resources.refresh.manifest.subagentPolicies.unsupportedAgents 必须是数组。 ",
      );
    }
    if (value.unsupportedAgents.length > MAX_SUBAGENT_POLICIES) {
      throw new Error(
        `session.resources.refresh.manifest.subagentPolicies.unsupportedAgents 不能超过 ${MAX_SUBAGENT_POLICIES} 项。`,
      );
    }
    const names = new Set<string>();
    value.unsupportedAgents.forEach((name, index) => {
      validateSubagentPolicyName(
        name,
        `session.resources.refresh.manifest.subagentPolicies.unsupportedAgents[${index}]`,
      );
      if (names.has(name as string)) {
        throw new Error(
          "session.resources.refresh.manifest.subagentPolicies.unsupportedAgents 不能包含重复名称。",
        );
      }
      names.add(name as string);
    });
  }
};

const validateGoalPolicy = (value: unknown) => {
  if (!isRecord(value)) {
    throw new Error(
      "session.resources.refresh.manifest.goalPolicy 必须是对象。",
    );
  }
  if (
    value.stallDetection !== undefined &&
    typeof value.stallDetection !== "boolean"
  ) {
    throw new Error(
      "session.resources.refresh.manifest.goalPolicy.stallDetection 必须是布尔值。",
    );
  }
  for (const [key, max] of [
    ["tokenBudget", MAX_GOAL_TOKEN_BUDGET],
    ["stallTimeoutSecs", MAX_GOAL_STALL_TIMEOUT_SECS],
    ["maxBlockedAttempts", MAX_GOAL_BLOCKED_ATTEMPTS],
  ] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        value[key] < 1 ||
        value[key] > max)
    ) {
      throw new Error(
        `session.resources.refresh.manifest.goalPolicy.${key} 必须是 1-${max} 的整数。`,
      );
    }
  }
};

export const validateResourceManifest = (value: unknown) => {
  if (!isRecord(value))
    throw new Error("session.resources.refresh.manifest 必须是对象。 ");
  requireString(value.cwd, "session.resources.refresh.manifest.cwd");
  if (
    typeof value.cwd !== "string" ||
    value.cwd.length > MAX_RESOURCE_PATH_LENGTH
  ) {
    throw new Error(
      `session.resources.refresh.manifest.cwd 不能超过 ${MAX_RESOURCE_PATH_LENGTH} 个字符。`,
    );
  }
  for (const [key, allowScope] of [
    ["skillRoots", true],
    ["promptRoots", false],
  ] as const) {
    const roots = value[key];
    if (!Array.isArray(roots)) {
      throw new Error(
        `session.resources.refresh.manifest.${key} 必须是数组。 `,
      );
    }
    if (roots.length > MAX_RESOURCE_ROOTS) {
      throw new Error(
        `session.resources.refresh.manifest.${key} 不能超过 ${MAX_RESOURCE_ROOTS} 项。`,
      );
    }
    roots.forEach((root, index) =>
      validateResourceRoot(
        root,
        `session.resources.refresh.manifest.${key}[${index}]`,
        allowScope,
      ),
    );
  }
  if (value.questionTimeoutPolicy !== undefined) {
    if (!isRecord(value.questionTimeoutPolicy)) {
      throw new Error(
        "session.resources.refresh.manifest.questionTimeoutPolicy 必须是对象。",
      );
    }
    if (typeof value.questionTimeoutPolicy.enabled !== "boolean") {
      throw new Error(
        "session.resources.refresh.manifest.questionTimeoutPolicy.enabled 必须是布尔值。",
      );
    }
    if (
      typeof value.questionTimeoutPolicy.timeoutMs !== "number" ||
      !Number.isSafeInteger(value.questionTimeoutPolicy.timeoutMs) ||
      value.questionTimeoutPolicy.timeoutMs < 1 ||
      value.questionTimeoutPolicy.timeoutMs > MAX_QUESTION_TIMEOUT_MS
    ) {
      throw new Error(
        `session.resources.refresh.manifest.questionTimeoutPolicy.timeoutMs 必须是 1-${MAX_QUESTION_TIMEOUT_MS} 的整数。`,
      );
    }
  }
  if (value.subagentPolicies !== undefined) {
    validateSubagentPolicies(value.subagentPolicies);
  }
  if (value.goalPolicy !== undefined) {
    validateGoalPolicy(value.goalPolicy);
  }
};
