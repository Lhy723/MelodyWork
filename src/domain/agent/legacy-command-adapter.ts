import type { AcpEnvelope } from "../acp.ts";
import type {
  AgentAttachment,
  AgentCommandEnvelope,
  JsonObject,
} from "./contract.ts";

const permissionMeta = (mode: "ask" | "auto" | "always-approve") => ({
  clientIdentifier: "melody-work",
  yoloMode: mode === "always-approve",
  autoMode: mode === "auto",
});

const attachmentBlocks = (attachments: AgentAttachment[]) =>
  attachments.map((attachment) => {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(attachment.url);
    if (!match) {
      throw new Error(`无法读取附件 ${attachment.filename ?? "文件"}。`);
    }
    const mediaType = attachment.mediaType || match[1];
    if (mediaType.startsWith("image/")) {
      if (!match[2]) {
        throw new Error(`无法编码图片 ${attachment.filename ?? "附件"}。`);
      }
      return {
        type: "image",
        data: match[3],
        mimeType: mediaType,
      };
    }
    const text = match[2]
      ? new TextDecoder().decode(
          Uint8Array.from(atob(match[3]), (character) =>
            character.charCodeAt(0),
          ),
        )
      : decodeURIComponent(match[3]);
    return {
      type: "text",
      text: [
        `<attachment filename="${attachment.filename ?? "attachment"}" media-type="${mediaType || "text/plain"}">`,
        text,
        "</attachment>",
      ].join("\n"),
    };
  });

/**
 * Translate the small product command surface used during P1 to legacy ACP.
 *
 * Keeping this mapping in one file is intentional: new Pi code will consume
 * AgentCommandEnvelope instead of adding another ACP-shaped request in a
 * store. Commands not yet migrated should remain on the old path until their
 * semantics (especially attachments and approvals) have a tested mapping.
 */
export const toLegacyAcpRequest = (
  envelope: AgentCommandEnvelope,
): AcpEnvelope => {
  const { requestId, command } = envelope;
  switch (command.type) {
    case "runtime.health":
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: command.clientCapabilities ?? {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          _meta: {
            clientType: command.clientType ?? "melody-work",
            protocolBridge: true,
            ...(command.clientVersion
              ? { clientVersion: command.clientVersion }
              : {}),
            ...(command.startupHints
              ? { startupHints: command.startupHints }
              : {}),
          },
        },
      };
    case "runtime.authenticate":
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "authenticate",
        params: {
          methodId: command.methodId,
          _meta: { headless: command.headless ?? false },
        },
      };
    case "runtime.models.list":
      throw new Error(
        "runtime.models.list 只属于 Pi ModelRuntime，legacy ACP 请使用 initialize 返回的模型目录。",
      );
    case "runtime.models.sync":
      throw new Error(
        "runtime.models.sync 只属于 Pi ModelRuntime，legacy ACP 请使用 initialize 返回的模型目录。",
      );
    case "runtime.shutdown":
      throw new Error(
        "runtime.shutdown 只属于 Pi worker，legacy ACP 由 Host 停止进程。 ",
      );
    case "session.open": {
      const meta = {
        ...permissionMeta(command.permissionMode),
        ...(command.modelId ? { modelId: command.modelId } : {}),
        ...(command.cursor ? { cursor: command.cursor } : {}),
      };
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: command.sessionId ? "session/load" : "session/new",
        params: {
          cwd: command.cwd,
          mcpServers: [],
          _meta: meta,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        },
      };
    }
    case "session.close":
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "session/cancel",
        params: { sessionId: command.sessionId },
      };
    case "session.fork":
      throw new Error(
        "session.fork 需要 Pi 原生会话树，legacy ACP 不支持 Explorer 分支。",
      );
    case "session.import":
      throw new Error(
        "session.import 只属于 Pi 迁移适配器，legacy ACP 不支持导入原生会话。",
      );
    case "session.resources.refresh":
      throw new Error(
        "session.resources.refresh 只属于 Pi worker，legacy ACP 不需要刷新 Pi 资源。",
      );
    case "session.configure": {
      if (command.sessionModeId) {
        return {
          jsonrpc: "2.0",
          id: requestId,
          method: "session/set_mode",
          params: {
            sessionId: command.sessionId,
            modeId: command.sessionModeId,
          },
        };
      }
      if (command.permissionMode) {
        return {
          jsonrpc: "2.0",
          id: requestId,
          method: "x.ai/yolo_mode_changed",
          params: {
            clientIdentifier: "melody-work",
            permission_mode: command.permissionMode,
            yolo_mode: command.permissionMode === "always-approve",
            auto_mode: command.permissionMode === "auto",
          },
        };
      }
      if (!command.modelId) {
        throw new Error(
          "session.configure 需要 modelId、sessionModeId 或 permissionMode。 ",
        );
      }
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "session/set_model",
        params: {
          sessionId: command.sessionId,
          modelId: command.modelId,
          ...(command.reasoningEffort
            ? { _meta: { reasoningEffort: command.reasoningEffort } }
            : {}),
        },
      };
    }
    case "turn.cancel":
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "session/cancel",
        params: {
          sessionId: command.sessionId,
          _meta: {
            ...(command.promptId ? { cancelPromptId: command.promptId } : {}),
            cancelSubagents: command.cancelSubagents,
            cancelTrigger: command.reason === "timeout" ? "timeout" : "mouse",
          },
        },
      };
    case "turn.steer":
    case "turn.follow_up":
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "x.ai/queue/interject",
        params: {
          sessionId: command.sessionId,
          content: command.content,
          _meta: {
            runId: command.runId,
            ...(command.type === "turn.follow_up" ? { followUp: true } : {}),
          },
        },
      };
    case "interaction.resolve":
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: command.resolution,
      };
    case "tool.resolve":
      throw new Error(
        "tool.resolve 只属于 Pi ToolGateway，不能发送到 legacy ACP。",
      );
    case "task.wait":
      throw new Error("task.wait 尚未迁移到 ACP 适配器。");
    case "task.cancel":
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "session/cancel",
        params: {
          sessionId: command.sessionId,
          _meta: { taskId: command.taskId, cancelSubagents: true },
        },
      };
    case "task.continue":
      throw new Error("task.continue 仅属于 Pi child session。 ");
    case "turn.submit": {
      const prompt: JsonObject[] = [
        { type: "text", text: command.content },
        ...attachmentBlocks(command.attachments),
      ];
      return {
        jsonrpc: "2.0",
        id: requestId,
        method: "session/prompt",
        params: {
          sessionId: command.sessionId,
          prompt,
          _meta: {
            promptId: command.promptId,
            ...(command.streamingBehavior === "steer" ? { sendNow: true } : {}),
          },
        },
      };
    }
  }
};
