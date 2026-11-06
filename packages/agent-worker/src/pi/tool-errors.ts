import type { AgentError } from "@melody/agent-contract";

/** Construct the canonical error shape shared by Pi worker tool modules. */
export const gatewayError = (
  code: string,
  message: string,
  retriable = false,
  scope: AgentError["scope"] = "tool",
): Error & { agentError: AgentError } => {
  const error = new Error(message) as Error & { agentError: AgentError };
  error.agentError = { code, message, retriable, scope };
  return error;
};
