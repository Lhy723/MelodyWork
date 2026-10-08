/**
 * Session modes understood by the product boundary.
 *
 * ACP may expose additional modes at runtime, so the wire contract keeps
 * `sessionModeId` as a string. Pi is deliberately stricter: these are the
 * modes whose semantics Melody can enforce without loading an extension.
 */
export const AGENT_SESSION_MODE_IDS = ["default", "plan", "ask"] as const;

export type AgentSessionModeId = (typeof AGENT_SESSION_MODE_IDS)[number];

export const isAgentSessionModeId = (
  value: string,
): value is AgentSessionModeId =>
  (AGENT_SESSION_MODE_IDS as readonly string[]).includes(value);
