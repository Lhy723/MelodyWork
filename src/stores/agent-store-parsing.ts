import type {
  AcpEnvelope,
  AgentContextUsage,
  AgentModelOption,
  AgentReasoningEffortOption,
  PermissionOption,
} from "@/domain/acp";
import {
  contextUsageFromTotalTokens,
  parseSessionContextUsage,
} from "@/domain/session-projection";
export {
  questionEntryForRequest,
  updateQuestionEntry,
} from "@/domain/user-question";

export const objectValue = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

export const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const wireValue = (
  value: Record<string, unknown> | undefined,
  camelCase: string,
  snakeCase: string,
) => value?.[camelCase] ?? value?.[snakeCase];

export const permissionToolKey = (title: string, command: string) =>
  `${title.trim()}\n${command.trim()}`;

export const parsePermissionOptions = (value: unknown): PermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((option) => {
        const item = objectValue(option);
        const optionId = stringValue(item?.optionId);
        const name = stringValue(item?.name);
        const kind = stringValue(item?.kind) as PermissionOption["kind"];
        return optionId && name && kind ? [{ optionId, name, kind }] : [];
      })
    : [];

export const errorMessage = (message: AcpEnvelope, fallback: string) => {
  const base = message.error?.message?.trim();
  const data = message.error?.data;
  const dataObject = objectValue(data);
  const detail =
    (typeof data === "string" ? data.trim() : undefined) ||
    stringValue(dataObject?.message)?.trim() ||
    stringValue(dataObject?.detail)?.trim() ||
    stringValue(dataObject?.reason)?.trim() ||
    stringValue(dataObject?.error)?.trim() ||
    stringValue(dataObject?.code)?.trim();

  if (base && detail && base !== detail) {
    return `${base}：${detail}`;
  }
  return detail || base || fallback;
};

export const responseMeta = (
  message: AcpEnvelope,
): Record<string, unknown> | undefined =>
  objectValue(message.result?.meta) ?? objectValue(message.result?._meta);

export const preferredAuthMethod = (
  message: AcpEnvelope,
): string | undefined => {
  const methods = Array.isArray(message.result?.authMethods)
    ? message.result.authMethods.flatMap((value) => {
        const method = objectValue(value);
        const id = stringValue(method?.id);
        return id ? [id] : [];
      })
    : [];
  const preferred = stringValue(responseMeta(message)?.defaultAuthMethodId);
  if (preferred && methods.includes(preferred)) {
    return preferred;
  }
  return (
    methods.find((id) => id === "cached_token") ??
    methods.find((id) => id === "xai.api_key") ??
    methods[0]
  );
};

const reasoningEffortCopy: Record<
  string,
  { label: string; description: string }
> = {
  xhigh: { label: "极高", description: "最深入的推理与实现检查" },
  high: { label: "高", description: "更充分的推理与实现检查" },
  medium: { label: "中", description: "兼顾速度与质量" },
  low: { label: "低", description: "优先快速响应" },
};

const inputModalitiesFrom = (
  value: unknown,
): AgentModelOption["input"] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const input = value.filter(
    (item, index, all): item is "text" | "image" =>
      (item === "text" || item === "image") && all.indexOf(item) === index,
  );
  return input.length > 0 ? input : undefined;
};

const modelOptionsFromState = (state: Record<string, unknown> | undefined) => {
  const rawAvailableModels = wireValue(
    state,
    "availableModels",
    "available_models",
  );
  const availableModels = Array.isArray(rawAvailableModels)
    ? rawAvailableModels.flatMap((value) => {
        const model = objectValue(value);
        const id = stringValue(wireValue(model, "modelId", "model_id"));
        if (!id) {
          return [];
        }
        const meta = objectValue(model?._meta) ?? objectValue(model?.meta);
        const supportsReasoningEffort =
          booleanValue(
            wireValue(
              meta,
              "supportsReasoningEffort",
              "supports_reasoning_effort",
            ),
          ) ?? false;
        const rawReasoningEfforts = wireValue(
          meta,
          "reasoningEfforts",
          "reasoning_efforts",
        );
        const configuredOptions = Array.isArray(rawReasoningEfforts)
          ? rawReasoningEfforts.flatMap((raw): AgentReasoningEffortOption[] => {
              if (typeof raw === "string") {
                const localized = reasoningEffortCopy[raw];
                return [
                  {
                    id: raw,
                    value: raw,
                    label: localized?.label ?? raw,
                    description: localized?.description,
                  },
                ];
              }
              const option = objectValue(raw);
              const optionValue = stringValue(
                wireValue(option, "value", "value"),
              );
              if (!optionValue) {
                return [];
              }
              const localized = reasoningEffortCopy[optionValue];
              return [
                {
                  id: stringValue(wireValue(option, "id", "id")) ?? optionValue,
                  value: optionValue,
                  label:
                    localized?.label ??
                    stringValue(wireValue(option, "label", "label")) ??
                    optionValue,
                  description:
                    localized?.description ??
                    stringValue(
                      wireValue(option, "description", "description"),
                    ),
                },
              ];
            })
          : [];
        const reasoningEfforts =
          supportsReasoningEffort && configuredOptions.length === 0
            ? ["xhigh", "high", "medium", "low"].map((effort) => ({
                id: effort,
                value: effort,
                label: reasoningEffortCopy[effort].label,
                description: reasoningEffortCopy[effort].description,
              }))
            : configuredOptions;
        return [
          {
            id,
            name: stringValue(model?.name) ?? id,
            ...(inputModalitiesFrom(wireValue(meta, "input", "input"))
              ? {
                  input: inputModalitiesFrom(wireValue(meta, "input", "input")),
                }
              : {}),
            contextWindowTokens: numberValue(
              wireValue(meta, "totalContextTokens", "total_context_tokens"),
            ),
            reasoningEffort: stringValue(
              wireValue(meta, "reasoningEffort", "reasoning_effort"),
            ),
            reasoningEfforts,
          },
        ];
      })
    : [];
  const selectedModelId = stringValue(
    wireValue(state, "currentModelId", "current_model_id"),
  );
  const selectedModel = availableModels.find(
    (model) => model.id === selectedModelId,
  );
  return {
    availableModels,
    selectedModelId,
    selectedReasoningEffort: selectedModel?.reasoningEffort,
  };
};

export const modelOptions = (message: AcpEnvelope) =>
  modelOptionsFromState(objectValue(responseMeta(message)?.modelState));

const normalizedExtensionMethod = (method: unknown) =>
  stringValue(method)?.replace(/^_+/, "");

const hasModelStateShape = (value: Record<string, unknown>) =>
  Array.isArray(wireValue(value, "availableModels", "available_models")) ||
  value.currentModelId !== undefined ||
  value.current_model_id !== undefined;

/**
 * Model catalog updates are machine-wide ACP extension notifications. Depending
 * on the gateway version they may be sent directly, `_`-prefixed, or wrapped
 * with a nested `params.method`/`params.params` pair. Normalize all forms here
 * so a settings change updates the picker without requiring a reconnect.
 */
export const modelOptionsFromUpdate = (message: AcpEnvelope) => {
  let params = objectValue(message.params);
  let isModelUpdate =
    normalizedExtensionMethod(message.method) === "x.ai/models/update";

  for (let depth = 0; params && depth < 5; depth += 1) {
    if (normalizedExtensionMethod(params.method) === "x.ai/models/update") {
      isModelUpdate = true;
    }
    if (isModelUpdate && hasModelStateShape(params)) {
      return modelOptionsFromState(params);
    }
    params = objectValue(params.params);
  }
  return undefined;
};

export const contextUsageFromResult = (
  result: Record<string, unknown> | undefined,
  fallback?: AgentContextUsage,
): AgentContextUsage | undefined => {
  const directUsage = parseSessionContextUsage(objectValue(result?.usage));
  if (directUsage) {
    return directUsage;
  }

  const meta = objectValue(result?._meta) ?? objectValue(result?.meta);
  const metadataUsage = parseSessionContextUsage(
    objectValue(meta?.["x.ai/contextUsage"]),
  );
  if (metadataUsage) {
    return metadataUsage;
  }

  return contextUsageFromTotalTokens(
    numberValue(meta?.totalTokens ?? meta?.total_tokens),
    fallback,
  );
};

export const contextUsageForModel = (
  models: AgentModelOption[],
  modelId: string | undefined,
  current?: AgentContextUsage,
): AgentContextUsage | undefined => {
  const maxTokens = models.find(
    (model) => model.id === modelId,
  )?.contextWindowTokens;
  if (maxTokens === undefined || maxTokens <= 0) {
    return current;
  }
  if (current?.maxTokens === maxTokens) {
    return current;
  }
  return { usedTokens: 0, maxTokens };
};

const SESSION_PAYLOAD_KEYS = [
  "update",
  "sessionId",
  "session_id",
  "sessionUpdate",
  "session_update",
  "promptId",
  "prompt_id",
  "stopReason",
  "stop_reason",
  "agentResult",
  "agent_result",
];

const looksLikeSessionPayload = (value: Record<string, unknown>) =>
  SESSION_PAYLOAD_KEYS.some((key) => value[key] !== undefined);

// 从 ACP 消息中提取 session update 的真实 params。
// session/update 与 x.ai/session/update 是直连形式：
// params.sessionId / params.update。兼容层在不同版本中还可能把消息
// 包装到 params.params、params.payload 或再多一层的 params 中，因此这里
// 有界递归查找，而不是只假设固定的一层包装。
export const extractSessionUpdateParams = (
  message: AcpEnvelope,
): Record<string, unknown> | undefined => {
  const visit = (
    value: unknown,
    depth: number,
  ): Record<string, unknown> | undefined => {
    const object = objectValue(value);
    if (!object || depth > 4) {
      return undefined;
    }
    if (looksLikeSessionPayload(object)) {
      return object;
    }
    for (const key of ["params", "payload", "data"]) {
      const nested = visit(object[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };

  return visit(message.params, 0);
};

export const directSessionUpdate = (
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!params || !looksLikeSessionPayload(params)) {
    return undefined;
  }
  if (objectValue(params.update)) {
    return objectValue(params.update);
  }
  return params.sessionUpdate !== undefined ||
    params.session_update !== undefined
    ? params
    : undefined;
};
