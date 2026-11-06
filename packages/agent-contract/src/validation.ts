import { AGENT_PROTOCOL_VERSION } from "./protocol-version.ts";
import type { AgentCommand, AgentCommandEnvelope } from "./index.ts";

import {
  isRecord,
  optionalString,
  requireString,
  validatePermissionMode,
} from "./validation/shared.ts";
import { validateResourceManifest } from "./validation/resource-manifest.ts";
export {
  containsControlCharacters,
  withoutControlCharacters,
} from "./validation/shared.ts";

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_TASK_CONTINUE_CODEPOINTS = 12_000;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_IMPORT_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_CREDENTIALS = 512;
const MAX_MODEL_PROVIDER_IDS = 128;
const MAX_MODEL_CREDENTIAL_NAME_LENGTH = 255;
const MAX_MODEL_CREDENTIAL_VALUE_LENGTH = 16_384;

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
