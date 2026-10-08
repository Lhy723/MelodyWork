import type { AgentModelDescriptor } from "./contract.ts";

export interface PiModelCatalogSnapshot {
  revision: number;
  models: AgentModelDescriptor[];
  refreshErrors?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  return value;
};

const positiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数。`);
  }
  return value;
};

const availabilityValues = new Set<AgentModelDescriptor["availability"]>([
  "available",
  "auth-needed",
  "unavailable",
  "unknown",
]);

const parseModel = (value: unknown, index: number): AgentModelDescriptor => {
  if (!isRecord(value)) throw new Error(`模型 ${index + 1} 不是对象。`);
  const provider = requiredString(
    value.provider,
    `模型 ${index + 1} 的 provider`,
  );
  const id = requiredString(value.id, `模型 ${index + 1} 的 id`);
  const name = requiredString(value.name, `模型 ${index + 1} 的 name`);
  const api = requiredString(value.api, `模型 ${index + 1} 的 api`);
  if (!Array.isArray(value.input) || value.input.length === 0) {
    throw new Error(`模型 ${index + 1} 的 input 必须是非空数组。`);
  }
  const input = value.input.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  if (input.length !== value.input.length) {
    throw new Error(`模型 ${index + 1} 的 input 包含不支持的类型。`);
  }
  if (typeof value.reasoning !== "boolean") {
    throw new Error(`模型 ${index + 1} 的 reasoning 必须是布尔值。`);
  }
  const availability = value.availability;
  if (
    !availabilityValues.has(
      availability as AgentModelDescriptor["availability"],
    )
  ) {
    throw new Error(`模型 ${index + 1} 的 availability 无效。`);
  }
  if (value.authSource !== undefined) {
    requiredString(value.authSource, `模型 ${index + 1} 的 authSource`);
  }
  return {
    provider,
    id,
    name,
    api,
    input: [...new Set(input)],
    reasoning: value.reasoning,
    contextWindow: positiveInteger(
      value.contextWindow,
      `模型 ${index + 1} 的 contextWindow`,
    ),
    maxTokens: positiveInteger(
      value.maxTokens,
      `模型 ${index + 1} 的 maxTokens`,
    ),
    availability: availability as AgentModelDescriptor["availability"],
    ...(value.authSource !== undefined
      ? { authSource: value.authSource as string }
      : {}),
  };
};

const requestIdsEqual = (left: unknown, right: string | number): boolean =>
  typeof right === "number"
    ? typeof left === "number" && left === right
    : typeof left === "string" && left === right;

/**
 * Narrow one untrusted Tauri event to a safe Pi model snapshot. Events for a
 * different request (or a different event type) return undefined so callers
 * can share one listener without accidentally consuming another response.
 */
export const parsePiModelCatalogEvent = (
  value: unknown,
  expectedRequestId?: string | number,
): PiModelCatalogSnapshot | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    expectedRequestId !== undefined &&
    !requestIdsEqual(value.requestId, expectedRequestId)
  ) {
    return undefined;
  }
  const event = value.event;
  if (!isRecord(event) || event.type !== "runtime.models") return undefined;
  if (value.protocolVersion !== 1) {
    throw new Error("Pi 模型目录事件使用了不支持的协议版本。 ");
  }
  if (typeof value.replay !== "boolean") {
    throw new Error("Pi 模型目录事件 replay 必须是布尔值。 ");
  }
  requiredString(value.eventId, "Pi 模型目录事件 eventId");
  const revision = positiveInteger(event.revision, "Pi 模型目录 revision");
  if (!Array.isArray(event.models)) {
    throw new Error("Pi 模型目录 models 必须是数组。 ");
  }
  const models = event.models.map(parseModel);
  const seen = new Set<string>();
  for (const model of models) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) throw new Error(`Pi 模型目录包含重复模型：${key}。`);
    seen.add(key);
  }
  let refreshErrors: Record<string, string> | undefined;
  if (event.refreshErrors !== undefined) {
    if (!isRecord(event.refreshErrors)) {
      throw new Error("Pi 模型目录 refreshErrors 必须是对象。 ");
    }
    refreshErrors = {};
    for (const [key, message] of Object.entries(event.refreshErrors)) {
      refreshErrors[requiredString(key, "Pi 模型目录错误键")] = requiredString(
        message,
        `Pi 模型目录错误 ${key}`,
      );
    }
  }
  return {
    revision,
    models,
    ...(refreshErrors ? { refreshErrors } : {}),
  };
};
