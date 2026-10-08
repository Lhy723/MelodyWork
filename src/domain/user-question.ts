import type {
  AcpEnvelope,
  AgentQuestion,
  AgentQuestionMode,
  AgentQuestionOption,
  AgentQuestionResponse,
  AgentQuestionRequest,
  TimelineEntry,
} from "./acp";

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const wireValue = (
  value: JsonObject | undefined,
  camelCase: string,
  snakeCase: string,
) => value?.[camelCase] ?? value?.[snakeCase];

export const USER_QUESTION_METHODS = [
  "x.ai/ask_user_question",
  "_x.ai/ask_user_question",
] as const;

export const isUserQuestionMethod = (
  method: string | undefined,
): method is (typeof USER_QUESTION_METHODS)[number] =>
  method !== undefined &&
  USER_QUESTION_METHODS.includes(
    method as (typeof USER_QUESTION_METHODS)[number],
  );

const parseOption = (value: unknown): AgentQuestionOption | undefined => {
  const option = objectValue(value);
  const label = stringValue(option?.label)?.trim();
  if (!label) {
    return undefined;
  }
  return {
    label,
    description: stringValue(option?.description)?.trim() ?? "",
    preview: stringValue(option?.preview),
    id: stringValue(wireValue(option, "id", "option_id")),
  };
};

const parseQuestion = (value: unknown): AgentQuestion | undefined => {
  const question = objectValue(value);
  const text = stringValue(question?.question)?.trim();
  if (!text) {
    return undefined;
  }
  const options = Array.isArray(question?.options)
    ? question.options.flatMap((option) => {
        const parsed = parseOption(option);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    question: text,
    options,
    multiSelect: booleanValue(
      wireValue(question, "multiSelect", "multi_select"),
    ),
    id: stringValue(wireValue(question, "id", "question_id")),
  };
};

const questionPayload = (message: AcpEnvelope): JsonObject | undefined => {
  const params = objectValue(message.params);
  if (!params) {
    return undefined;
  }
  const nested = objectValue(params.params);
  if (
    nested &&
    (params.method !== undefined || params.questions === undefined)
  ) {
    return nested;
  }
  return params;
};

export const parseUserQuestionRequest = (
  message: AcpEnvelope,
  fallbackSessionId?: string,
): AgentQuestionRequest | undefined => {
  if (!isUserQuestionMethod(message.method) || message.id === undefined) {
    return undefined;
  }
  const payload = questionPayload(message);
  if (!payload) {
    return undefined;
  }
  const sessionId =
    stringValue(wireValue(payload, "sessionId", "session_id")) ??
    fallbackSessionId;
  const toolCallId =
    stringValue(wireValue(payload, "toolCallId", "tool_call_id")) ??
    `ask-user-question-${String(message.id)}`;
  const questions = Array.isArray(payload.questions)
    ? payload.questions.flatMap((question) => {
        const parsed = parseQuestion(question);
        return parsed ? [parsed] : [];
      })
    : [];
  if (!sessionId || !toolCallId || questions.length === 0) {
    return undefined;
  }
  const mode: AgentQuestionMode =
    stringValue(payload.mode) === "plan" ? "plan" : "default";
  return {
    requestId: message.id,
    sessionId,
    toolCallId,
    questions,
    mode,
    outcome: "pending",
  };
};

export const questionRequestKey = (request: AgentQuestionRequest) =>
  `${request.sessionId}:${String(request.requestId)}`;

/** Project a pending question into the shared tool-row timeline shape. */
export const questionEntryForRequest = (
  timeline: TimelineEntry[],
  request: AgentQuestionRequest,
): TimelineEntry[] => {
  const index = timeline.findIndex(
    (entry) =>
      entry.kind === "tool" &&
      (entry.toolCallId === request.toolCallId ||
        (entry.question?.requestId !== undefined &&
          String(entry.question.requestId) === String(request.requestId))),
  );
  const existing = index >= 0 ? timeline[index] : undefined;
  const existingQuestion =
    existing?.kind === "tool" ? existing.question : undefined;
  const keepAnsweredRequest =
    existingQuestion?.requestId !== undefined &&
    String(existingQuestion.requestId) === String(request.requestId) &&
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

/** Apply a normalized question response during live projection or replay. */
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
