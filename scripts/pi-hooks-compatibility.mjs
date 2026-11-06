import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

const hookExecutionMarkers = [
  "run_tool_hooks",
  "run_event_hooks",
  "PreToolUse",
  "PostToolUseFailure",
  "env_clear",
  "MAX_HOOK_INPUT_BYTES",
  "MAX_HOOK_OUTPUT_BYTES",
];

const hookConfigMarkers = [
  "list_melody_hooks",
  "PreToolUse",
  "PostToolUseFailure",
  "MAX_HOOK_TIMEOUT_MS",
];

const hookConstants = {
  maxFiles: { name: "MAX_HOOK_FILES", owner: "hostHookConfig" },
  maxHooks: { name: "MAX_HOOKS_TOTAL", owner: "hostHookConfig" },
  maxFileBytes: { name: "MAX_HOOK_FILE_BYTES", owner: "hostHookConfig" },
  maxCommandBytes: { name: "MAX_HOOK_COMMAND_BYTES", owner: "hostHookConfig" },
  maxInputBytes: { name: "MAX_HOOK_INPUT_BYTES", owner: "hostHookExecution" },
  maxOutputBytes: {
    name: "MAX_HOOK_OUTPUT_BYTES",
    owner: "hostHookExecution",
  },
  maxTimeoutMs: { name: "MAX_HOOK_TIMEOUT_MS", owner: "hostHookConfig" },
};

/**
 * Compare the manifest Hook contract with Host inventory/execution and worker
 * routing snapshots. The aggregate checker owns repository file reads and
 * passes their contents through this fixture-testable interface.
 */
export const checkPiHooksCompatibility = (policy, sourceSnapshots) => {
  const failures = [];
  if (!policy) return failures;

  const {
    hostHookRuntime = "",
    hostHookConfig = "",
    hostHookExecution = "",
    hostConfigRuntime = "",
    workerRuntime = "",
    workerToolRouting = "",
  } = sourceSnapshots ?? {};

  for (const marker of hookExecutionMarkers) {
    if (!hostHookExecution.includes(marker)) {
      failures.push(`Host Hook bridge 缺少实现 ${marker}。`);
    }
  }
  for (const marker of hookConfigMarkers) {
    if (!hostHookConfig.includes(marker)) {
      failures.push(`Host Hook bridge 缺少实现 ${marker}。`);
    }
  }
  if (
    !hostHookRuntime.includes("mod hook_config;") ||
    !hostHookRuntime.includes("mod hook_execution;") ||
    !hostHookRuntime.includes(
      "pub(crate) use hook_config::{MelodyHookSnapshot, list_melody_hooks};",
    ) ||
    !hostHookRuntime.includes(
      "pub(crate) use hook_execution::{HookEvent, HookRunResult, run_event_hooks, run_tool_hooks};",
    ) ||
    !hostHookExecution.includes("hook_config::read_hook_specs")
  ) {
    failures.push(
      "pi_hook_runtime facade has not wired the config and execution owners.",
    );
  }
  if (!hostConfigRuntime.includes("pi_hook_runtime::list_melody_hooks")) {
    failures.push("Host 配置层没有接入 Hook 清单预检。");
  }
  if (
    !workerRuntime.includes("mod host_tool_routing;") ||
    !workerToolRouting.includes("run_host_tool_hooks(") ||
    !workerToolRouting.includes("resolve_tool_request(")
  ) {
    failures.push(
      "Host worker has not wired its tool-routing and Hook lifecycle module.",
    );
  }

  for (const [field, { name, owner }] of Object.entries(hookConstants)) {
    const expected = Number(policy[field]);
    if (!Number.isSafeInteger(expected)) continue;
    const ownerSource = sourceSnapshots?.[owner] ?? "";
    if (readNumericSourceConstant(ownerSource, name) !== expected) {
      failures.push(`Hook ${field} 上限没有同步兼容清单。`);
    }
  }

  return failures;
};
