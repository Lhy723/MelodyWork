import type { AgentError } from "@melody/agent-contract";

export const asError = (
  error: unknown,
  scope: AgentError["scope"] = "runtime",
): AgentError => ({
  code: "pi.worker_error",
  message: error instanceof Error ? error.message : String(error),
  retriable: false,
  scope,
});

export const fail = (
  code: string,
  message: string,
  scope: AgentError["scope"],
): Error & {
  agentError: AgentError;
} => {
  const error = new Error(message) as Error & { agentError: AgentError };
  error.agentError = { code, message, retriable: false, scope };
  return error;
};

const safeProviderErrorMessage = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return (
    value
      .trim()
      .slice(0, 4_096)
      // eslint-disable-next-line no-control-regex -- provider errors are untrusted text; remove terminal/control characters.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
      .replace(
        /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
        "$1[redacted]",
      )
      .replace(
        /\b(?:sk-[a-z0-9_-]{12,}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,})\b/gi,
        "[redacted]",
      )
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi,
        "$1[redacted]",
      )
      .slice(0, 1_024)
  );
};

/** Map untrusted Pi provider failure details to the bounded product error contract. */
export const providerRunError = (
  message: Record<string, unknown>,
): AgentError => {
  const providerMessage = safeProviderErrorMessage(message.errorMessage);
  const rateLimited =
    /(?:\b429\b|rate[_\s-]?limit|too[_\s-]?many[_\s-]?requests|\btpm\b|\brpm\b|throttl|overload|inference.*exceeds)/i.test(
      providerMessage ?? "",
    );
  return {
    code: rateLimited
      ? "pi.provider_rate_limited"
      : "pi.provider_request_failed",
    message: rateLimited
      ? "模型请求受到限流（TPM/RPM），请稍后重试或切换模型。"
      : "Pi 模型请求失败，请检查服务商配置或网络后重试。",
    retriable: true,
    scope: "run",
    details: {
      ...(typeof message.provider === "string" && message.provider.trim()
        ? { provider: message.provider.trim().slice(0, 128) }
        : {}),
      ...(typeof message.api === "string" && message.api.trim()
        ? { api: message.api.trim().slice(0, 128) }
        : {}),
      ...(typeof message.model === "string" && message.model.trim()
        ? { model: message.model.trim().slice(0, 128) }
        : {}),
      ...(providerMessage ? { providerMessage } : {}),
    },
  };
};
