import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const failures = [];

const readJson = (relativePath) => {
  try {
    return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
  } catch (error) {
    failures.push(`${relativePath}: 无法读取 JSON（${error.message}）`);
    return undefined;
  }
};

const manifest = readJson(
  "docs/architecture/pi-migration/pi-compatibility-manifest.json",
);

const rustMainPath = resolve(root, "src-tauri/src/lib.rs");
const tauriPermissionPath = resolve(root, "src-tauri/permissions/default.toml");
try {
  const rustMain = readFileSync(rustMainPath, "utf8");
  const handlerMatch = rustMain.match(
    /tauri::generate_handler!\s*\[([\s\S]*?)\]/u,
  );
  const permissionSource = readFileSync(tauriPermissionPath, "utf8");
  const permissionMatch = permissionSource.match(
    /commands\.allow\s*=\s*\[([\s\S]*?)\]/u,
  );
  if (!handlerMatch) {
    failures.push("Tauri invoke_handler 注册清单无法读取。");
  } else if (!permissionMatch) {
    failures.push("Tauri 主窗口 command allowlist 无法读取。");
  } else {
    const registeredCommands = new Set(
      handlerMatch[1]
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/.*$/gmu, "")
        .split(",")
        .map((entry) => entry.trim().split("::").at(-1))
        .filter(Boolean),
    );
    const allowedCommands = new Set(
      [...permissionMatch[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
    );
    const frontendFiles = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(?:ts|tsx)$/u.test(entry.name)) frontendFiles.push(path);
      }
    };
    visit(resolve(root, "src"));

    const invokedCommands = new Set();
    for (const path of frontendFiles) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(
        /\binvoke(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/gu,
      )) {
        invokedCommands.add(match[1]);
      }
    }

    for (const command of [...invokedCommands].sort()) {
      if (registeredCommands.has(command) && !allowedCommands.has(command)) {
        failures.push(
          `前端调用的 Tauri 命令 ${command} 未加入主窗口权限白名单。`,
        );
      }
    }
  }
} catch (error) {
  failures.push(`Tauri command permissions: ${error.message}`);
}

/**
 * Read the top-level keys of a typebox schema by brace matching.
 *
 * A regex over the declaration would silently include keys of the next schema
 * (or miss a single-line `Type.Object({})`), which is exactly the kind of drift
 * this check exists to catch. Braces inside string literals (descriptions) are
 * skipped, and indices stay aligned because nothing is rewritten in place.
 */
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
const workerPackage = readJson("packages/agent-worker/package.json");
const adapterPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-adapter.ts",
);
const todoExtensionPath = resolve(
  root,
  "packages/agent-worker/src/pi/todo-extension.ts",
);
const goalExtensionPath = resolve(
  root,
  "packages/agent-worker/src/pi/goal-extension.ts",
);
const importPath = resolve(
  root,
  "packages/agent-worker/src/pi/session-import.ts",
);
const modesPath = resolve(root, "packages/agent-contract/src/session-modes.ts");
const toolGatewayPath = resolve(root, "src-tauri/src/pi_tool_gateway.rs");
const workerToolGatewayPath = resolve(
  root,
  "packages/agent-worker/src/pi/tool-gateway.ts",
);
const configExtensionsPath = resolve(
  root,
  "src-tauri/src/config_extensions.rs",
);
const workerRuntimePath = resolve(root, "src-tauri/src/pi_worker_runtime.rs");
const memoryRuntimePath = resolve(root, "src-tauri/src/pi_memory_runtime.rs");
const configRuntimePath = resolve(root, "src-tauri/src/config_runtime.rs");
const lspRuntimePath = resolve(root, "src-tauri/src/pi_lsp_runtime.rs");
const codebaseRuntimePath = resolve(
  root,
  "src-tauri/src/pi_codebase_runtime.rs",
);
const hookRuntimePath = resolve(root, "src-tauri/src/pi_hook_runtime.rs");
const configPluginDetailsPath = resolve(
  root,
  "src-tauri/src/config_plugin_details.rs",
);
const configSubagentsPath = resolve(root, "src-tauri/src/config_subagents.rs");
const workerPolicyPath = resolve(
  root,
  "packages/agent-worker/src/pi/subagent-policy.ts",
);

let adapter = "";
let todoExtension = "";
let goalExtension = "";
let importModule = "";
let modesModule = "";
let toolGateway = "";
let workerToolGateway = "";
let configExtensions = "";
let workerRuntime = "";
let memoryRuntime = "";
let configRuntime = "";
let lspRuntime = "";
let codebaseRuntime = "";
let hookRuntime = "";
let configPluginDetails = "";
let configSubagents = "";
let workerPolicy = "";
try {
  adapter = readFileSync(adapterPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-adapter.ts: ${error.message}`,
  );
}
try {
  todoExtension = readFileSync(todoExtensionPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/todo-extension.ts: ${error.message}`,
  );
}
try {
  goalExtension = readFileSync(goalExtensionPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/goal-extension.ts: ${error.message}`,
  );
}
try {
  importModule = readFileSync(importPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/session-import.ts: ${error.message}`,
  );
}
try {
  modesModule = readFileSync(modesPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-contract/src/session-modes.ts: ${error.message}`,
  );
}
try {
  toolGateway = readFileSync(toolGatewayPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_tool_gateway.rs: ${error.message}`);
}
try {
  workerToolGateway = readFileSync(workerToolGatewayPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/tool-gateway.ts: ${error.message}`,
  );
}
try {
  configExtensions = readFileSync(configExtensionsPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_extensions.rs: ${error.message}`);
}
try {
  workerRuntime = readFileSync(workerRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_worker_runtime.rs: ${error.message}`);
}
try {
  memoryRuntime = readFileSync(memoryRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_memory_runtime.rs: ${error.message}`);
}
try {
  configRuntime = readFileSync(configRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_runtime.rs: ${error.message}`);
}
try {
  lspRuntime = readFileSync(lspRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_lsp_runtime.rs: ${error.message}`);
}
try {
  codebaseRuntime = readFileSync(codebaseRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_codebase_runtime.rs: ${error.message}`);
}
try {
  hookRuntime = readFileSync(hookRuntimePath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/pi_hook_runtime.rs: ${error.message}`);
}
try {
  configPluginDetails = readFileSync(configPluginDetailsPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_plugin_details.rs: ${error.message}`);
}
try {
  configSubagents = readFileSync(configSubagentsPath, "utf8");
} catch (error) {
  failures.push(`src-tauri/src/config_subagents.rs: ${error.message}`);
}
try {
  workerPolicy = readFileSync(workerPolicyPath, "utf8");
} catch (error) {
  failures.push(
    `packages/agent-worker/src/pi/subagent-policy.ts: ${error.message}`,
  );
}

if (manifest && workerPackage) {
  const packages = manifest.pi?.npmPackages ?? {};
  for (const [packageName, version] of Object.entries(packages)) {
    if (workerPackage.dependencies?.[packageName] !== version) {
      failures.push(
        `${packageName} 依赖版本漂移：清单要求 ${version}，实际为 ${workerPackage.dependencies?.[packageName] ?? "未声明"}。`,
      );
    }
  }

  const piVersion = manifest.pi?.version;
  if (!adapter.includes(`engineVersion: "${piVersion}"`)) {
    failures.push(`worker 能力声明没有同步 Pi 版本 ${piVersion}。`);
  }
  if (adapter.includes('engineVersion: "') && !piVersion) {
    failures.push("Pi 兼容清单缺少 pi.version。");
  }
  if (!adapter.includes(`protocolVersion: ${manifest.pi?.protocolVersion}`)) {
    failures.push(
      `worker 能力声明没有同步协议版本 ${manifest.pi?.protocolVersion}。`,
    );
  }
  if (!adapter.includes(`engine: "${manifest.worker?.engine}"`)) {
    failures.push(`worker 能力声明没有同步引擎 ${manifest.worker?.engine}。`);
  }

  for (const tool of manifest.worker?.tools ?? []) {
    if (
      !adapter.includes(`"${tool}"`) &&
      !todoExtension.includes(`"${tool}"`) &&
      !goalExtension.includes(`"${tool}"`) &&
      !workerToolGateway.includes(`"${tool}"`)
    ) {
      failures.push(`worker 能力声明缺少工具 ${tool}。`);
    }
  }
  // The strongest form of this check: import the worker's actual capability
  // object and compare the announced tool set with the manifest. Source-text
  // matching cannot tell a registered tool from a mentioned string, and an
  // announcement that silently omits a tool is exactly the drift that shipped a
  // duplicate tool card with raw arguments for `monitor`/`scheduler_*`.
  const runtimeCapabilities = (() => {
    const probe = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import { PI_CAPABILITIES } from ${JSON.stringify(
          `file://${resolve(root, "packages/agent-worker/src/pi/session-adapter.ts")}`,
        )}; process.stdout.write(JSON.stringify({ tools: PI_CAPABILITIES.tools, limitations: PI_CAPABILITIES.limitations, diagnostics: PI_CAPABILITIES.diagnostics }));`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    if (probe.status !== 0) {
      failures.push(
        `无法读取 worker 运行时能力清单：${(probe.stderr || "").trim().split("\n").at(-1) ?? "unknown error"}`,
      );
      return undefined;
    }
    try {
      return JSON.parse(probe.stdout);
    } catch (error) {
      failures.push(`worker 运行时能力清单不是有效 JSON：${error.message}`);
      return undefined;
    }
  })();
  if (runtimeCapabilities) {
    const announced = new Set(runtimeCapabilities.tools ?? []);
    const declared = new Set(manifest.worker?.tools ?? []);
    for (const tool of declared) {
      if (!announced.has(tool)) {
        failures.push(`worker 运行时没有宣告工具 ${tool}（清单已声明）。`);
      }
    }
    for (const tool of announced) {
      if (!declared.has(tool)) {
        failures.push(`worker 运行时宣告了清单外的工具 ${tool}。`);
      }
    }

    if (manifest.worker?.runtimeFallback !== "none") {
      failures.push(
        "Pi 兼容清单必须声明 runtimeFallback=none（Pi 不得回退到 ACP）。",
      );
    }
    const fallbackClaim =
      /(?:回退到|回退|fallback|route(?:d|s)? to)\s*(?:ACP|Legacy|兼容引擎)|(?:ACP|Legacy|兼容引擎)\s*(?:fallback|回退)|ACP-backed/iu;
    for (const [index, limitation] of (
      runtimeCapabilities.limitations ?? []
    ).entries()) {
      if (fallbackClaim.test(limitation)) {
        failures.push(
          `worker limitation #${index + 1} 仍声称运行时可回退到 ACP/兼容引擎。`,
        );
      }
    }
    for (const diagnostic of runtimeCapabilities.diagnostics ?? []) {
      if (diagnostic.fallbackEngine) {
        failures.push(
          `Pi 运行时诊断 ${diagnostic.code} 仍设置 fallbackEngine=${diagnostic.fallbackEngine}。`,
        );
      }
      if (fallbackClaim.test(diagnostic.message ?? "")) {
        failures.push(
          `Pi 运行时诊断 ${diagnostic.code} 仍声称运行时可回退到 ACP/兼容引擎。`,
        );
      }
    }
    const browserLimitation = (runtimeCapabilities.limitations ?? []).find(
      (item) => item.includes("browser_"),
    );
    if (!browserLimitation) {
      failures.push("Pi Browser 能力缺少运行时限制说明。");
    } else if (
      /workspace-embedded rendering.{0,128}unsupported|(?:multiple tabs|screenshots|local preview|popup-based login).{0,48}(?:remain|are) unsupported/iu.test(
        browserLimitation,
      )
    ) {
      failures.push(
        "Pi Browser limitation 把已实现的嵌入视图、多标签、截图、本地预览或弹窗登录误报为不支持。",
      );
    }
    if (
      /(?:legacy-acp|melody-acp|legacy\s+ACP)/iu.test(
        JSON.stringify(manifest.hostBridges ?? {}),
      )
    ) {
      failures.push("Pi Host bridge 清单仍将 ACP 描述为运行时 fallback。");
    }
  }
  // The monitor tool is declared by the worker and executed by the Host
  // gateway; a drift on either side would advertise a tool that cannot run.
  if ((manifest.worker?.tools ?? []).includes("monitor")) {
    if (
      !workerToolGateway.includes('export const PI_MONITOR = "monitor"') ||
      !toolGateway.includes('pub(crate) const MONITOR: &str = "monitor";') ||
      !toolGateway.includes("MONITOR => ")
    ) {
      failures.push("monitor 工具没有在 worker 与 Host 之间同步。");
    }
  }
  // Same contract for the schedule tools: the worker declares them, the Host
  // owns the durable store and the per-session identity snapshot.
  const agentSchedules = manifest.hostBridges?.agentSchedules;
  if (agentSchedules) {
    for (const tool of agentSchedules.tools ?? []) {
      const constant = tool.replace(/^scheduler_/, "").toUpperCase();
      if (
        !workerToolGateway.includes(`export const PI_SCHEDULER_${constant}`) ||
        !toolGateway.includes(`pub(crate) const SCHEDULER_${constant}`)
      ) {
        failures.push(`${tool} 工具没有在 worker 与 Host 之间同步。`);
      }
    }
    const schedulesSource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/database_agent_schedules.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `src-tauri/src/database_agent_schedules.rs: ${error.message}`,
        );
        return "";
      }
    })();
    if (!toolGateway.includes("fn scheduler_tool(")) {
      failures.push("Host 网关没有调度工具的入口。");
    }
    // The model must never be able to choose its own authority: the schedule
    // identity has to be copied from the live session binding.
    if (!schedulesSource.includes("agent_session_bindings")) {
      failures.push(
        "Host 调度器没有从会话绑定继承身份（模型不能自行放宽权限）。",
      );
    }
    if (!schedulesSource.includes("MAX_SCHEDULE_INTERVAL_MS")) {
      failures.push("Host 调度器没有实现间隔上限。");
    }
    // Both directions of the tool contract: every advertised argument must be
    // read by the Host, and the worker must not advertise a field the Host
    // silently ignores (the model would ask for it and get something else).
    const schemaFor = {
      scheduler_create: "schedulerCreateParameters",
      scheduler_list: "schedulerListParameters",
      scheduler_delete: "schedulerDeleteParameters",
    };
    // The gateway is a large Rust file; scope the read check to the dispatcher.
    const dispatcherStart = toolGateway.indexOf("fn scheduler_tool(");
    const dispatcherEnd = toolGateway.indexOf("\nfn ", dispatcherStart + 1);
    const dispatcher = toolGateway.slice(
      dispatcherStart,
      dispatcherEnd > 0 ? dispatcherEnd : toolGateway.length,
    );
    for (const [tool, fields] of Object.entries(
      agentSchedules.toolFields ?? {},
    )) {
      const schemaName = schemaFor[tool];
      const declared = schemaTopLevelKeys(workerToolGateway, schemaName);
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
        if (!dispatcher.includes(`.get("${field}")`)) {
          failures.push(`${tool} 的参数 ${field} 没有被 Host 读取。`);
        }
      }
    }
  }

  for (const mode of manifest.worker?.sessionModes ?? []) {
    if (!modesModule.includes(`"${mode}"`)) {
      failures.push(`worker 能力声明缺少会话模式 ${mode}。`);
    }
  }
  for (const media of manifest.worker?.media ?? []) {
    if (!adapter.includes(`"${media}"`)) {
      failures.push(`worker 能力声明缺少媒体能力 ${media}。`);
    }
  }

  const nativeFormat = manifest.pi?.nativeSessionFormat;
  if (!importModule.includes(`version: ${nativeFormat}`)) {
    failures.push(
      `Pi 导入物化格式没有同步 nativeSessionFormat ${nativeFormat}。`,
    );
  }

  const modelPolicySnapshot = manifest.hostBridges?.modelPolicySnapshot;
  if (modelPolicySnapshot) {
    if (
      !adapter.includes(
        `const PI_MODEL_POLICIES_PATH_ENV = "${modelPolicySnapshot.environmentVariable}"`,
      )
    ) {
      failures.push("worker 模型策略环境变量没有同步兼容清单。");
    }
    if (
      modelPolicySnapshot.thresholdEnvironmentVariable &&
      !adapter.includes(
        `const PI_AUTO_COMPACT_THRESHOLD_ENV = "${modelPolicySnapshot.thresholdEnvironmentVariable}"`,
      )
    ) {
      failures.push("worker 自动压缩阈值环境变量没有同步兼容清单。");
    }
    const numericConstant = (name) => {
      const match = adapter.match(new RegExp(`const ${name} = ([^;]+);`, "u"));
      if (!match) return undefined;
      const terms = match[1]
        .split("*")
        .map((term) => Number(term.trim().replaceAll("_", "")));
      return terms.every(Number.isSafeInteger)
        ? terms.reduce((total, term) => total * term, 1)
        : undefined;
    };
    for (const [name, expected, label] of [
      [
        "MAX_PI_POLICY_FILE_BYTES",
        modelPolicySnapshot.maxBytes,
        "模型策略文件上限",
      ],
      [
        "MAX_PI_MODEL_POLICIES",
        modelPolicySnapshot.maxModels,
        "模型策略数量上限",
      ],
      ["MAX_PI_POLICY_RETRIES", modelPolicySnapshot.maxRetries, "模型重试上限"],
      [
        "MAX_PI_COMPACTION_THRESHOLD_PERCENT",
        modelPolicySnapshot.maxAutoCompactThresholdPercent,
        "模型自动压缩阈值上限",
      ],
    ]) {
      if (numericConstant(name) !== expected) {
        failures.push(`worker ${label}没有同步兼容清单。`);
      }
    }
    const timeoutLimit = modelPolicySnapshot.maxIdleTimeoutMs;
    const workerTimeoutLimit = numericConstant("MAX_PI_POLICY_TIMEOUT_MS");
    if (
      !Number.isSafeInteger(timeoutLimit) ||
      workerTimeoutLimit === undefined ||
      !Number.isSafeInteger(workerTimeoutLimit) ||
      workerTimeoutLimit < timeoutLimit
    ) {
      failures.push("worker 模型空闲超时上限没有同步兼容清单。");
    }
  }

  const promptTemplates = manifest.hostBridges?.promptTemplates;
  if (promptTemplates) {
    if (
      !adapter.includes(
        `const PI_PROMPT_PATHS_ENV = "${promptTemplates.environmentVariable}"`,
      )
    ) {
      failures.push("worker prompt template 环境变量没有同步兼容清单。");
    }
    if (
      promptTemplates.rootsEnvironmentVariable &&
      !adapter.includes(
        `const PI_PROMPT_ROOTS_ENV = "${promptTemplates.rootsEnvironmentVariable}"`,
      )
    ) {
      failures.push("worker prompt template 根目录环境变量没有同步兼容清单。");
    }
    const numericConstant = (name) => {
      const match = adapter.match(new RegExp(`const ${name} = ([^;]+);`, "u"));
      if (!match) return undefined;
      const terms = match[1]
        .split("*")
        .map((term) => Number(term.trim().replaceAll("_", "")));
      return terms.every(Number.isSafeInteger)
        ? terms.reduce((total, term) => total * term, 1)
        : undefined;
    };
    for (const [name, expected, label] of [
      [
        "MAX_PI_PROMPT_PATHS",
        promptTemplates.maxPaths,
        "prompt template 数量上限",
      ],
      [
        "MAX_PI_PROMPT_FILE_BYTES",
        promptTemplates.maxFileBytes,
        "prompt template 单文件上限",
      ],
      [
        "MAX_PI_PROMPT_TOTAL_BYTES",
        promptTemplates.maxTotalBytes,
        "prompt template 总量上限",
      ],
    ]) {
      if (numericConstant(name) !== expected) {
        failures.push(`worker ${label}没有同步兼容清单。`);
      }
    }
    if (
      promptTemplates.flatCommandsOnly &&
      !adapter.includes("isDirectChild")
    ) {
      failures.push("worker prompt template 没有保持平面 commands 目录边界。");
    }
  }

  const skillPaths = manifest.hostBridges?.skillPaths;
  if (skillPaths) {
    if (
      !adapter.includes(
        `const PI_SKILL_PATHS_ENV = "${skillPaths.environmentVariable}"`,
      )
    ) {
      failures.push("worker Skill 路径环境变量没有同步兼容清单。");
    }
    if (
      skillPaths.rootsEnvironmentVariable &&
      !adapter.includes(
        `const PI_SKILL_ROOTS_ENV = "${skillPaths.rootsEnvironmentVariable}"`,
      )
    ) {
      failures.push("worker Skill 根目录环境变量没有同步兼容清单。");
    }
    const numericConstant = (name) => {
      const match = adapter.match(new RegExp(`const ${name} = ([^;]+);`, "u"));
      if (!match) return undefined;
      const terms = match[1]
        .split("*")
        .map((term) => Number(term.trim().replaceAll("_", "")));
      return terms.every(Number.isSafeInteger)
        ? terms.reduce((total, term) => total * term, 1)
        : undefined;
    };
    for (const [name, expected, label] of [
      ["MAX_PI_SKILL_PATHS", skillPaths.maxPaths, "Skill 路径数量上限"],
      ["MAX_PI_SKILL_DEPTH", skillPaths.maxDepth, "Skill 路径深度上限"],
      ["MAX_PI_SKILL_FILE_BYTES", skillPaths.maxFileBytes, "Skill 单文件上限"],
      ["MAX_PI_SKILL_TOTAL_BYTES", skillPaths.maxTotalBytes, "Skill 总量上限"],
    ]) {
      if (numericConstant(name) !== expected) {
        failures.push(`worker ${label}没有同步兼容清单。`);
      }
    }
    if (
      skillPaths.externalMarkdownOnly &&
      (!adapter.includes("isWithinRoot") || !adapter.includes("realpathSync"))
    ) {
      failures.push("worker Skill 没有保持外部 Markdown 根目录边界。");
    }
    if (skillPaths.pluginStaticResources) {
      if (
        !adapter.includes("discoverPluginRoots") ||
        !adapter.includes("isPluginRoot") ||
        !configExtensions.includes("pi_plugin_resources")
      ) {
        failures.push(
          "静态插件 Skill/命令没有接入 Host 与 worker 的受控投影。",
        );
      }
      for (const [name, expected, label] of [
        [
          "MAX_PI_PLUGIN_ROOTS",
          skillPaths.maxPluginRoots,
          "插件根目录数量上限",
        ],
        [
          "MAX_PI_PLUGIN_SCAN_DEPTH",
          skillPaths.maxPluginScanDepth,
          "插件扫描深度上限",
        ],
        [
          "MAX_PI_PLUGIN_SCAN_ENTRIES",
          skillPaths.maxPluginScanEntries,
          "插件扫描条目上限",
        ],
      ]) {
        const rustMatch = configExtensions.match(
          new RegExp(
            `(?:const|pub\\(crate\\) const) ${name}[^=]*=\\s*([^;]+);`,
            "u",
          ),
        );
        const actual = rustMatch
          ? rustMatch[1]
              .split("*")
              .map((term) => Number(term.replaceAll("_", "").trim()))
              .reduce((total, term) => total * term, 1)
          : undefined;
        if (actual !== expected) {
          failures.push(`Host ${label}没有同步兼容清单。`);
        }
      }
      const activation = skillPaths.pluginActivation;
      if (
        activation?.explicitEnablement &&
        !(
          configExtensions.includes("if listed(&self.disabled)") &&
          configExtensions.includes("listed(&self.enabled)")
        )
      ) {
        failures.push(
          "Host 插件启用判定没有保持 Melody 的“显式启用且未禁用”语义。",
        );
      }
      if (activation?.configuredPaths) {
        if (
          !configExtensions.includes(
            'merged_config_array(cwd, "plugins", "paths")',
          )
        ) {
          failures.push("Host 没有扫描 [plugins].paths。");
        }
        const bound = configExtensions.match(
          /const MAX_PI_PLUGIN_PATH_ENTRIES: usize = (\d+);/u,
        );
        if (
          !bound ||
          Number(bound[1]) !== activation.configuredPaths.maxEntries
        ) {
          failures.push("[plugins].paths 数量上限没有同步兼容清单。");
        }
        if (!configExtensions.includes('scope == "config"')) {
          failures.push("Host 没有按配置来源自动启用 [plugins].paths 插件。");
        }
      }
      if (
        Array.isArray(activation?.nameConflictPrecedence) &&
        !configExtensions.includes("fn scope_rank")
      ) {
        failures.push("Host 没有按 name 优先级解决插件重名。");
      }
      // A plugin is only Markdown-only once its declarative surfaces no longer
      // count as dynamic; the skill/command/agent roots have to stay wired.
      if (
        skillPaths.pluginStaticResources &&
        (!configExtensions.includes("agent_roots") ||
          !configPluginDetails.includes('"agents"'))
      ) {
        failures.push("Host 插件声明式 agent 根目录没有接入投影。");
      }
      const skillIgnore = skillPaths.skillIgnore;
      if (skillIgnore) {
        if (
          !configExtensions.includes("fn pi_skill_ignore_paths") ||
          !configExtensions.includes("ignorePaths") ||
          !adapter.includes("ignorePaths")
        ) {
          failures.push("[skills].ignore 没有在 Host 与 worker 之间同步。");
        }
        const hostBound = configExtensions.match(
          /const MAX_PI_SKILL_IGNORE_PATHS: usize = (\d+);/u,
        );
        if (!hostBound || Number(hostBound[1]) !== skillIgnore.maxPaths) {
          failures.push("Host [skills].ignore 数量上限没有同步兼容清单。");
        }
        const workerBound = adapter.match(
          /const MAX_PI_SKILL_IGNORE_PATHS = (\d+);/u,
        );
        if (!workerBound || Number(workerBound[1]) !== skillIgnore.maxPaths) {
          failures.push("worker [skills].ignore 数量上限没有同步兼容清单。");
        }
        const byteBound = configExtensions.match(
          /const MAX_PI_SKILL_IGNORE_BYTES: usize = (\d+);/u,
        );
        if (
          !byteBound ||
          Number(byteBound[1]) !== skillIgnore.maxBytesPerPath
        ) {
          failures.push("Host [skills].ignore 单条长度上限没有同步兼容清单。");
        }
        if (!adapter.includes("isIgnoredPath")) {
          failures.push("worker 没有按前缀过滤被忽略的 Skill。");
        }
      }
    }
  }

  const subagentPolicy = manifest.hostBridges?.subagentPolicy;
  if (subagentPolicy?.mcpToolGrants) {
    const grants = subagentPolicy.mcpToolGrants;
    if (
      !configSubagents.includes("fn valid_mcp_tool_name") ||
      !configSubagents.includes("mcpTools") ||
      !adapter.includes("mcpTools") ||
      !workerPolicy.includes("mcpTools")
    ) {
      failures.push("MCP 工具授权没有在 Host 与 worker 之间同步。");
    }
    const hostBound = configSubagents.match(
      /const MAX_MCP_TOOL_GRANTS: usize = (\d+);/u,
    );
    if (!hostBound || Number(hostBound[1]) !== grants.maxTools) {
      failures.push("Host MCP 授权数量上限没有同步兼容清单。");
    }
    const workerBound = workerPolicy.match(/const MAX_MCP_TOOLS = (\d+);/u);
    if (!workerBound || Number(workerBound[1]) !== grants.maxTools) {
      failures.push("worker MCP 授权数量上限没有同步兼容清单。");
    }
    if (!workerToolGateway.includes("mcp__${server}__${tool}")) {
      failures.push("worker 没有按 mcp__<server>__<tool> 校验 MCP 授权。");
    }
  }
  if (subagentPolicy?.toolAllowlistMapping) {
    if (!configSubagents.includes("fn apply_agent_tool_ceiling")) {
      failures.push("Host 没有把工具白名单换算为 Pi 能力档。");
    }
    for (const mode of ["read-write-execute"]) {
      if (
        !configSubagents.includes(`"${mode}"`) ||
        !workerToolGateway.includes(`"${mode}"`)
      ) {
        failures.push(`Host/worker 能力档 ${mode} 没有同步。`);
      }
    }
  }

  const sandbox = manifest.hostBridges?.sandbox;
  if (sandbox) {
    const sandboxSource = (() => {
      try {
        return readFileSync(
          resolve(root, "src-tauri/src/workspace_sandbox.rs"),
          "utf8",
        );
      } catch (error) {
        failures.push(`src-tauri/src/workspace_sandbox.rs: ${error.message}`);
        return "";
      }
    })();
    const libSource = (() => {
      try {
        return readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
      } catch (error) {
        failures.push(`src-tauri/src/lib.rs: ${error.message}`);
        return "";
      }
    })();
    // Match the enforced branch, not the availability probe: a check that
    // passes on the `exists()` line would not notice a broken wrapper.
    if (
      !sandboxSource.includes('program: PathBuf::from("/usr/bin/sandbox-exec")')
    ) {
      failures.push("Host 终端沙箱没有接入 macOS Seatbelt 包装。");
    }
    if (!sandboxSource.includes("canonical(")) {
      failures.push(
        "Host 终端沙箱没有 canonicalize 路径（Seatbelt 按解析后路径匹配）。",
      );
    }
    if (!sandboxSource.includes('"read-only" | "readonly" | "strict"')) {
      failures.push("Host 终端沙箱没有把网络受限 profile 判为不可执行。");
    }
    if (
      !sandboxSource.includes("pub fn read_workspace_sandbox_plan") ||
      !libSource.includes("read_workspace_sandbox_plan")
    ) {
      failures.push("Host 沙箱预检命令没有定义并注册。");
    }
    void configRuntime;
  }

  const compaction = manifest.hostBridges?.compaction;
  if (compaction) {
    const compactionSource = (() => {
      try {
        return readFileSync(
          resolve(root, "packages/agent-worker/src/pi/compaction-extension.ts"),
          "utf8",
        );
      } catch (error) {
        failures.push(
          `packages/agent-worker/src/pi/compaction-extension.ts: ${error.message}`,
        );
        return "";
      }
    })();
    if (!compactionSource.includes('pi.on("session_before_compact"')) {
      failures.push(
        "worker 压缩扩展没有挂在 Pi 的 session_before_compact 上。",
      );
    }
    if (
      !compactionSource.includes("compact(") ||
      !compactionSource.includes("memoryFlushPrompt")
    ) {
      failures.push("worker 压缩扩展丢失了两遍式压缩的某一遍。");
    }
    for (const entry of compaction.taskDigest?.sources ?? []) {
      // The digest reads tracker state through the same reconstruct helpers the
      // tools use, so the check follows the import to the owning extension.
      const owner = entry.replace(/^melody\./, "").replace(/_state$/, "");
      if (
        !compactionSource.includes(`from "./${owner}-extension.ts"`) ||
        !compactionSource.includes(
          `reconstruct${owner[0].toUpperCase()}${owner.slice(1)}State`,
        )
      ) {
        failures.push(`worker 压缩摘要没有读取 ${entry}。`);
      }
    }
    // Fail-open is the contract: a broken flush must never strand a session.
    if (!compactionSource.includes("compactTaskStateOnly")) {
      failures.push("worker 压缩扩展缺少失败兜底路径。");
    }
  }

  const gitignorePolicy = manifest.hostBridges?.gitignorePolicy;
  if (gitignorePolicy) {
    const environmentVariable = gitignorePolicy.environmentVariable;
    if (
      !adapter.includes(
        `const PI_RESPECT_GITIGNORE_ENV = "${environmentVariable}"`,
      )
    ) {
      failures.push("worker .gitignore 策略环境变量没有同步兼容清单。");
    }
    if (
      gitignorePolicy.manifestField &&
      !adapter.includes(gitignorePolicy.manifestField)
    ) {
      failures.push("worker .gitignore 策略清单字段没有同步。");
    }
    if (
      gitignorePolicy.implementation === "host-tool-gateway" &&
      (!toolGateway.includes("resolve_request_with_policy") ||
        !toolGateway.includes("gitignore_walk_builder"))
    ) {
      failures.push("Host ToolGateway 没有实现清单声明的 .gitignore 策略。");
    }
    const rustConstants = {
      workspace_read_file: "WORKSPACE_READ_FILE",
      workspace_search: "WORKSPACE_SEARCH",
      workspace_list_directory: "WORKSPACE_LIST_DIRECTORY",
      workspace_edit: "WORKSPACE_EDIT",
      workspace_apply_patch: "WORKSPACE_APPLY_PATCH",
    };
    for (const tool of gitignorePolicy.appliesTo ?? []) {
      const constant = rustConstants[tool];
      if (!constant || !toolGateway.includes(constant)) {
        failures.push(`Host .gitignore 策略缺少工具映射 ${tool}。`);
      }
    }
  }

  const terminalPolicy = manifest.hostBridges?.terminalPolicy;
  if (terminalPolicy) {
    if (
      terminalPolicy.implementation === "host-tool-gateway" &&
      (!toolGateway.includes("resolve_request_with_host_policy") ||
        !toolGateway.includes("run_terminal_with_policy") ||
        !toolGateway.includes("PiTerminalPolicy"))
    ) {
      failures.push("Host ToolGateway 没有实现清单声明的终端策略。");
    }
    if (!configExtensions.includes("pi_terminal_policy")) {
      failures.push("Host 配置层没有实现清单声明的终端策略解析。");
    }
    for (const variable of terminalPolicy.environmentVariables ?? []) {
      if (!configExtensions.includes(variable)) {
        failures.push(`终端策略环境变量没有同步：${variable}。`);
      }
    }
    const terminalTimeoutMatch = workerToolGateway.match(
      /PI_TERMINAL_MAX_TIMEOUT_MS\s*=\s*([^;]+)/u,
    );
    const terminalTimeoutValue = terminalTimeoutMatch
      ? Number(terminalTimeoutMatch[1].replaceAll("_", "").trim())
      : undefined;
    if (terminalTimeoutValue !== Number(terminalPolicy.maxTimeoutMs)) {
      failures.push("worker 终端超时上限没有同步兼容清单。");
    }
    if (Number(terminalPolicy.maxOutputBytes) !== 8 * 1024 * 1024) {
      failures.push("终端输出预览上限没有同步兼容清单。");
    }
    for (const path of terminalPolicy.configPaths ?? []) {
      const key = path.split(".").at(-1);
      if (key && !configExtensions.includes(`\"${key}\"`)) {
        failures.push(`终端策略配置项没有同步：${path}。`);
      }
    }
  }

  const questionTimeoutPolicy = manifest.hostBridges?.questionTimeoutPolicy;
  if (questionTimeoutPolicy) {
    if (
      questionTimeoutPolicy.implementation === "worker-gateway" &&
      (!workerToolGateway.includes("interactionTimeoutMsFor") ||
        !workerToolGateway.includes("questionTimeoutPolicy()"))
    ) {
      failures.push("worker ToolGateway 没有实现清单声明的提问等待策略。");
    }
    if (
      questionTimeoutPolicy.manifestField &&
      (!adapter.includes(questionTimeoutPolicy.manifestField) ||
        !adapter.includes(
          "this.questionTimeoutPolicy = normalizedManifest.questionTimeoutPolicy",
        ))
    ) {
      failures.push("worker 提问等待策略清单字段没有同步。");
    }
    if (
      !adapter.includes(
        `const PI_QUESTION_TIMEOUT_POLICY_ENV = "${questionTimeoutPolicy.environmentVariable}"`,
      )
    ) {
      failures.push("worker 提问等待策略环境变量没有同步兼容清单。");
    }
    if (!configExtensions.includes("pi_question_timeout_policy")) {
      failures.push("Host 配置层没有实现清单声明的提问等待策略解析。");
    }
    if (!workerRuntime.includes(questionTimeoutPolicy.environmentVariable)) {
      failures.push("Host worker 启动链路没有传递提问等待策略环境变量。");
    }
    const maxTimeoutMatch = workerToolGateway.match(
      /PI_QUESTION_TIMEOUT_MAX_MS\s*=\s*([^;]+)/u,
    );
    const maxTimeoutValue = maxTimeoutMatch
      ? Number(maxTimeoutMatch[1].replaceAll("_", "").trim())
      : undefined;
    if (maxTimeoutValue !== Number(questionTimeoutPolicy.maxTimeoutMs)) {
      failures.push("worker 提问等待超时上限没有同步兼容清单。");
    }
  }

  const webTools = manifest.hostBridges?.webTools;
  if (webTools) {
    for (const tool of webTools.tools ?? []) {
      if (!workerToolGateway.includes(`"${tool}"`)) {
        failures.push(`Host web 工具桥接缺少工具 ${tool}。`);
      }
    }
    if (
      webTools.implementation === "host-tool-gateway" &&
      (!workerToolGateway.includes("webSearchParameters") ||
        !workerToolGateway.includes("webFetchParameters") ||
        !toolGateway.includes("WEB_SEARCH") ||
        !toolGateway.includes("WEB_FETCH"))
    ) {
      failures.push("Pi web 工具没有实现清单声明的 Host bridge。 ");
    }
    const webRuntimePath = resolve(root, "src-tauri/src/pi_web_runtime.rs");
    let webRuntime = "";
    try {
      webRuntime = readFileSync(webRuntimePath, "utf8");
    } catch (error) {
      failures.push(`src-tauri/src/pi_web_runtime.rs: ${error.message}`);
    }
    for (const marker of [
      "resolve_request",
      "read_bounded_body",
      "public_https_url",
      "format_search_output",
    ]) {
      if (!webRuntime.includes(marker)) {
        failures.push(`Host web bridge 缺少安全边界实现 ${marker}。`);
      }
    }
  }

  const envrcProjection = manifest.hostBridges?.envrcProjection;
  if (envrcProjection) {
    if (!configExtensions.includes("pi_load_envrc")) {
      failures.push("Host 配置层没有实现清单声明的 .envrc 投影开关。");
    }
    for (const marker of [
      "parse_envrc_json",
      "load_envrc",
      "env_clear",
      "direnv",
    ]) {
      if (!workerRuntime.includes(marker)) {
        failures.push(`Host .envrc 投影缺少边界实现 ${marker}。`);
      }
    }
    if (
      envrcProjection.environmentVariable &&
      !configExtensions.includes(envrcProjection.environmentVariable)
    ) {
      failures.push("Host worker 启动链路没有传递 .envrc 投影环境变量。");
    }
  }

  const remoteModelCatalog = manifest.hostBridges?.remoteModelCatalog;
  if (remoteModelCatalog) {
    const modelConfigPath = resolve(root, "src-tauri/src/pi_model_config.rs");
    let modelConfig = "";
    try {
      modelConfig = readFileSync(modelConfigPath, "utf8");
    } catch (error) {
      failures.push(`src-tauri/src/pi_model_config.rs: ${error.message}`);
    }
    for (const marker of [
      "prepare_pi_models_with_remote",
      "fetch_remote_catalog",
      "load_remote_catalog_cache",
      "GENERATED_REMOTE_CATALOG_FILE",
      "models_list_url",
      "models_base_url",
    ]) {
      if (!modelConfig.includes(marker)) {
        failures.push(`Host 远程模型目录桥接缺少实现 ${marker}。`);
      }
    }
    if (!workerRuntime.includes("prepare_pi_models_with_remote")) {
      failures.push("Host worker 启动链路没有接入远程模型目录投影。 ");
    }
    for (const variable of remoteModelCatalog.environmentVariables ?? []) {
      if (
        !modelConfig.includes(variable) &&
        !configExtensions.includes(variable)
      ) {
        failures.push(`远程模型目录环境变量没有同步：${variable}。`);
      }
    }
  }

  const memoryTools = manifest.hostBridges?.memoryTools;
  if (memoryTools) {
    for (const tool of memoryTools.tools ?? []) {
      if (!workerToolGateway.includes(`"${tool}"`)) {
        failures.push(`Host memory 工具桥接缺少工具 ${tool}。`);
      }
    }
    if (
      memoryTools.implementation === "host-memory-gateway" &&
      (!workerToolGateway.includes("memorySearchParameters") ||
        !workerToolGateway.includes("memoryGetParameters") ||
        !workerToolGateway.includes("memoryRememberParameters") ||
        !toolGateway.includes("MEMORY_SEARCH") ||
        !toolGateway.includes("MEMORY_GET") ||
        !toolGateway.includes("MEMORY_REMEMBER"))
    ) {
      failures.push("Pi memory 工具没有实现清单声明的 Host bridge。 ");
    }
    for (const marker of [
      "resolve_request",
      "rank_chunks",
      "initial_injection",
      "save_session_transcript",
      "memory_remember",
      "TextFileStore",
    ]) {
      if (!memoryRuntime.includes(marker)) {
        failures.push(`Host memory bridge 缺少实现 ${marker}。`);
      }
    }
    const persistentIndex = memoryTools.persistentIndex;
    if (persistentIndex?.implementation === "host-sqlite-lexical") {
      for (const marker of [
        "MemoryIndexSummary",
        "MEMORY_INDEX_SCHEMA_VERSION",
        "sync_memory_index_path",
        "memory_index_digest",
        "pi_memory_chunks",
        "rebuild_memory_index",
      ]) {
        if (!memoryRuntime.includes(marker)) {
          failures.push(`Host memory lexical index 缺少实现 ${marker}。`);
        }
      }
      if (!configRuntime.includes("rebuild_melody_memory_index")) {
        failures.push("Host memory lexical index 缺少显式重建命令。");
      }
      if (!memoryRuntime.includes("index.sqlite")) {
        failures.push("Host memory lexical index 没有绑定 index.sqlite 侧车。");
      }
    }
    for (const marker of [
      "maybe_inject_memory",
      "observe_memory_event",
      "flush_memory_transcripts",
    ]) {
      if (!workerRuntime.includes(marker)) {
        failures.push(`Host worker memory 生命周期缺少实现 ${marker}。`);
      }
    }
  }

  const goalSafety = manifest.hostBridges?.goalSafety;
  if (goalSafety) {
    if (
      goalSafety.implementation === "host-manifest-pi-extension" &&
      (!goalExtension.includes("enforceGoalGuards") ||
        !goalExtension.includes("startGoalState") ||
        !configExtensions.includes("pi_goal_policy"))
    ) {
      failures.push("Pi goal safety 没有实现清单声明的 Host/Pi bridge。");
    }
    if (
      goalSafety.manifestField &&
      (!adapter.includes(goalSafety.manifestField) ||
        !adapter.includes("this.goalPolicy = normalizedManifest.goalPolicy"))
    ) {
      failures.push("Pi goal safety 清单字段没有同步到资源刷新链路。");
    }
    if (
      goalSafety.environmentVariable &&
      (!adapter.includes(
        `const PI_GOAL_POLICY_ENV = "${goalSafety.environmentVariable}"`,
      ) ||
        !workerRuntime.includes(goalSafety.environmentVariable))
    ) {
      failures.push("Pi goal safety 环境变量没有同步到 worker 启动链路。");
    }
    const numericConstant = (name) => {
      const match = goalExtension.match(
        new RegExp(`const ${name} = ([^;]+);`, "u"),
      );
      if (!match) return undefined;
      const terms = match[1]
        .split("*")
        .map((term) => Number(term.trim().replaceAll("_", "")));
      return terms.every(Number.isSafeInteger)
        ? terms.reduce((total, term) => total * term, 1)
        : undefined;
    };
    for (const [name, expected, label] of [
      [
        "MAX_GOAL_TOKEN_BUDGET",
        goalSafety.maxTokenBudget,
        "goal token budget 上限",
      ],
      [
        "MAX_GOAL_STALL_TIMEOUT_SECS",
        goalSafety.maxStallTimeoutSecs,
        "goal stall timeout 上限",
      ],
    ]) {
      if (numericConstant(name) !== expected) {
        failures.push(`worker ${label}没有同步兼容清单。`);
      }
    }
    if (
      numericConstant("MAX_GOAL_BLOCKED_ATTEMPTS") !==
      goalSafety.maxBlockedAttempts
    ) {
      failures.push("worker goal blocked-attempt 上限没有同步兼容清单。");
    }
    for (const variable of goalSafety.environmentVariables ?? []) {
      if (!configExtensions.includes(variable)) {
        failures.push(`goal safety 环境变量没有同步：${variable}。`);
      }
    }
  }

  const lspBridge = manifest.hostBridges?.lspBridge;
  if (lspBridge) {
    for (const tool of lspBridge.tools ?? []) {
      if (!workerToolGateway.includes(`"${tool}"`)) {
        failures.push(`Host LSP 工具桥接缺少工具 ${tool}。`);
      }
    }
    if (
      lspBridge.implementation === "host-lsp-stdio" &&
      (!workerToolGateway.includes("lspParameters") ||
        !workerToolGateway.includes("PI_LSP") ||
        !lspRuntime.includes("lsp_tool_kind"))
    ) {
      failures.push("Pi LSP 工具没有实现清单声明的 Host bridge。");
    }
    for (const marker of [
      "list_melody_lsp_servers",
      "read_config_file",
      "validate_server",
      "write_frame",
      "read_frame",
      "LSP_TOOL",
      "MAX_DOCUMENT_BYTES",
      "MAX_OUTPUT_BYTES",
    ]) {
      if (!lspRuntime.includes(marker)) {
        failures.push(`Host LSP bridge 缺少实现 ${marker}。`);
      }
    }
    if (!workerRuntime.includes("pi_lsp_runtime::resolve_request")) {
      failures.push("Host worker 启动链路没有接入 LSP bridge。");
    }
  }

  const codebaseIndex = manifest.hostBridges?.codebaseIndex;
  if (codebaseIndex) {
    const tool = codebaseIndex.tool;
    if (!tool || !workerToolGateway.includes(`"${tool}"`)) {
      failures.push("Host 代码库索引桥接缺少 worker 工具映射。");
    }
    if (
      codebaseIndex.implementation === "host-tree-sitter" &&
      (!workerToolGateway.includes("codebaseNavigationParameters") ||
        !workerToolGateway.includes("PI_CODEBASE_NAVIGATION") ||
        !codebaseRuntime.includes("codebase_tool_kind"))
    ) {
      failures.push("Pi 代码库索引工具没有实现清单声明的 Host bridge。");
    }
    for (const marker of [
      "parse_source",
      "language_for_path",
      "MAX_FILES",
      "MAX_FILE_BYTES",
      "MAX_TOTAL_BYTES",
      "MAX_INDEX_PATTERNS",
      "MAX_INDEX_PATTERN_BYTES",
      "codebase_indexing_policy",
      "glob::Pattern",
      "fn refresh",
    ]) {
      if (!codebaseRuntime.includes(marker)) {
        failures.push(`Host 代码库索引桥缺少实现 ${marker}。`);
      }
    }
    if (!workerRuntime.includes("pi_codebase_runtime::resolve_request")) {
      failures.push("Host worker 启动链路没有接入代码库索引桥。");
    }
    for (const [constant, field, label] of [
      ["MAX_INDEX_PATTERNS", "maxPatterns", "代码库索引 glob 数量上限"],
      [
        "MAX_INDEX_PATTERN_BYTES",
        "maxPatternBytes",
        "代码库索引 glob 长度上限",
      ],
      [
        "MAX_INDEX_WORKSPACES",
        "maxWorkspaceIndexes",
        "代码库索引工作区数量上限",
      ],
    ]) {
      const expected = Number(codebaseIndex[field]);
      if (!Number.isSafeInteger(expected)) continue;
      const match = codebaseRuntime.match(
        new RegExp(`const ${constant}[^=]*=\\s*([^;]+);`, "u"),
      );
      const actual = match
        ? match[1]
            .split("*")
            .map((term) => Number(term.replaceAll("_", "").trim()))
            .reduce((total, term) => total * term, 1)
        : undefined;
      if (actual !== expected) {
        failures.push(`Host ${label}没有同步兼容清单。`);
      }
    }
  }

  const hooks = manifest.hostBridges?.hooks;
  if (hooks) {
    for (const marker of [
      "list_melody_hooks",
      "run_tool_hooks",
      "run_event_hooks",
      "PreToolUse",
      "PostToolUseFailure",
      "env_clear",
      "MAX_HOOK_INPUT_BYTES",
      "MAX_HOOK_OUTPUT_BYTES",
      "MAX_HOOK_TIMEOUT_MS",
    ]) {
      if (!hookRuntime.includes(marker)) {
        failures.push(`Host Hook bridge 缺少实现 ${marker}。`);
      }
    }
    if (!configRuntime.includes("pi_hook_runtime::list_melody_hooks")) {
      failures.push("Host 配置层没有接入 Hook 清单预检。");
    }
    if (!workerRuntime.includes("run_host_tool_hooks")) {
      failures.push("Host worker 没有接入 Hook 执行链路。");
    }
    const hookConstants = {
      maxFiles: "MAX_HOOK_FILES",
      maxHooks: "MAX_HOOKS_TOTAL",
      maxFileBytes: "MAX_HOOK_FILE_BYTES",
      maxCommandBytes: "MAX_HOOK_COMMAND_BYTES",
      maxInputBytes: "MAX_HOOK_INPUT_BYTES",
      maxOutputBytes: "MAX_HOOK_OUTPUT_BYTES",
      maxTimeoutMs: "MAX_HOOK_TIMEOUT_MS",
    };
    for (const [field, constant] of Object.entries(hookConstants)) {
      const expected = Number(hooks[field]);
      if (!Number.isSafeInteger(expected)) continue;
      const match = hookRuntime.match(
        new RegExp(`const ${constant}[^=]*=\\s*([^;]+);`, "u"),
      );
      const actual = match
        ? match[1]
            .split("*")
            .map((term) => Number(term.replaceAll("_", "").trim()))
            .reduce((total, term) => total * term, 1)
        : undefined;
      if (actual !== expected) {
        failures.push(`Hook ${field} 上限没有同步兼容清单。`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Pi compatibility checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Pi compatibility and Tauri command permission checks passed.");
}
