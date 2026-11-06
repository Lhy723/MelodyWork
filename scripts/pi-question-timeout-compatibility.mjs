import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

const comparisonBound = (source, expression) => {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(
    new RegExp(`${escaped}\\s*>\\s*([0-9][0-9_]*)`, "u"),
  );
  if (!match) return undefined;
  const value = Number(match[1].replaceAll("_", ""));
  return Number.isSafeInteger(value) ? value : undefined;
};

const escapedPattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Compare Host, worker and manifest question-timeout limits and routing.
 * The aggregate compatibility checker supplies the source snapshots and
 * retains ownership of repository file reads and combined diagnostics.
 */
export const checkPiQuestionTimeoutCompatibility = ({ policy, sources }) => {
  const failures = [];
  if (!policy) return failures;

  const {
    hostConfig = "",
    hostConfigExtensions = "",
    hostResourceManifest = "",
    hostWorkerLaunch = "",
    workerToolGateway = "",
    workerSessionAdapter = "",
    workerResourceRefresh = "",
    workerResourcePolicy = "",
  } = sources ?? {};

  if (
    !hostConfigExtensions.includes("pi_question_timeout_policy") ||
    !hostConfig.includes("pub(crate) fn pi_question_timeout_policy")
  ) {
    failures.push("Host 配置层没有实现清单声明的提问等待策略解析。");
  }
  if (
    !hostResourceManifest.includes("pi_question_timeout_policy(cwd)") ||
    !hostResourceManifest.includes(`manifest["${policy.manifestField}"]`)
  ) {
    failures.push("Host 资源清单没有写入提问等待策略。");
  }
  if (
    !hostWorkerLaunch.includes(policy.manifestField) ||
    !new RegExp(
      `command\\.env\\s*\\(\\s*"${escapedPattern(policy.environmentVariable)}"\\s*,`,
      "u",
    ).test(hostWorkerLaunch)
  ) {
    failures.push("Host worker 启动链路没有传递提问等待策略环境变量。");
  }
  if (
    policy.implementation === "worker-gateway" &&
    (!workerToolGateway.includes("interactionTimeoutMsFor") ||
      !workerToolGateway.includes("questionTimeoutPolicy()"))
  ) {
    failures.push("worker ToolGateway 没有实现清单声明的提问等待策略。");
  }
  if (
    !workerSessionAdapter.includes("new PiSessionResourceRefreshRuntime") ||
    !workerSessionAdapter.includes(
      "this.sessionResourceRefresh.refresh(command, requestId)",
    ) ||
    !workerSessionAdapter.includes(
      `this.questionTimeoutPolicy = snapshot.${policy.manifestField}`,
    ) ||
    !workerResourceRefresh.includes("normalizePiResourcePolicySnapshot(") ||
    !workerResourceRefresh.includes("applyPolicySnapshot(normalizedManifest)")
  ) {
    failures.push("worker 提问等待策略没有接入资源刷新 owner。");
  }
  if (
    !workerResourcePolicy.includes(
      `const PI_QUESTION_TIMEOUT_POLICY_ENV = "${policy.environmentVariable}"`,
    )
  ) {
    failures.push("worker 提问等待策略环境变量没有同步兼容清单。");
  }

  const hostMaximum = readNumericSourceConstant(
    hostConfig,
    "PI_QUESTION_TIMEOUT_MAX_MS",
  );
  if (
    !Number.isSafeInteger(policy.maxTimeoutMs) ||
    hostMaximum !== policy.maxTimeoutMs
  ) {
    failures.push("Host 提问等待超时上限没有同步兼容清单。");
  }
  if (!hostConfig.includes(".clamp(1, PI_QUESTION_TIMEOUT_MAX_MS)")) {
    failures.push("Host 提问等待策略没有应用最大超时上限。");
  }

  const workerMaximum = readNumericSourceConstant(
    workerToolGateway,
    "PI_QUESTION_TIMEOUT_MAX_MS",
  );
  if (
    !Number.isSafeInteger(policy.maxTimeoutMs) ||
    workerMaximum !== policy.maxTimeoutMs
  ) {
    failures.push("worker ToolGateway 提问等待超时上限没有同步兼容清单。");
  }
  if (!workerToolGateway.includes("timeoutMs > PI_QUESTION_TIMEOUT_MAX_MS")) {
    failures.push("worker ToolGateway 没有应用提问等待超时上限。");
  }

  if (
    comparisonBound(workerResourcePolicy, "record.timeoutMs") !==
    policy.maxTimeoutMs
  ) {
    failures.push("worker 环境提问等待策略上限没有同步兼容清单。");
  }
  if (
    comparisonBound(workerResourcePolicy, "questionTimeoutPolicy.timeoutMs") !==
    policy.maxTimeoutMs
  ) {
    failures.push("worker 资源清单提问等待策略上限没有同步兼容清单。");
  }

  return failures;
};
