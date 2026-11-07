import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

const rustDurationMilliseconds = (source, name) => {
  const match = source.match(
    new RegExp(
      `(?:const|pub(?:\\([^)]*\\))? const)\\s+${name}\\s*:\\s*Duration\\s*=\\s*Duration::from_secs\\(\\s*([0-9][0-9_]*)\\s*\\)`,
      "u",
    ),
  );
  if (!match) return undefined;
  const seconds = Number(match[1].replaceAll("_", ""));
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
};

const sourceCallNumber = (source, pattern) => {
  const match = source.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1].replaceAll("_", ""));
  return Number.isSafeInteger(value) ? value : undefined;
};

/**
 * Compare the Host-owned foreground/background terminal contracts with their
 * worker schemas, stable tool IDs, and migration manifest. The aggregate
 * checker supplies source snapshots and keeps responsibility for file reads
 * and combined diagnostics.
 */
export const checkPiTerminalCompatibility = ({
  terminalPolicy,
  backgroundTerminalTasks,
  sources,
}) => {
  const failures = [];
  const {
    hostToolGateway = "",
    hostConfig = "",
    hostTerminalTasks = "",
    hostToolOutputArchive = "",
    workerToolSchemas = "",
    workerToolNames = "",
    workerRuntime = "",
  } = sources ?? {};

  if (terminalPolicy) {
    if (
      terminalPolicy.implementation === "host-tool-gateway" &&
      (!hostToolGateway.includes("resolve_request_with_host_policy") ||
        !hostToolGateway.includes("PiTerminalPolicy") ||
        !hostTerminalTasks.includes("run_terminal_with_policy"))
    ) {
      failures.push("Host ToolGateway 没有实现清单声明的终端策略。");
    }
    if (!hostConfig.includes("pi_terminal_policy")) {
      failures.push("Host 配置层没有实现清单声明的终端策略解析。");
    }
    for (const variable of terminalPolicy.environmentVariables ?? []) {
      if (!hostConfig.includes(variable)) {
        failures.push(`终端策略环境变量没有同步：${variable}。`);
      }
    }
    for (const path of terminalPolicy.configPaths ?? []) {
      const key = path.split(".").at(-1);
      if (key && !hostConfig.includes(`"${key}"`)) {
        failures.push(`终端策略配置项没有同步：${path}。`);
      }
    }

    const hostTimeout = readNumericSourceConstant(
      hostConfig,
      "PI_TERMINAL_ABSOLUTE_MAX_TIMEOUT_MS",
    );
    const workerTimeout = readNumericSourceConstant(
      workerToolSchemas,
      "PI_TERMINAL_MAX_TIMEOUT_MS",
    );
    if (
      !Number.isSafeInteger(terminalPolicy.maxTimeoutMs) ||
      hostTimeout !== terminalPolicy.maxTimeoutMs
    ) {
      failures.push("Host 终端超时上限没有同步兼容清单。");
    }
    if (
      !Number.isSafeInteger(terminalPolicy.maxTimeoutMs) ||
      workerTimeout !== terminalPolicy.maxTimeoutMs ||
      !workerToolSchemas.includes("maximum: PI_TERMINAL_MAX_TIMEOUT_MS")
    ) {
      failures.push("worker 终端超时上限没有同步兼容清单。");
    }

    const hostConfigOutput = readNumericSourceConstant(
      hostConfig,
      "PI_TERMINAL_DEFAULT_OUTPUT_BYTES",
    );
    const hostCaptureOutput = readNumericSourceConstant(
      hostToolOutputArchive,
      "TERMINAL_MAX_OUTPUT_BYTES",
    );
    if (
      !Number.isSafeInteger(terminalPolicy.maxOutputBytes) ||
      hostConfigOutput !== terminalPolicy.maxOutputBytes ||
      hostCaptureOutput !== terminalPolicy.maxOutputBytes
    ) {
      failures.push("Host 终端输出预览上限没有同步兼容清单。");
    }
    if (
      !hostToolOutputArchive.includes(".clamp(1, TERMINAL_MAX_OUTPUT_BYTES)")
    ) {
      failures.push("Host 终端输出预览没有应用最大字节上限。");
    }
  }

  if (backgroundTerminalTasks) {
    if (
      backgroundTerminalTasks.implementation ===
        "host-terminal-task-registry" &&
      (!hostTerminalTasks.includes("background_terminal_tasks()") ||
        !hostTerminalTasks.includes("start_background_terminal("))
    ) {
      failures.push("Host 没有实现清单声明的后台终端任务 registry。");
    }

    const taskPrefix = backgroundTerminalTasks.taskIdPrefix;
    if (
      typeof taskPrefix !== "string" ||
      !hostTerminalTasks.includes(
        `PI_BACKGROUND_TERMINAL_TASK_PREFIX: &str = "${taskPrefix}"`,
      ) ||
      !hostTerminalTasks.includes(
        `starts_with(PI_BACKGROUND_TERMINAL_TASK_PREFIX)`,
      ) ||
      !workerToolNames.includes(
        `export const PI_BACKGROUND_TERMINAL_TASK_PREFIX = "${taskPrefix}"`,
      )
    ) {
      failures.push("Host 与 worker 后台终端任务 ID 前缀没有同步。");
    }

    const activeTaskLimit = readNumericSourceConstant(
      hostTerminalTasks,
      "BACKGROUND_TERMINAL_MAX_TASKS",
    );
    if (
      !Number.isSafeInteger(backgroundTerminalTasks.maxActiveTasks) ||
      activeTaskLimit !== backgroundTerminalTasks.maxActiveTasks ||
      !hostTerminalTasks.includes("tasks.len() < BACKGROUND_TERMINAL_MAX_TASKS")
    ) {
      failures.push("Host 后台终端任务数量上限没有同步兼容清单。");
    }

    const hostWaitTimeout = rustDurationMilliseconds(
      hostTerminalTasks,
      "TERMINAL_MAX_TIMEOUT",
    );
    const gatewayWaitTimeout = sourceCallNumber(
      hostToolGateway,
      /timeout\.min\(\s*([0-9][0-9_]*)\s*\)/u,
    );
    const workerWaitTimeout = readNumericSourceConstant(
      workerToolSchemas,
      "BACKGROUND_TASK_MAX_TIMEOUT_MS",
    );
    if (
      !Number.isSafeInteger(backgroundTerminalTasks.maxWaitTimeoutMs) ||
      hostWaitTimeout !== backgroundTerminalTasks.maxWaitTimeoutMs ||
      gatewayWaitTimeout !== backgroundTerminalTasks.maxWaitTimeoutMs ||
      workerWaitTimeout !== backgroundTerminalTasks.maxWaitTimeoutMs
    ) {
      failures.push("后台终端任务等待上限没有同步兼容清单。");
    }
    if (
      (
        workerToolSchemas.match(
          /maximum:\s*BACKGROUND_TASK_MAX_TIMEOUT_MS/gu,
        ) ?? []
      ).length < 3
    ) {
      failures.push("worker 后台终端等待 schema 没有应用最大等待上限。");
    }

    const previewLimit = readNumericSourceConstant(
      hostTerminalTasks,
      "BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES",
    );
    if (
      !Number.isSafeInteger(backgroundTerminalTasks.outputPreviewBytes) ||
      previewLimit !== backgroundTerminalTasks.outputPreviewBytes ||
      !hostTerminalTasks.includes(
        "value.len() <= BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES",
      )
    ) {
      failures.push("Host 后台终端输出预览上限没有同步兼容清单。");
    }

    if (
      backgroundTerminalTasks.cancellation === "host-owned-process-kill" &&
      (!hostTerminalTasks.includes("child.kill()") ||
        !hostTerminalTasks.includes("fn request_cancel(") ||
        !hostTerminalTasks.includes("task.control.cancel.store(true"))
    ) {
      failures.push("后台终端任务没有通过 Host 进程句柄执行取消。");
    }

    if (
      backgroundTerminalTasks.workerStopCleanup === true &&
      (!hostToolGateway.includes(
        "terminal_tasks::cancel_background_tasks_for_workspace",
      ) ||
        !workerRuntime.includes("cancel_background_tasks_for_workspace") ||
        (workerRuntime.match(/cancel_background_tasks_for_workspace/g) ?? [])
          .length < 4)
    ) {
      failures.push("Pi worker 结束路径没有清理 Host 后台终端任务。");
    }
  }

  return failures;
};
