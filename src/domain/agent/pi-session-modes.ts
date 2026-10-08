import type { AgentSessionModeOption } from "@/domain/acp";

/**
 * Pi has no ACP session-mode extension registry. These product modes are
 * therefore declared explicitly and enforced by the worker ToolGateway.
 */
export const PI_SESSION_MODE_OPTIONS = [
  {
    id: "default",
    name: "代理",
    description: "按需使用工具完成任务。",
  },
  {
    id: "plan",
    name: "规划",
    description: "先制定方案，不修改文件。",
  },
  {
    id: "ask",
    name: "问答",
    description: "回答问题，不主动执行操作。",
  },
] satisfies AgentSessionModeOption[];
