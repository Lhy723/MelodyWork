import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

/**
 * Check the worker/Host resource projection as one contract: prompts, Skills,
 * static plugin resources, activation and ignore rules share a discovery path.
 */
export const checkPiResourceCompatibility = ({
  promptTemplates,
  skillPaths,
  sources = {},
}) => {
  const failures = [];
  const {
    workerResourceRoots = "",
    workerSkillDiscovery = "",
    workerPromptDiscovery = "",
    hostExtensions = "",
    hostPiResources = "",
    hostPromptResources = "",
    hostPluginCatalog = "",
    hostPluginDetails = "",
  } = sources;

  if (promptTemplates) {
    if (
      !workerPromptDiscovery.includes(
        'const PI_PROMPT_PATHS_ENV = "' +
          promptTemplates.environmentVariable +
          '"',
      )
    ) {
      failures.push("worker prompt template 环境变量没有同步兼容清单。");
    }
    if (
      promptTemplates.rootsEnvironmentVariable &&
      !workerResourceRoots.includes(
        'const PI_PROMPT_ROOTS_ENV = "' +
          promptTemplates.rootsEnvironmentVariable +
          '"',
      )
    ) {
      failures.push("worker prompt template 根目录环境变量没有同步兼容清单。");
    }
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
      if (readNumericSourceConstant(workerPromptDiscovery, name) !== expected) {
        failures.push("worker " + label + "没有同步兼容清单。");
      }
    }
    if (
      promptTemplates.flatCommandsOnly &&
      !workerPromptDiscovery.includes("isDirectChild")
    ) {
      failures.push("worker prompt template 没有保持平面 commands 目录边界。");
    }
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
      if (readNumericSourceConstant(hostPromptResources, name) !== expected) {
        failures.push("Host " + label + "没有同步兼容清单。");
      }
    }
  }

  if (skillPaths) {
    if (
      !workerSkillDiscovery.includes(
        'const PI_SKILL_PATHS_ENV = "' + skillPaths.environmentVariable + '"',
      )
    ) {
      failures.push("worker Skill 路径环境变量没有同步兼容清单。");
    }
    if (
      skillPaths.rootsEnvironmentVariable &&
      !workerResourceRoots.includes(
        'const PI_SKILL_ROOTS_ENV = "' +
          skillPaths.rootsEnvironmentVariable +
          '"',
      )
    ) {
      failures.push("worker Skill 根目录环境变量没有同步兼容清单。");
    }
    for (const [name, expected, label] of [
      ["MAX_PI_SKILL_PATHS", skillPaths.maxPaths, "Skill 路径数量上限"],
      ["MAX_PI_SKILL_DEPTH", skillPaths.maxDepth, "Skill 路径深度上限"],
      ["MAX_PI_SKILL_FILE_BYTES", skillPaths.maxFileBytes, "Skill 单文件上限"],
      ["MAX_PI_SKILL_TOTAL_BYTES", skillPaths.maxTotalBytes, "Skill 总量上限"],
    ]) {
      if (
        readNumericSourceConstant(
          name === "MAX_PI_SKILL_PATHS"
            ? workerResourceRoots
            : workerSkillDiscovery,
          name,
        ) !== expected
      ) {
        failures.push("worker " + label + "没有同步兼容清单。");
      }
    }
    if (
      skillPaths.externalMarkdownOnly &&
      (!workerResourceRoots.includes("isWithinRoot") ||
        !workerSkillDiscovery.includes("realpathSync"))
    ) {
      failures.push("worker Skill 没有保持外部 Markdown 根目录边界。");
    }
    if (skillPaths.pluginStaticResources) {
      if (
        !workerResourceRoots.includes("discoverPluginRoots") ||
        !workerResourceRoots.includes("isPluginRoot") ||
        !hostExtensions.includes("pi_plugin_resources")
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
        if (readNumericSourceConstant(hostPluginCatalog, name) !== expected) {
          failures.push("Host " + label + "没有同步兼容清单。");
        }
      }
      const activation = skillPaths.pluginActivation;
      if (
        activation?.explicitEnablement &&
        !(
          hostPluginCatalog.includes("if listed(&self.disabled)") &&
          hostPluginCatalog.includes("listed(&self.enabled)")
        )
      ) {
        failures.push(
          "Host 插件启用判定没有保持 Melody 的“显式启用且未禁用”语义。",
        );
      }
      if (activation?.configuredPaths) {
        if (
          !hostPluginCatalog.includes(
            'merged_config_array(cwd, "plugins", "paths")',
          )
        ) {
          failures.push("Host 没有扫描 [plugins].paths。");
        }
        if (
          readNumericSourceConstant(
            hostPluginCatalog,
            "MAX_PI_PLUGIN_PATH_ENTRIES",
          ) !== activation.configuredPaths.maxEntries
        ) {
          failures.push("[plugins].paths 数量上限没有同步兼容清单。");
        }
        if (!hostPluginCatalog.includes('scope == "config"')) {
          failures.push("Host 没有按配置来源自动启用 [plugins].paths 插件。");
        }
      }
      if (
        Array.isArray(activation?.nameConflictPrecedence) &&
        !hostPluginCatalog.includes("fn scope_rank")
      ) {
        failures.push("Host 没有按 name 优先级解决插件重名。");
      }
      // A plugin is only Markdown-only once its declarative surfaces no longer
      // count as dynamic; the skill/command/agent roots have to stay wired.
      if (
        skillPaths.pluginStaticResources &&
        (!hostPiResources.includes("agent_roots") ||
          !hostPluginDetails.includes('"agents"'))
      ) {
        failures.push("Host 插件声明式 agent 根目录没有接入投影。");
      }
      const skillIgnore = skillPaths.skillIgnore;
      if (skillIgnore) {
        if (
          !hostPiResources.includes("fn pi_skill_ignore_paths") ||
          !hostPiResources.includes("ignorePaths") ||
          !workerResourceRoots.includes("ignorePaths")
        ) {
          failures.push("[skills].ignore 没有在 Host 与 worker 之间同步。");
        }
        if (
          readNumericSourceConstant(
            hostPiResources,
            "MAX_PI_SKILL_IGNORE_PATHS",
          ) !== skillIgnore.maxPaths
        ) {
          failures.push("Host [skills].ignore 数量上限没有同步兼容清单。");
        }
        if (
          readNumericSourceConstant(
            workerResourceRoots,
            "MAX_PI_SKILL_IGNORE_PATHS",
          ) !== skillIgnore.maxPaths
        ) {
          failures.push("worker [skills].ignore 数量上限没有同步兼容清单。");
        }
        if (
          readNumericSourceConstant(
            hostExtensions,
            "MAX_PI_SKILL_IGNORE_BYTES",
          ) !== skillIgnore.maxBytesPerPath
        ) {
          failures.push("Host [skills].ignore 单条长度上限没有同步兼容清单。");
        }
        if (!workerResourceRoots.includes("isIgnoredPath")) {
          failures.push("worker 没有按前缀过滤被忽略的 Skill。");
        }
      }
    }
  }

  return failures;
};
