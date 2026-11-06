import type { AgentUsage, JsonObject } from "./contract.ts";
import type { AgentBillingUsage } from "../acp.ts";

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const usageFields = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "reasoningTokens",
  "modelCalls",
  "apiDurationMs",
] as const;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const wireValue = (
  value: Record<string, unknown> | undefined,
  camelCase: string,
  snakeCase: string,
) => value?.[camelCase] ?? value?.[snakeCase];

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Normalize camel- or snake-case billing usage from a session-update payload. */
export const parseBillingUsage = (
  value: unknown,
): AgentBillingUsage | undefined => {
  const usage = objectValue(value);
  if (!usage) return undefined;

  const inputTokens = finiteNumber(
    wireValue(usage, "inputTokens", "input_tokens"),
  );
  const outputTokens = finiteNumber(
    wireValue(usage, "outputTokens", "output_tokens"),
  );
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return undefined;
  }

  const cachedReadTokens =
    finiteNumber(wireValue(usage, "cachedReadTokens", "cached_read_tokens")) ??
    0;
  const reasoningTokens =
    finiteNumber(wireValue(usage, "reasoningTokens", "reasoning_tokens")) ?? 0;
  const modelCalls =
    finiteNumber(wireValue(usage, "modelCalls", "model_calls")) ?? 0;
  const apiDurationMs =
    finiteNumber(wireValue(usage, "apiDurationMs", "api_duration_ms")) ?? 0;
  const costUsdTicks = finiteNumber(
    wireValue(usage, "costUsdTicks", "cost_usd_ticks"),
  );
  const usageIsIncomplete =
    wireValue(usage, "usageIsIncomplete", "usage_is_incomplete") === true;
  const costIsPartial =
    wireValue(usage, "costIsPartial", "cost_is_partial") === true;

  return {
    inputTokens,
    outputTokens,
    cachedReadTokens: Math.max(0, cachedReadTokens),
    reasoningTokens: Math.max(0, reasoningTokens),
    modelCalls: Math.max(0, modelCalls),
    apiDurationMs: Math.max(0, apiDurationMs),
    usageIsIncomplete,
    costIsPartial,
    ...(costUsdTicks !== undefined && costUsdTicks >= 0
      ? { costUsdTicks }
      : {}),
  };
};

export const mergeUsage = (
  previous: AgentUsage | undefined,
  next: AgentUsage,
): AgentUsage => ({
  ...(previous ?? {}),
  ...next,
  confidence: next.confidence,
  ...(next.cost !== undefined
    ? { cost: next.cost }
    : previous?.cost !== undefined
      ? { cost: previous.cost }
      : {}),
});

/** Pi reports USD in dollars while the product stores cost in 1e-10 USD ticks. */
const USD_TICKS_PER_DOLLAR = 10_000_000_000;

export const toBillingUsage = (usage: AgentUsage): AgentBillingUsage => {
  const values = Object.fromEntries(
    usageFields.map((field) => [field, finiteNonNegative(usage[field])]),
  ) as Record<(typeof usageFields)[number], number | undefined>;
  const usageIsIncomplete =
    usage.confidence !== "measured" ||
    usageFields.some((field) => values[field] === undefined);
  const amount = finiteNonNegative(usage.cost?.amount);
  const currency =
    typeof usage.cost?.currency === "string"
      ? usage.cost.currency.toUpperCase()
      : undefined;
  const hasUsdCost =
    amount !== undefined &&
    currency === "USD" &&
    Number.isSafeInteger(amount * USD_TICKS_PER_DOLLAR);
  const costUsdTicks = hasUsdCost
    ? Math.round(amount * USD_TICKS_PER_DOLLAR)
    : undefined;

  return {
    inputTokens: values.inputTokens ?? 0,
    outputTokens: values.outputTokens ?? 0,
    cachedReadTokens: values.cachedReadTokens ?? 0,
    reasoningTokens: values.reasoningTokens ?? 0,
    modelCalls: values.modelCalls ?? 0,
    apiDurationMs: values.apiDurationMs ?? 0,
    usageIsIncomplete,
    // Missing or non-USD cost is not evidence that the request was free.
    costIsPartial: !hasUsdCost,
    ...(costUsdTicks !== undefined ? { costUsdTicks } : {}),
  };
};

export const usageUpdate = (usage: AgentBillingUsage): JsonObject => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedReadTokens: usage.cachedReadTokens,
  reasoningTokens: usage.reasoningTokens,
  modelCalls: usage.modelCalls,
  apiDurationMs: usage.apiDurationMs,
  usageIsIncomplete: usage.usageIsIncomplete,
  costIsPartial: usage.costIsPartial,
  ...(usage.costUsdTicks !== undefined
    ? { costUsdTicks: usage.costUsdTicks }
    : {}),
});
