import { readFile } from "node:fs/promises";

const PI_MODEL_POLICIES_PATH_ENV = "MELODY_PI_MODEL_POLICIES_PATH";
const PI_AUTO_COMPACT_THRESHOLD_ENV = "MELODY_AUTO_COMPACT_THRESHOLD_PERCENT";
const MAX_PI_MODEL_POLICIES = 1024;
const MAX_PI_POLICY_FILE_BYTES = 1024 * 1024;
const MAX_PI_POLICY_RETRIES = 10_000;
const MAX_PI_POLICY_TIMEOUT_MS = 2_147_483_647;
export const MAX_PI_COMPACTION_THRESHOLD_PERCENT = 100;
export const DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT = 85;

export interface PiModelPolicy {
  maxRetries?: number;
  inferenceIdleTimeoutMs?: number;
  autoCompactThresholdPercent?: number;
}

export interface PiModelPolicySnapshot {
  defaultPolicy?: PiModelPolicy;
  models: ReadonlyMap<string, PiModelPolicy>;
}

export type PiModelIdentity = {
  provider: string;
  id: string;
  contextWindow?: number;
};

export type PiSettingsOverrides = {
  retry?: { provider?: { maxRetries?: number } };
  httpIdleTimeoutMs?: number;
  compaction?: { reserveTokens?: number };
};

type PiSettingsManagerWithOverrides = {
  applyOverrides: (overrides: PiSettingsOverrides) => void;
};

/**
 * Replace the three policy fields that Melody owns instead of deep-merging them
 * into the previous snapshot.  Pi's SettingsManager intentionally implements
 * applyOverrides as a deep merge, which would otherwise leave a removed
 * provider retry/idle-timeout policy active forever in a long-lived session.
 * The manager is created in-memory by this adapter, so deleting only these
 * Host-owned fields cannot discard Pi's own session settings.
 */
export const applyModelPolicyOverrides = (
  settingsManager: PiSettingsManagerWithOverrides,
  overrides: PiSettingsOverrides,
): void => {
  const mutableManager = settingsManager as PiSettingsManagerWithOverrides & {
    settings?: Record<string, unknown>;
  };
  const settings = mutableManager.settings;
  if (settings) {
    const retry = settings.retry;
    if (retry && typeof retry === "object" && !Array.isArray(retry)) {
      const provider = (retry as Record<string, unknown>).provider;
      if (
        provider &&
        typeof provider === "object" &&
        !Array.isArray(provider)
      ) {
        delete (provider as Record<string, unknown>).maxRetries;
        if (Object.keys(provider as Record<string, unknown>).length === 0) {
          delete (retry as Record<string, unknown>).provider;
        }
      }
      if (Object.keys(retry as Record<string, unknown>).length === 0) {
        delete settings.retry;
      }
    }
    delete settings.httpIdleTimeoutMs;
    const compaction = settings.compaction;
    if (
      compaction &&
      typeof compaction === "object" &&
      !Array.isArray(compaction)
    ) {
      delete (compaction as Record<string, unknown>).reserveTokens;
      if (Object.keys(compaction as Record<string, unknown>).length === 0) {
        delete settings.compaction;
      }
    }
  }
  mutableManager.applyOverrides(overrides);
};

const piModelPolicyKey = (model: PiModelIdentity): string =>
  `${model.provider}/${model.id}`;

const normalizedPolicyNumber = (
  value: unknown,
  field: string,
  key: string,
  maximum: number,
  allowZero: boolean,
): number | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    throw new Error(
      `Pi model policy ${key}.${field} must be an integer between ${allowZero ? 0 : 1} and ${maximum}`,
    );
  }
  return value;
};

const normalizedModelPolicy = (value: unknown, key: string): PiModelPolicy => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pi model policy ${key} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const maxRetries = normalizedPolicyNumber(
    record.maxRetries,
    "maxRetries",
    key,
    MAX_PI_POLICY_RETRIES,
    true,
  );
  const inferenceIdleTimeoutMs = normalizedPolicyNumber(
    record.inferenceIdleTimeoutMs,
    "inferenceIdleTimeoutMs",
    key,
    MAX_PI_POLICY_TIMEOUT_MS,
    false,
  );
  const autoCompactThresholdPercent = normalizedPolicyNumber(
    record.autoCompactThresholdPercent,
    "autoCompactThresholdPercent",
    key,
    MAX_PI_COMPACTION_THRESHOLD_PERCENT,
    true,
  );
  if (
    maxRetries === undefined &&
    inferenceIdleTimeoutMs === undefined &&
    autoCompactThresholdPercent === undefined
  ) {
    throw new Error(`Pi model policy ${key} is empty`);
  }
  return {
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(inferenceIdleTimeoutMs !== undefined ? { inferenceIdleTimeoutMs } : {}),
    ...(autoCompactThresholdPercent !== undefined
      ? { autoCompactThresholdPercent }
      : {}),
  };
};

/**
 * Load the Host-generated policy snapshot.  The file is separate from
 * `models.json` so Pi's strict catalog schema never sees product-only fields;
 * managed/development catalogs without a policy file use Melody's compatible
 * 85% threshold and Pi defaults for the remaining policy fields.
 */
export const loadPiModelPolicies = async (): Promise<PiModelPolicySnapshot> => {
  const path = process.env[PI_MODEL_POLICIES_PATH_ENV]?.trim();
  if (!path) {
    return {
      defaultPolicy: {
        autoCompactThresholdPercent: DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT,
      },
      models: new Map(),
    };
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ENOENT") {
      return {
        defaultPolicy: {
          autoCompactThresholdPercent:
            DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT,
        },
        models: new Map(),
      };
    }
    throw new Error(
      `无法读取 Pi 模型策略文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PI_POLICY_FILE_BYTES) {
    throw new Error("Pi 模型策略文件超过 1 MiB 限制");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Pi 模型策略文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pi 模型策略文件根节点必须是对象");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error("Pi 模型策略文件 version 必须为 1");
  }
  let defaultPolicy: PiModelPolicy | undefined;
  if (root.default !== undefined) {
    defaultPolicy = normalizedModelPolicy(root.default, "default");
  }
  const models = root.models;
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    throw new Error("Pi 模型策略文件缺少 models 对象");
  }
  const entries = Object.entries(models as Record<string, unknown>);
  if (entries.length > MAX_PI_MODEL_POLICIES) {
    throw new Error(`Pi 模型策略数量不能超过 ${MAX_PI_MODEL_POLICIES}`);
  }
  const result = new Map<string, PiModelPolicy>();
  for (const [key, value] of entries) {
    if (!key.trim() || key.length > 512) {
      throw new Error("Pi 模型策略键无效");
    }
    result.set(key, normalizedModelPolicy(value, key));
  }
  defaultPolicy = {
    ...(defaultPolicy ?? {}),
    autoCompactThresholdPercent:
      defaultPolicy?.autoCompactThresholdPercent ??
      DEFAULT_PI_AUTO_COMPACT_THRESHOLD_PERCENT,
  };
  for (const [key, policy] of result) {
    result.set(key, {
      ...policy,
      autoCompactThresholdPercent:
        policy.autoCompactThresholdPercent ??
        defaultPolicy.autoCompactThresholdPercent,
    });
  }
  const rawEnvironmentThreshold =
    process.env[PI_AUTO_COMPACT_THRESHOLD_ENV]?.trim();
  const environmentThreshold =
    rawEnvironmentThreshold && /^\d+$/u.test(rawEnvironmentThreshold)
      ? Number(rawEnvironmentThreshold)
      : undefined;
  const validEnvironmentThreshold =
    environmentThreshold !== undefined &&
    Number.isSafeInteger(environmentThreshold) &&
    environmentThreshold >= 0 &&
    environmentThreshold <= MAX_PI_COMPACTION_THRESHOLD_PERCENT
      ? environmentThreshold
      : undefined;
  if (validEnvironmentThreshold !== undefined) {
    defaultPolicy = {
      ...(defaultPolicy ?? {}),
      autoCompactThresholdPercent: validEnvironmentThreshold,
    };
    for (const [key, policy] of result) {
      result.set(key, {
        ...policy,
        autoCompactThresholdPercent: validEnvironmentThreshold,
      });
    }
  }
  return {
    ...(defaultPolicy ? { defaultPolicy } : {}),
    models: result,
  };
};

export const settingsOverridesForModel = (
  model: PiModelIdentity | undefined,
  policies: PiModelPolicySnapshot,
): PiSettingsOverrides => {
  if (!model) return {};
  const policy =
    policies.models.get(piModelPolicyKey(model)) ?? policies.defaultPolicy;
  if (!policy) return {};
  const reserveTokens = compactionReserveTokensForThreshold(
    model.contextWindow,
    policy.autoCompactThresholdPercent,
  );
  return {
    ...(policy.maxRetries !== undefined
      ? { retry: { provider: { maxRetries: policy.maxRetries } } }
      : {}),
    ...(policy.inferenceIdleTimeoutMs !== undefined
      ? { httpIdleTimeoutMs: policy.inferenceIdleTimeoutMs }
      : {}),
    ...(reserveTokens !== undefined ? { compaction: { reserveTokens } } : {}),
  };
};

/**
 * Convert Melody's inclusive percentage trigger into Pi's reserve-token
 * setting. Melody starts compaction once `used * 100 >= window * percent`,
 * while Pi starts when `used > window - reserve`. Using the first integer
 * token at or above the percentage keeps both triggers aligned, including
 * non-divisible context windows.
 */
export const compactionReserveTokensForThreshold = (
  contextWindow: number | undefined,
  thresholdPercent: number | undefined,
): number | undefined => {
  if (
    contextWindow === undefined ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    thresholdPercent === undefined
  ) {
    return undefined;
  }
  const firstTriggerToken = Math.ceil((contextWindow * thresholdPercent) / 100);
  // Pi does not need more than the whole context window reserved.  This
  // clamps the 0% edge to a practical first-token trigger while preserving
  // exact mapping for all positive thresholds.
  return Math.min(
    contextWindow,
    Math.max(0, contextWindow - firstTriggerToken + 1),
  );
};
