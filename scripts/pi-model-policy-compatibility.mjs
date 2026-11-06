import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

const rustPolicyFields = [
  ["max_retries", "maxRetries"],
  ["inference_idle_timeout_ms", "inferenceIdleTimeoutMs"],
  ["auto_compact_threshold_percent", "autoCompactThresholdPercent"],
];

/**
 * Compare the generated Host policy snapshot with the worker parser and the
 * compatibility manifest. Source snapshots keep this owner fixture-testable;
 * the aggregate checker remains responsible for reading files and reporting
 * missing sources.
 */
export const checkPiModelPolicyCompatibility = ({ contract, sources }) => {
  const failures = [];
  if (!contract) return failures;

  const {
    workerModelPolicy = "",
    hostModelConfig = "",
    hostModelProjection = "",
    hostModelPolicy = "",
    workerLaunch = "",
  } = sources ?? {};

  if (
    !workerModelPolicy.includes(
      `const PI_MODEL_POLICIES_PATH_ENV = "${contract.environmentVariable}"`,
    )
  ) {
    failures.push("worker 模型策略环境变量没有同步兼容清单。");
  }
  if (
    contract.thresholdEnvironmentVariable &&
    (!workerModelPolicy.includes(
      `const PI_AUTO_COMPACT_THRESHOLD_ENV = "${contract.thresholdEnvironmentVariable}"`,
    ) ||
      !workerLaunch.includes(`"${contract.thresholdEnvironmentVariable}"`))
  ) {
    failures.push("worker 自动压缩阈值环境变量没有同步兼容清单。");
  }

  const expectedWorkerLimits = [
    ["MAX_PI_POLICY_FILE_BYTES", contract.maxBytes, "模型策略文件上限"],
    ["MAX_PI_MODEL_POLICIES", contract.maxModels, "模型策略数量上限"],
    ["MAX_PI_POLICY_RETRIES", contract.maxRetries, "模型重试上限"],
    [
      "MAX_PI_COMPACTION_THRESHOLD_PERCENT",
      contract.maxAutoCompactThresholdPercent,
      "模型自动压缩阈值上限",
    ],
  ];
  for (const [name, expected, label] of expectedWorkerLimits) {
    if (readNumericSourceConstant(workerModelPolicy, name) !== expected) {
      failures.push(`worker ${label}没有同步兼容清单。`);
    }
  }

  const workerTimeoutLimit = readNumericSourceConstant(
    workerModelPolicy,
    "MAX_PI_POLICY_TIMEOUT_MS",
  );
  if (
    !Number.isSafeInteger(contract.maxIdleTimeoutMs) ||
    workerTimeoutLimit === undefined ||
    workerTimeoutLimit < contract.maxIdleTimeoutMs
  ) {
    failures.push("worker 模型空闲超时上限没有同步兼容清单。");
  }

  const policyFile = contract.file?.split(/[\\/]/u).at(-1);
  const policyDirectories = contract.file
    ?.split(/[\\/]/u)
    .filter(Boolean)
    .slice(0, -1);
  const hostPolicyPath = (policyDirectories ?? []).reduce(
    (path, directory) => `${path}.join("${directory}")`,
    "home",
  );
  if (
    !policyFile ||
    !hostModelConfig.includes(
      `const GENERATED_POLICIES_FILE: &str = "${policyFile}"`,
    )
  ) {
    failures.push("Host 模型策略文件名没有同步兼容清单。");
  }
  if (
    !policyDirectories?.length ||
    !hostModelConfig.includes(`${hostPolicyPath}.join(GENERATED_POLICIES_FILE)`)
  ) {
    failures.push("Host 模型策略文件目录没有同步兼容清单。");
  }
  if (
    !workerLaunch.includes(
      `command.env("${contract.environmentVariable}", &prepared.policies_path)`,
    )
  ) {
    failures.push("Host 没有将生成的模型策略快照路径传给 worker。");
  }

  const hostFileLimit = readNumericSourceConstant(
    hostModelConfig,
    "PI_MODELS_LIMIT_BYTES",
  );
  if (
    !Number.isSafeInteger(contract.maxBytes) ||
    hostFileLimit !== contract.maxBytes
  ) {
    failures.push("Host 模型策略文件大小上限没有同步兼容清单。");
  }

  const hostTimeoutSeconds = readNumericSourceConstant(
    hostModelPolicy,
    "MAX_PI_IDLE_TIMEOUT_SECS",
  );
  if (
    hostTimeoutSeconds === undefined ||
    !Number.isSafeInteger(hostTimeoutSeconds * 1_000) ||
    hostTimeoutSeconds * 1_000 !== contract.maxIdleTimeoutMs
  ) {
    failures.push("Host 模型空闲超时上限没有同步兼容清单。");
  }

  const hostRetryLimit = readNumericSourceConstant(
    hostModelPolicy,
    "MAX_PI_POLICY_RETRIES",
  );
  if (
    !Number.isSafeInteger(contract.maxRetries) ||
    hostRetryLimit !== contract.maxRetries ||
    !hostModelPolicy.includes("if value > MAX_PI_POLICY_RETRIES") ||
    !/bounded_retry_value\(\s*model,\s*"max_retries",\s*alias\s*\)\?/u.test(
      hostModelPolicy,
    ) ||
    !/bounded_retry_value\(\s*global,\s*"max_retries",\s*"default"\s*,?\s*\)\?/u.test(
      hostModelPolicy,
    )
  ) {
    failures.push("Host 模型重试上限没有同步兼容清单或投影未应用该上限。");
  }

  if (
    readNumericSourceConstant(
      hostModelPolicy,
      "MAX_PI_AUTO_COMPACT_THRESHOLD_PERCENT",
    ) !== contract.maxAutoCompactThresholdPercent
  ) {
    failures.push("Host 模型自动压缩阈值上限没有同步兼容清单。");
  }

  const schemaVersion = contract.schemaVersion;
  if (
    !Number.isSafeInteger(schemaVersion) ||
    !hostModelConfig.includes(
      `policy_document.insert("version".into(), Value::from(${schemaVersion}))`,
    ) ||
    !hostModelConfig.includes('"default".into()') ||
    !hostModelConfig.includes('"models".into()') ||
    !workerModelPolicy.includes("root.version") ||
    !workerModelPolicy.includes("root.default") ||
    !workerModelPolicy.includes("root.models")
  ) {
    failures.push("Host/worker 模型策略快照的版本或根字段合同不一致。");
  }

  if (
    !hostModelConfig.includes("mod model_projection;") ||
    !hostModelConfig.includes(
      "model_projection::project_projection_with_remote(",
    ) ||
    !hostModelProjection.includes("model_policy::project_policy(")
  ) {
    failures.push("Host 模型配置没有接入 projection 与 policy owners。");
  }

  if (
    !hostModelPolicy.includes('#[serde(rename_all = "camelCase")]') ||
    !hostModelPolicy.includes("struct PiModelPolicy") ||
    rustPolicyFields.some(
      ([rustName, workerName]) =>
        !hostModelPolicy.includes(`${rustName}:`) ||
        !workerModelPolicy.includes(`record.${workerName}`),
    )
  ) {
    failures.push("Host/worker 模型策略字段投影合同不一致。");
  }

  return failures;
};
