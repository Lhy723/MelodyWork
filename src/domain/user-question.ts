import type {
  AcpEnvelope,
  AgentQuestion,
  AgentQuestionMode,
  AgentQuestionOption,
  AgentQuestionRequest,
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
