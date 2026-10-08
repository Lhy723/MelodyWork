import type {
  AgentCommand,
  AgentCommandEnvelope,
  AgentInteractionKind,
  AgentProtocolCapabilities,
} from "./index.ts";

/** A named capability that can be checked before a command reaches a worker. */
export type AgentCapabilityName =
  | "authentication"
  | "modelCatalog"
  | "sessionTree"
  | "compaction"
  | "plans"
  | "questions"
  | "permissions"
  | "subagents"
  | "backgroundTasks"
  | "mcp"
  | `tool:${string}`
  | `media:${string}`;

export interface AgentCapabilityRequirement {
  capability: AgentCapabilityName;
  reason: string;
}

export interface UnsupportedAgentCapability {
  commandType: AgentCommand["type"];
  capability: AgentCapabilityName;
  reason: string;
}

export interface AgentCapabilityContext {
  /** The Host may know the interaction kind from its pending-request table. */
  interactionKind?: AgentInteractionKind;
}

const interactionCapability = (
  kind: AgentInteractionKind,
): AgentCapabilityName => (kind === "plan" ? "plans" : `${kind}s`);

const requirementsFor = (
  command: AgentCommand,
  context: AgentCapabilityContext = {},
): AgentCapabilityRequirement[] => {
  switch (command.type) {
    case "runtime.authenticate":
      return [
        {
          capability: "authentication",
          reason: "当前引擎没有提供认证入口。",
        },
      ];
    case "runtime.models.list":
      return [
        {
          capability: "modelCatalog",
          reason: "当前引擎不能返回版本化模型目录。",
        },
      ];
    case "runtime.models.sync":
      return [
        {
          capability: "modelCatalog",
          reason: "当前引擎不能在运行中同步模型目录。",
        },
      ];
    case "session.open":
      return command.permissionMode === "always-approve"
        ? []
        : [
            {
              capability: "permissions",
              reason: "当前引擎不能兑现会话的权限模式。",
            },
          ];
    case "session.import":
    case "session.fork":
      return [
        {
          capability: "sessionTree",
          reason:
            command.type === "session.fork"
              ? "当前引擎不能从原生会话节点创建分支。"
              : "当前引擎不能导入带树结构的会话历史。",
        },
      ];
    case "session.configure":
      return command.sessionModeId !== undefined ||
        command.permissionMode !== undefined
        ? [
            {
              capability: "permissions",
              reason: "当前引擎不能修改会话模式或权限模式。",
            },
          ]
        : [];
    case "session.resources.refresh":
      return [];
    case "turn.submit": {
      const requirements: AgentCapabilityRequirement[] = [];
      if (command.config.permissionMode !== "always-approve") {
        requirements.push({
          capability: "permissions",
          reason: "当前引擎不能兑现本轮请求的权限模式。",
        });
      }
      if (
        command.attachments.some((item) => item.mediaType.startsWith("image/"))
      ) {
        requirements.push({
          capability: "media:image-input",
          reason: "当前引擎不能接收图片附件。",
        });
      }
      return requirements;
    }
    case "interaction.resolve":
      return context.interactionKind
        ? [
            {
              capability: interactionCapability(context.interactionKind),
              reason: `当前引擎不能解析 ${context.interactionKind} 交互。`,
            },
          ]
        : [];
    case "task.wait":
    case "task.cancel":
      return [
        {
          capability: "backgroundTasks",
          reason: "当前引擎没有后台任务生命周期。",
        },
      ];
    case "task.continue":
      return [
        {
          capability: "subagents",
          reason: "当前引擎不能继续 Pi child session。",
        },
      ];
    case "runtime.health":
    case "runtime.shutdown":
    case "session.close":
    case "turn.steer":
    case "turn.follow_up":
    case "turn.cancel":
    case "tool.resolve":
      return [];
  }
};

export const agentCommandCapabilityRequirements = (
  command: AgentCommand,
  context: AgentCapabilityContext = {},
): AgentCapabilityRequirement[] => requirementsFor(command, context);

const hasCapability = (
  capabilities: AgentProtocolCapabilities,
  capability: AgentCapabilityName,
): boolean => {
  if (capability.startsWith("tool:")) {
    return capabilities.tools.includes(capability.slice("tool:".length));
  }
  if (capability.startsWith("media:")) {
    return capabilities.media.includes(capability.slice("media:".length));
  }
  type BooleanCapability = Exclude<
    keyof AgentProtocolCapabilities,
    | "engine"
    | "engineVersion"
    | "protocolVersion"
    | "tools"
    | "media"
    | "sessionModes"
    | "limitations"
  >;
  return capabilities[capability as BooleanCapability] === true;
};

/** Return all missing capabilities without throwing or mutating the command. */
export const unsupportedAgentCommandCapabilities = (
  command: AgentCommand,
  capabilities: AgentProtocolCapabilities,
  context: AgentCapabilityContext = {},
): UnsupportedAgentCapability[] =>
  agentCommandCapabilityRequirements(command, context)
    .filter(({ capability }) => !hasCapability(capabilities, capability))
    .map(({ capability, reason }) => ({
      commandType: command.type,
      capability,
      reason,
    }));

/** Error shape shared by the renderer and worker for an early capability miss. */
export const assertAgentCommandCapabilities = (
  envelope: AgentCommandEnvelope,
  capabilities: AgentProtocolCapabilities,
  context: AgentCapabilityContext = {},
): void => {
  const missing = unsupportedAgentCommandCapabilities(
    envelope.command,
    capabilities,
    context,
  );
  if (missing.length === 0) return;
  const first = missing[0];
  const error = new Error(
    `当前引擎不支持 ${first.commandType} 所需能力 ${first.capability}：${first.reason}`,
  ) as Error & {
    agentError: {
      code: string;
      message: string;
      retriable: boolean;
      scope: "runtime";
      details: {
        commandType: string;
        missingCapabilities: string[];
      };
    };
  };
  error.agentError = {
    code: "agent.capability_unavailable",
    message: error.message,
    retriable: false,
    scope: "runtime",
    details: {
      commandType: first.commandType,
      missingCapabilities: missing.map((item) => item.capability),
    },
  };
  throw error;
};

export const supportsAgentCommand = (
  command: AgentCommand,
  capabilities: AgentProtocolCapabilities,
  context: AgentCapabilityContext = {},
): boolean =>
  unsupportedAgentCommandCapabilities(command, capabilities, context).length ===
  0;
