import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

/** Read only the top-level property names from a TypeBox object declaration. */
const schemaTopLevelKeys = (source, name) => {
  const marker = `const ${name} = Type.Object(`;
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  let index = source.indexOf("{", start + marker.length - 1);
  if (index < 0) return undefined;
  const open = index;
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return undefined;

  const body = source.slice(open + 1, end);
  const keys = [];
  let inner = 0;
  inString = false;
  escaped = false;
  let atLineStart = true;
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    const character = body[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (atLineStart && inner === 0) {
      const match = /^([a-z_]+):/.exec(body.slice(cursor, cursor + 64));
      if (match) keys.push(match[1]);
    }
    if (character === "\n") {
      atLineStart = true;
      continue;
    }
    if (character !== " " && character !== "\t" && atLineStart)
      atLineStart = false;
    if (character === "{" || character === "[") inner += 1;
    if (character === "}" || character === "]") inner -= 1;
  }
  return keys;
};

const schemaFor = {
  scheduler_create: "schedulerCreateParameters",
  scheduler_list: "schedulerListParameters",
  scheduler_delete: "schedulerDeleteParameters",
};

/**
 * Compare the Host-owned schedule bridge contract across worker and Host source.
 * Inputs are source snapshots so the aggregate checker retains file I/O and
 * this owner can be tested entirely through deterministic fixtures.
 */
export const checkPiAgentScheduleCompatibility = ({ contract, sources }) => {
  const failures = [];
  if (!contract) return failures;

  const {
    workerToolNames = "",
    workerToolSchemas = "",
    hostRequestPolicy = "",
    hostToolGateway = "",
    schedulerTools = "",
    schedulesStore = "",
    schedulePolicy = "",
  } = sources ?? {};

  for (const tool of contract.tools ?? []) {
    const constant = tool.replace(/^scheduler_/, "").toUpperCase();
    if (
      !workerToolNames.includes(`export const PI_SCHEDULER_${constant}`) ||
      !hostRequestPolicy.includes(`pub(crate) const SCHEDULER_${constant}`)
    ) {
      failures.push(`${tool} 工具没有在 worker 与 Host 之间同步。`);
    }
  }

  if (!hostToolGateway.includes("scheduler_tools::scheduler_tool")) {
    failures.push("Host 网关没有调度工具的入口。");
  }
  // The model must never be able to choose its own authority: the schedule
  // identity has to be copied from the live session binding.
  if (!schedulesStore.includes("agent_session_bindings")) {
    failures.push(
      "Host 调度器没有从会话绑定继承身份（模型不能自行放宽权限）。",
    );
  }
  const maximumInterval = readNumericSourceConstant(
    schedulePolicy,
    "MAX_SCHEDULE_INTERVAL_MS",
  );
  if (
    !schedulesStore.includes("MAX_SCHEDULE_INTERVAL_MS") ||
    maximumInterval === undefined
  ) {
    failures.push("Host 调度器没有实现间隔上限。");
  } else if (
    !Number.isSafeInteger(contract.maxIntervalMs) ||
    maximumInterval !== contract.maxIntervalMs
  ) {
    failures.push("Host 调度器最大间隔上限与兼容清单不一致。");
  }

  // Both directions of the tool contract: every advertised argument must be
  // read by the Host, and the worker must not advertise a field the Host
  // silently ignores (the model would ask for it and get something else).
  for (const [tool, fields] of Object.entries(contract.toolFields ?? {})) {
    const schemaName = schemaFor[tool];
    const declared = schemaTopLevelKeys(workerToolSchemas, schemaName);
    if (declared === undefined) {
      failures.push(`worker 缺少 ${schemaName} 或无法解析。`);
      continue;
    }
    const advertised = [...declared].sort().join();
    const honored = [...fields].sort().join();
    if (advertised !== honored) {
      failures.push(
        `${tool} 的参数与清单不一致：worker 声明 [${advertised}]，清单 [${honored}]。`,
      );
    }
    for (const field of fields) {
      if (!schedulerTools.includes(`.get("${field}")`)) {
        failures.push(`${tool} 的参数 ${field} 没有被 Host 读取。`);
      }
    }
  }

  return failures;
};
