import type {
  AcpEnvelope,
  AgentContextUsage,
  AgentModelOption,
  AgentReasoningEffortOption,
  AgentQuestionRequest,
  AgentQuestionResponse,
  PermissionOption,
  TimelineEntry,
} from "@/domain/acp";
import { parseSessionContextUsage } from "@/domain/session-projection";

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

const questionResponseText = (response: AgentQuestionResponse) => {
  switch (response.outcome) {
    case "accepted":
      return "已提交回答，Melody 将继续处理。";
    case "chat_about_this":
      return "已请求进一步讨论这些问题。";
    case "skip_interview":
      return "已跳过提问，Melody 将继续制定计划。";
    case "cancelled":
      return "已取消回答。";
  }
};

export const questionEntryForRequest = (
  timeline: TimelineEntry[],
  request: AgentQuestionRequest,
): TimelineEntry[] => {
  const index = timeline.findIndex(
    (entry) =>
      entry.kind === "tool" &&
      (entry.toolCallId === request.toolCallId ||
        entry.question?.requestId === request.requestId),
  );
  const existing = index >= 0 ? timeline[index] : undefined;
  const existingQuestion =
    existing?.kind === "tool" ? existing.question : undefined;
  const keepAnsweredRequest =
    existingQuestion?.requestId === request.requestId &&
    existingQuestion.outcome !== "pending";
  const next: TimelineEntry = {
    id:
      existing?.id ??
      `question-${request.toolCallId}-${String(request.requestId)}`,
    kind: "tool",
    toolCallId: request.toolCallId,
    title:
      existing?.kind === "tool" && existing.title.trim()
        ? existing.title
        : "询问用户",
    command:
      existing?.kind === "tool" && existing.command.trim()
        ? existing.command
        : "ask_user_question",
    output:
      existing?.kind === "tool" && existing.output
        ? existing.output
        : "正在等待你的回答。",
    startedAt: existing?.kind === "tool" ? existing.startedAt : Date.now(),
    activity: existing?.kind === "tool" ? existing.activity : undefined,
    status: keepAnsweredRequest
      ? existing?.kind === "tool"
        ? existing.status
        : "completed"
      : "pending",
    permission: existing?.kind === "tool" ? existing.permission : undefined,
    permissionRequestId:
      existing?.kind === "tool" ? existing.permissionRequestId : undefined,
    permissionOptions:
      existing?.kind === "tool" ? existing.permissionOptions : undefined,
    question: keepAnsweredRequest ? existingQuestion : request,
  };
  if (index < 0) {
    return [...timeline, next];
  }
  return timeline.map((entry, entryIndex) =>
    entryIndex === index ? next : entry,
  );
};

export const updateQuestionEntry = (
  timeline: TimelineEntry[],
  entryId: string,
  response: AgentQuestionResponse,
): TimelineEntry[] =>
  timeline.map((entry) => {
    if (entry.id !== entryId || entry.kind !== "tool" || !entry.question) {
      return entry;
    }
    const question = entry.question;
    return {
      ...entry,
      output: questionResponseText(response),
      question: {
        ...question,
        outcome: response.outcome,
        ...(response.outcome === "accepted"
          ? {
              answers: response.answers,
              annotations: response.annotations,
              partialAnswers: undefined,
            }
          : response.outcome === "chat_about_this" ||
              response.outcome === "skip_interview"
            ? {
                partialAnswers: response.partialAnswers,
                answers: undefined,
                annotations: undefined,
              }
            : {
                answers: undefined,
                annotations: undefined,
                partialAnswers: undefined,
              }),
      },
    };
  });

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

export const modelOptions = (message: AcpEnvelope) => {
  const state = objectValue(responseMeta(message)?.modelState);
  const availableModels = Array.isArray(state?.availableModels)
    ? state.availableModels.flatMap((value) => {
        const model = objectValue(value);
        const id = stringValue(model?.modelId);
        if (!id) {
          return [];
        }
        const meta = objectValue(model?._meta) ?? objectValue(model?.meta);
        const supportsReasoningEffort =
          booleanValue(meta?.supportsReasoningEffort) ?? false;
        const configuredOptions = Array.isArray(meta?.reasoningEfforts)
          ? meta.reasoningEfforts.flatMap(
              (raw): AgentReasoningEffortOption[] => {
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
                const optionValue = stringValue(option?.value);
                if (!optionValue) {
                  return [];
                }
                const localized = reasoningEffortCopy[optionValue];
                return [
                  {
                    id: stringValue(option?.id) ?? optionValue,
                    value: optionValue,
                    label:
                      localized?.label ??
                      stringValue(option?.label) ??
                      optionValue,
                    description:
                      localized?.description ??
                      stringValue(option?.description),
                  },
                ];
              },
            )
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
            contextWindowTokens: numberValue(meta?.totalContextTokens),
            reasoningEffort: stringValue(meta?.reasoningEffort),
            reasoningEfforts,
          },
        ];
      })
    : [];
  const selectedModelId = stringValue(state?.currentModelId);
  const selectedModel = availableModels.find(
    (model) => model.id === selectedModelId,
  );
  return {
    availableModels,
    selectedModelId,
    selectedReasoningEffort: selectedModel?.reasoningEffort,
  };
};

export const contextUsageFromResult = (
  result: Record<string, unknown> | undefined,
  fallback?: AgentContextUsage,
): AgentContextUsage | undefined => {
  const directUsage = parseSessionContextUsage(objectValue(result?.usage));
  if (directUsage) {
    return directUsage;
  }

  const meta = objectValue(result?._meta);
  const metadataUsage = parseSessionContextUsage(
    objectValue(meta?.["x.ai/contextUsage"]),
  );
  if (metadataUsage) {
    return metadataUsage;
  }

  const usedTokens = numberValue(meta?.totalTokens);
  if (fallback && usedTokens !== undefined && usedTokens >= 0) {
    return {
      ...fallback,
      usedTokens,
    };
  }

  return undefined;
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
  return params.sessionUpdate !== undefined || params.session_update !== undefined
    ? params
    : undefined;
};
