import {
  AGENT_PROTOCOL_VERSION,
  type AgentCommand,
  type AgentCommandEnvelope,
  type AgentRunConfig,
} from "./index.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reject C0 controls and DEL in identifiers, paths, patterns, and prompts.
 *
 * A control character never appears in a legitimate value at this boundary and
 * can smuggle a NUL or newline past a consumer that compares or logs the text.
 * This is one shared predicate so the host, the worker, and the renderer all
 * apply the same rule.
 */
export const containsControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
};

/**
 * Remove C0 controls and DEL from text that will be embedded in a prompt.
 *
 * This is the sanitizing counterpart of `containsControlCharacters`: the
 * predicate rejects hostile input at a validation boundary, while this keeps
 * `\n`/`\t` and drops everything else so terminal escape sequences cannot ride
 * into a model prompt.
 */
export const withoutControlCharacters = (
  value: string,
  keep = "\n\t",
): string => {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint < 0x20 || codePoint === 0x7f) && !keep.includes(character)) {
      continue;
    }
    sanitized += character;
  }
  return sanitized;
};

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_TASK_CONTINUE_CODEPOINTS = 12_000;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_IMPORT_PLAN_BYTES = 2 * 1024 * 1024;
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
const MAX_MODEL_CREDENTIALS = 512;
const MAX_MODEL_PROVIDER_IDS = 128;
const MAX_MODEL_CREDENTIAL_NAME_LENGTH = 255;
const MAX_MODEL_CREDENTIAL_VALUE_LENGTH = 16_384;

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  return value;
};

const optionalString = (value: unknown, field: string) => {
  if (value !== undefined) requireString(value, field);
};

const permissionModes = new Set<AgentRunConfig["permissionMode"]>([
  "ask",
  "auto",
  "always-approve",
]);

const validatePermissionMode = (value: unknown, field: string) => {
  if (!permissionModes.has(value as AgentRunConfig["permissionMode"])) {
    throw new Error(`${field} 不是受支持的权限模式。`);
  }
};

const validateAttachments = (value: unknown) => {
  if (!Array.isArray(value)) {
    throw new Error("turn.submit.attachments 必须是数组。 ");
  }
  for (const [index, attachment] of value.entries()) {
    if (!isRecord(attachment)) throw new Error(`附件 ${index + 1} 不是对象。`);
    requireString(attachment.url, `附件 ${index + 1} 的 url`);
    requireString(attachment.mediaType, `附件 ${index + 1} 的 mediaType`);
    optionalString(attachment.filename, `附件 ${index + 1} 的 filename`);
  }
};

const validateRunConfig = (value: unknown) => {
  if (!isRecord(value)) throw new Error("turn.submit.config 必须是对象。 ");
  optionalString(value.modelId, "turn.submit.config.modelId");
  optionalString(value.reasoningEffort, "turn.submit.config.reasoningEffort");
  optionalString(value.sessionModeId, "turn.submit.config.sessionModeId");
  validatePermissionMode(
    value.permissionMode,
    "turn.submit.config.permissionMode",
  );
  if (
    typeof value.configRevision !== "number" ||
    !Number.isSafeInteger(value.configRevision) ||
    value.configRevision < 0
  ) {
    throw new Error("turn.submit.config.configRevision 必须是非负整数。 ");
  }
};

const validateAgentError = (value: unknown, field: string) => {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象。 `);
  requireString(value.code, `${field}.code`);
  requireString(value.message, `${field}.message`);
  if (typeof value.retriable !== "boolean") {
    throw new Error(`${field}.retriable 必须是布尔值。 `);
  }
  optionalString(value.diagnosticId, `${field}.diagnosticId`);
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error(`${field}.details 必须是对象。 `);
  }
};

const validateToolResolution = (value: unknown) => {
  if (!isRecord(value))
    throw new Error("tool.resolve.resolution 必须是对象。 ");
  if (!["completed", "failed", "cancelled"].includes(value.status as string)) {
    throw new Error("tool.resolve.resolution.status 不是受支持的值。 ");
  }
  if (value.output !== undefined && typeof value.output !== "string") {
    throw new Error("tool.resolve.resolution.output 必须是字符串。 ");
  }
  if (value.error !== undefined) {
    validateAgentError(value.error, "tool.resolve.resolution.error");
  }
  if (value.status === "completed" && value.error !== undefined) {
    throw new Error("成功的 tool.resolve 不能同时包含 error。 ");
  }
  if (value.status !== "completed" && value.error === undefined) {
    throw new Error("失败或取消的 tool.resolve 必须包含 error。 ");
  }
};

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
    !permissionModes.has(
      value.permissionMode as AgentRunConfig["permissionMode"],
    )
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

const validateResourceManifest = (value: unknown) => {
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

const validateModelSync = (value: unknown) => {
  if (!isRecord(value)) {
    throw new Error("runtime.models.sync 必须是对象。 ");
  }
  if (!Array.isArray(value.providerIds)) {
    throw new Error("runtime.models.sync.providerIds 必须是数组。 ");
  }
  if (value.providerIds.length > MAX_MODEL_PROVIDER_IDS) {
    throw new Error(
      `runtime.models.sync.providerIds 不能超过 ${MAX_MODEL_PROVIDER_IDS} 项。`,
    );
  }
  const providerIds = new Set<string>();
  for (const [index, providerId] of value.providerIds.entries()) {
    requireString(providerId, `runtime.models.sync.providerIds[${index}]`);
    if (
      typeof providerId !== "string" ||
      providerId.length > MAX_MODEL_CREDENTIAL_NAME_LENGTH
    ) {
      throw new Error(
        `runtime.models.sync.providerIds[${index}] 不能超过 ${MAX_MODEL_CREDENTIAL_NAME_LENGTH} 个字符。`,
      );
    }
    if (providerIds.has(providerId)) {
      throw new Error("runtime.models.sync.providerIds 不能包含重复项。 ");
    }
    providerIds.add(providerId);
  }
  if (!Array.isArray(value.credentials)) {
    throw new Error("runtime.models.sync.credentials 必须是数组。 ");
  }
  if (value.credentials.length > MAX_MODEL_CREDENTIALS) {
    throw new Error(
      `runtime.models.sync.credentials 不能超过 ${MAX_MODEL_CREDENTIALS} 项。`,
    );
  }
  const names = new Set<string>();
  for (const [index, credential] of value.credentials.entries()) {
    if (!isRecord(credential)) {
      throw new Error(
        `runtime.models.sync.credentials[${index}] 必须是对象。 `,
      );
    }
    requireString(
      credential.name,
      `runtime.models.sync.credentials[${index}].name`,
    );
    if (
      typeof credential.name !== "string" ||
      credential.name.length > MAX_MODEL_CREDENTIAL_NAME_LENGTH
    ) {
      throw new Error(
        `runtime.models.sync.credentials[${index}].name 不能超过 ${MAX_MODEL_CREDENTIAL_NAME_LENGTH} 个字符。`,
      );
    }
    if (!credential.name.startsWith("MELODY_PI_MODEL_")) {
      throw new Error(
        "runtime.models.sync.credentials.name 必须是 Host 生成的 Pi 模型变量。",
      );
    }
    if (names.has(credential.name)) {
      throw new Error("runtime.models.sync.credentials 不能包含重复变量。 ");
    }
    names.add(credential.name);
    if (typeof credential.value !== "string") {
      throw new Error(
        `runtime.models.sync.credentials[${index}].value 必须是字符串。 `,
      );
    }
    if (credential.value.length > MAX_MODEL_CREDENTIAL_VALUE_LENGTH) {
      throw new Error(
        `runtime.models.sync.credentials[${index}].value 不能超过 ${MAX_MODEL_CREDENTIAL_VALUE_LENGTH} 个字符。`,
      );
    }
  }
};

const validateCommand = (command: AgentCommand) => {
  if (!isRecord(command) || typeof command.type !== "string") {
    throw new Error("agent command 必须包含 type。 ");
  }
  switch (command.type) {
    case "runtime.health":
      optionalString(command.sessionId, "runtime.health.sessionId");
      optionalString(command.clientType, "runtime.health.clientType");
      optionalString(command.clientVersion, "runtime.health.clientVersion");
      if (
        command.clientCapabilities !== undefined &&
        !isRecord(command.clientCapabilities)
      ) {
        throw new Error("runtime.health.clientCapabilities 必须是对象。 ");
      }
      if (
        command.startupHints !== undefined &&
        !isRecord(command.startupHints)
      ) {
        throw new Error("runtime.health.startupHints 必须是对象。 ");
      }
      return;
    case "runtime.shutdown":
      if (
        command.reason !== undefined &&
        command.reason !== "stop" &&
        command.reason !== "app-close"
      ) {
        throw new Error("runtime.shutdown.reason 不是受支持的值。 ");
      }
      return;
    case "runtime.authenticate":
      requireString(command.methodId, "runtime.authenticate.methodId");
      if (
        command.headless !== undefined &&
        typeof command.headless !== "boolean"
      ) {
        throw new Error("runtime.authenticate.headless 必须是布尔值。 ");
      }
      optionalString(command.providerId, "runtime.authenticate.providerId");
      if (command.apiKey !== undefined) {
        requireString(command.apiKey, "runtime.authenticate.apiKey");
        if (command.apiKey.length > MAX_API_KEY_LENGTH) {
          throw new Error(
            `runtime.authenticate.apiKey 不能超过 ${MAX_API_KEY_LENGTH} 个字符。`,
          );
        }
      }
      if (
        command.action !== undefined &&
        !["setApiKey", "removeApiKey", "status"].includes(command.action)
      ) {
        throw new Error("runtime.authenticate.action 不是受支持的值。 ");
      }
      if (
        command.action === "setApiKey" &&
        (!command.providerId || command.apiKey === undefined)
      ) {
        throw new Error("setApiKey 必须同时提供 providerId 和 apiKey。 ");
      }
      if (command.action === "removeApiKey" && !command.providerId) {
        throw new Error("removeApiKey 必须提供 providerId。 ");
      }
      return;
    case "runtime.models.list":
      optionalString(command.sessionId, "runtime.models.list.sessionId");
      if (
        command.refresh !== undefined &&
        typeof command.refresh !== "boolean"
      ) {
        throw new Error("runtime.models.list.refresh 必须是布尔值。 ");
      }
      return;
    case "runtime.models.sync":
      validateModelSync(command);
      return;
    case "session.open":
      optionalString(command.sessionId, "session.open.sessionId");
      optionalString(command.productSessionId, "session.open.productSessionId");
      requireString(command.cwd, "session.open.cwd");
      optionalString(command.modelId, "session.open.modelId");
      optionalString(command.reasoningEffort, "session.open.reasoningEffort");
      optionalString(command.cursor, "session.open.cursor");
      validatePermissionMode(
        command.permissionMode,
        "session.open.permissionMode",
      );
      return;
    case "session.close":
      requireString(command.sessionId, "session.close.sessionId");
      return;
    case "session.fork":
      requireString(command.sessionId, "session.fork.sessionId");
      requireString(command.targetSessionId, "session.fork.targetSessionId");
      requireString(command.cwd, "session.fork.cwd");
      requireString(command.nativeEntryId, "session.fork.nativeEntryId");
      if (command.sessionId === command.targetSessionId) {
        throw new Error("session.fork 不能把源会话作为目标会话。 ");
      }
      return;
    case "session.import": {
      requireString(command.sessionId, "session.import.sessionId");
      requireString(command.migrationId, "session.import.migrationId");
      requireString(command.cwd, "session.import.cwd");
      optionalString(command.modelId, "session.import.modelId");
      optionalString(command.reasoningEffort, "session.import.reasoningEffort");
      if (command.permissionMode !== undefined) {
        validatePermissionMode(
          command.permissionMode,
          "session.import.permissionMode",
        );
      }
      if (!isRecord(command.plan)) {
        throw new Error("session.import.plan 必须是对象。 ");
      }
      const serialized = JSON.stringify(command.plan);
      if (serialized.length > MAX_IMPORT_PLAN_BYTES) {
        throw new Error(
          `session.import.plan 不能超过 ${MAX_IMPORT_PLAN_BYTES} 字节。`,
        );
      }
      if (typeof command.backup !== "boolean") {
        throw new Error("session.import.backup 必须是布尔值。 ");
      }
      return;
    }
    case "session.configure": {
      requireString(command.sessionId, "session.configure.sessionId");
      if (
        command.expectedRevision !== undefined &&
        (typeof command.expectedRevision !== "number" ||
          !Number.isSafeInteger(command.expectedRevision) ||
          command.expectedRevision < 0)
      ) {
        throw new Error("session.configure.expectedRevision 必须是非负整数。 ");
      }
      optionalString(command.modelId, "session.configure.modelId");
      optionalString(
        command.reasoningEffort,
        "session.configure.reasoningEffort",
      );
      optionalString(command.sessionModeId, "session.configure.sessionModeId");
      if (command.permissionMode !== undefined) {
        validatePermissionMode(
          command.permissionMode,
          "session.configure.permissionMode",
        );
      }
      const hasModelChange =
        command.modelId !== undefined || command.reasoningEffort !== undefined;
      const hasModeChange = command.sessionModeId !== undefined;
      const hasPermissionChange = command.permissionMode !== undefined;
      if (
        Number(hasModelChange) +
          Number(hasModeChange) +
          Number(hasPermissionChange) !==
        1
      ) {
        throw new Error(
          "session.configure 必须只包含模型、会话模式或权限模式中的一种变更。",
        );
      }
      if (
        command.reasoningEffort !== undefined &&
        command.modelId === undefined
      ) {
        throw new Error(
          "session.configure.reasoningEffort 必须和 modelId 一起提供。 ",
        );
      }
      return;
    }
    case "session.resources.refresh":
      validateResourceManifest(command.manifest);
      return;
    case "turn.submit":
      requireString(command.sessionId, "turn.submit.sessionId");
      requireString(command.promptId, "turn.submit.promptId");
      if (typeof command.content !== "string")
        throw new Error("turn.submit.content 必须是字符串。 ");
      validateAttachments(command.attachments);
      if (
        command.streamingBehavior !== undefined &&
        command.streamingBehavior !== "steer" &&
        command.streamingBehavior !== "followUp"
      ) {
        throw new Error("turn.submit.streamingBehavior 不是受支持的值。 ");
      }
      validateRunConfig(command.config);
      return;
    case "turn.steer":
    case "turn.follow_up":
      requireString(command.sessionId, `${command.type}.sessionId`);
      requireString(command.runId, `${command.type}.runId`);
      if (typeof command.content !== "string")
        throw new Error(`${command.type}.content 必须是字符串。 `);
      return;
    case "turn.cancel":
      requireString(command.sessionId, "turn.cancel.sessionId");
      optionalString(command.promptId, "turn.cancel.promptId");
      optionalString(command.runId, "turn.cancel.runId");
      if (typeof command.cancelSubagents !== "boolean")
        throw new Error("turn.cancel.cancelSubagents 必须是布尔值。 ");
      if (!["user", "timeout", "shutdown"].includes(command.reason))
        throw new Error("turn.cancel.reason 不是受支持的值。 ");
      return;
    case "interaction.resolve":
      requireString(command.sessionId, "interaction.resolve.sessionId");
      requireString(command.interactionId, "interaction.resolve.interactionId");
      if (!isRecord(command.resolution))
        throw new Error("interaction.resolve.resolution 必须是对象。 ");
      return;
    case "tool.resolve":
      requireString(command.sessionId, "tool.resolve.sessionId");
      optionalString(command.runId, "tool.resolve.runId");
      requireString(command.toolCallId, "tool.resolve.toolCallId");
      validateToolResolution(command.resolution);
      return;
    case "task.wait":
    case "task.cancel":
      requireString(command.sessionId, `${command.type}.sessionId`);
      requireString(command.taskId, `${command.type}.taskId`);
      return;
    case "task.continue": {
      requireString(command.sessionId, "task.continue.sessionId");
      requireString(command.taskId, "task.continue.taskId");
      if (typeof command.content !== "string" || !command.content.trim()) {
        throw new Error("task.continue.content 必须是非空字符串。 ");
      }
      if ([...command.content].length > MAX_TASK_CONTINUE_CODEPOINTS) {
        throw new Error(
          `task.continue.content 不能超过 ${MAX_TASK_CONTINUE_CODEPOINTS} 个 Unicode 字符。`,
        );
      }
      if (
        [...command.content].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return (
            (codePoint < 0x20 && character !== "\n" && character !== "\t") ||
            codePoint === 0x7f
          );
        })
      ) {
        throw new Error("task.continue.content 不能包含控制字符。 ");
      }
      return;
    }
    default: {
      const unreachable: never = command;
      throw new Error(`未知 agent command：${String(unreachable)}。`);
    }
  }
};

/** Validate a command before it reaches an engine or a worker transport. */
export function validateAgentCommandEnvelope(
  value: unknown,
): asserts value is AgentCommandEnvelope {
  if (!isRecord(value)) throw new Error("agent command envelope 必须是对象。 ");
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new Error(
      `不支持的 agent protocol 版本：${String(value.protocolVersion)}。`,
    );
  }
  if (!(
    (typeof value.requestId === "string" && value.requestId.trim()) ||
    (typeof value.requestId === "number" &&
      Number.isSafeInteger(value.requestId))
  )) {
    throw new Error("agent command envelope.requestId 必须是稳定 ID。 ");
  }
  if (value.idempotencyKey !== undefined) {
    const idempotencyKey = requireString(
      value.idempotencyKey,
      "agent command envelope.idempotencyKey",
    );
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new Error(
        `agent command envelope.idempotencyKey 不能超过 ${MAX_IDEMPOTENCY_KEY_LENGTH} 个字符。`,
      );
    }
  }
  optionalString(value.sessionId, "agent command envelope.sessionId");
  validateCommand(value.command as AgentCommand);
}
