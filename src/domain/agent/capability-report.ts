import { inspectPiConfigCapabilityPolicies } from "./config-capability-policy.ts";
import type { AgentCapabilityDiagnostic } from "./contract";

/** A config snapshot read through Melody's trusted config bridge. */
export interface AgentConfigSnapshot {
  scope: "user" | "project";
  values: unknown;
  path?: string;
  /** A parse failure means the values snapshot is incomplete and unsafe. */
  parseError?: string;
}

/** Non-secret process settings that can change Melody's trust boundary. */
export interface AgentRuntimeEnvironmentSnapshot {
  /** Value of MELODY_SANDBOX when supplied by the trusted Host. */
  sandboxProfile?: string;
}

export interface AgentExtensionSnapshot {
  kind: string;
  name: string;
  /** Plugin name when a Skill/extension is sourced from an installed plugin. */
  pluginName?: string;
  scope?: string;
  provider?: string;
  path?: string;
  enabled: boolean;
}

/** Metadata for a discovered Melody/Claude agent definition. */
export interface AgentDefinitionSnapshot {
  name: string;
  path?: string;
  scope?: string;
  enabled: boolean;
  supported: boolean;
  unsupportedFields?: string[];
}

/** Effective LSP server inventory returned by the Host preflight bridge. */
export interface LspServerSnapshot {
  name: string;
  scope?: string;
  path?: string;
  enabled: boolean;
  supported: boolean;
  unsupportedFields?: string[];
}

/** MCP support status validated by the Host's runtime parser. */
export interface McpServerSnapshot {
  name: string;
  transport: string;
  supported: boolean;
  reason?: string;
}

/** Host-validated command-hook inventory used by Pi preflight. */
export interface HookDefinitionSnapshot {
  name: string;
  path?: string;
  scope?: string;
  enabled: boolean;
  supported: boolean;
  unsupportedFields?: string[];
}

/**
 * Host inventory for an installed plugin.  Markdown Skills and command
 * templates are safe to project into Pi when a plugin has no executable
 * surfaces; hooks, agents, MCP/LSP declarations and script-backed resources
 * remain an explicit compatibility boundary.
 */
export interface PluginCapabilitySnapshot {
  name: string;
  path?: string;
  scope?: string;
  enabled: boolean;
  staticResources: boolean;
  dynamicComponents?: string[];
}

export interface PiCapabilityReport {
  engine: "pi";
  /**
   * True only when it would be unsafe to open the session on Pi (unreadable
   * config, unenforceable sandbox). Peripheral capability gaps do not switch
   * engines; they are listed in `degradations`.
   */
  blocksPiSession: boolean;
  diagnostics: AgentCapabilityDiagnostic[];
  /** Capability gaps that degrade the session instead of routing it away. */
  degradations: AgentCapabilityDiagnostic[];
}

const unsupportedLspServers = (
  servers: LspServerSnapshot[],
): LspServerSnapshot[] =>
  servers.filter((server) => server.enabled && !server.supported);

const enabledExtensions = (
  extensions: AgentExtensionSnapshot[],
  kind: string,
): AgentExtensionSnapshot[] =>
  extensions.filter(
    (extension) => extension.kind === kind && extension.enabled,
  );

/**
 * Pi receives concrete, bounded Markdown Skill directories from the Host. The
 * standard `.agents/.claude/.cursor/skills` roots are therefore supported just
 * like Melody's managed root. Plugin-provided Skills remain blocking because
 * their surrounding plugin may require executable extensions, hooks or MCP.
 */
const piUnsupportedSkills = (
  skills: AgentExtensionSnapshot[],
  plugins: PluginCapabilitySnapshot[] | undefined,
): AgentExtensionSnapshot[] =>
  enabledExtensions(skills, "skills").filter((skill) => {
    if (skill.provider === "plugin") {
      const pluginName = skill.name.split(":", 1)[0];
      const plugin = plugins?.find(
        (candidate) =>
          candidate.enabled &&
          (candidate.name === skill.pluginName ||
            candidate.name === pluginName ||
            (candidate.path &&
              skill.path &&
              skill.path.startsWith(candidate.path))),
      );
      // A missing inventory is intentionally conservative for direct worker
      // callers that do not have the Host preflight bridge yet.
      return (
        !plugin ||
        !plugin.staticResources ||
        (plugin.dynamicComponents?.length ?? 0) > 0
      );
    }
    if (
      skill.provider &&
      ["melody", "agents", "claude", "cursor"].includes(skill.provider)
    ) {
      return false;
    }
    if (!skill.provider && !skill.path) return false;
    const normalizedPath = skill.path?.replaceAll("\\", "/") ?? "";
    if (
      /(?:^|\/)\.(?:agents|claude|cursor)\/skills(?:\/|$)/u.test(normalizedPath)
    ) {
      return false;
    }
    return true;
  });

const blockingDiagnostic = (
  code: string,
  capability: string,
  message: string,
  source?: string,
): AgentCapabilityDiagnostic => ({
  code,
  capability,
  severity: "blocking",
  message,
  ...(source ? { source } : {}),
});

/**
 * A peripheral capability that cannot run on Pi. The session stays on Pi; the
 * feature is simply unavailable until its config changes.
 */
const degradation = (
  code: string,
  capability: string,
  message: string,
  source?: string,
): AgentCapabilityDiagnostic => ({
  code,
  capability,
  severity: "warning",
  message,
  ...(source ? { source } : {}),
});

/**
 * Decide how a workspace's configured capabilities map onto Pi.
 *
 * Two tiers: a peripheral capability that Pi cannot host degrades in place —
 * the session stays on Pi and the gap is reported as a warning — while only
 * only session-level risks block opening Pi: a config that cannot be parsed
 * (we cannot know what the session would do) and an OS sandbox the Host cannot
 * enforce (a security boundary is never silently weakened).
 */
export const inspectPiCapabilityReport = (input: {
  configs: AgentConfigSnapshot[];
  extensions: AgentExtensionSnapshot[];
  /** MCP transport/schema status validated by the Host runtime parser. */
  mcpServers: McpServerSnapshot[];
  /** Full runtime skill inventory, including external compatibility roots. */
  skills?: AgentExtensionSnapshot[];
  /** Trusted, non-secret environment settings read by the Host. */
  environment?: AgentRuntimeEnvironmentSnapshot;
  /**
   * Host answer for the configured OS sandbox. When present it is
   * authoritative: the Host knows whether the sandbox can actually confine a
   * command here. `reasonCode: "platform-unsupported"` means this OS has no
   * enforcement implementation at all and the session degrades to unsandboxed
   * with a prominent warning; other unenforceable reasons refuse to open.
   */
  sandboxPlan?: {
    profile?: string;
    enforceable: boolean;
    reason?: string;
    reasonCode?: string;
  };
  /** Host inventory of project/user agent definitions. */
  agentDefinitions?: AgentDefinitionSnapshot[];
  /** Host inventory of effective read-only LSP servers. */
  lspServers?: LspServerSnapshot[];
  /** Host inventory of trusted declarative command hooks. */
  hooks?: HookDefinitionSnapshot[];
  /** Host inventory of installed plugin static/dynamic surfaces. */
  plugins?: PluginCapabilitySnapshot[];
}): PiCapabilityReport => {
  const diagnostics: AgentCapabilityDiagnostic[] = [];

  for (const snapshot of input.configs) {
    if (!snapshot.parseError?.trim()) continue;
    diagnostics.push(
      blockingDiagnostic(
        "pi.config_unreadable",
        "configuration",
        `${snapshot.scope === "project" ? "项目" : "用户"}配置无法完整解析；为避免遗漏已配置能力，已阻止打开 Pi 会话。`,
        snapshot.path,
      ),
    );
  }

  const unsupportedMcp = input.mcpServers.filter((server) => !server.supported);
  if (unsupportedMcp.length > 0) {
    diagnostics.push(
      degradation(
        "pi.mcp_unavailable",
        "mcp",
        `当前工作区有 ${unsupportedMcp.length} 个 MCP 配置无法由 Pi 的宿主桥接执行（仅支持校验通过的本地 stdio 与 HTTP/SSE）；这些服务在本次 Pi 会话中不可用，其余能力不受影响。`,
        unsupportedMcp.map((server) => server.name).join(", "),
      ),
    );
  }

  const configPolicies = inspectPiConfigCapabilityPolicies(
    input.configs,
    input.environment,
  );
  if (input.sandboxPlan) {
    // The Host told us what it can enforce. A profile it can enforce on this
    // platform keeps the session on Pi. A platform with no enforcement
    // implementation at all (`platform-unsupported`) degrades to unsandboxed
    // with a prominent warning — matching the product bar of a single engine
    // without sandbox parity. Anything else (the profile asks for isolation
    // the Host cannot express, or the platform runtime is broken) refuses to
    // open: isolation is never silently weakened.
    if (input.sandboxPlan.profile && !input.sandboxPlan.enforceable) {
      const platformUnsupported =
        input.sandboxPlan.reasonCode === "platform-unsupported";
      diagnostics.push(
        platformUnsupported
          ? degradation(
              "pi.sandbox_unavailable",
              "sandbox",
              `当前平台没有 OS 沙箱实现（${input.sandboxPlan.reason ?? "未说明原因"}）；本次 Pi 会话将以无沙箱方式执行终端命令，请确认工作区内容可信。`,
              "workspace.sandboxPlan",
            )
          : blockingDiagnostic(
              "pi.sandbox_unavailable",
              "sandbox",
              `当前工作区启用了 OS 级沙箱配置，但 Host 无法执行等价隔离（${input.sandboxPlan.reason ?? "未说明原因"}）；无法以 Pi 打开该会话。`,
              "workspace.sandboxPlan",
            ),
      );
    }
  } else if (configPolicies.sandbox.configured) {
    diagnostics.push(
      blockingDiagnostic(
        "pi.sandbox_unavailable",
        "sandbox",
        "当前工作区启用了 Melody 的 OS 级沙箱配置；Pi 只提供宿主路径校验，无法等价执行内核隔离，因此已阻止打开 Pi 会话。",
        configPolicies.sandbox.configuredByEnvironment
          ? "env.MELODY_SANDBOX"
          : "config.sandbox",
      ),
    );
  }

  if (configPolicies.codebaseIndexPolicyInvalid) {
    diagnostics.push(
      degradation(
        "pi.codebase_indexing_unavailable",
        "codebase-indexing",
        "当前工作区的代码库索引策略格式无法由 Host 安全解析；Pi 的 tree-sitter 导航拒绝静默忽略该策略，代码库导航在本次会话中不可用，其余能力不受影响。",
        "config.features.codebase_indexing",
      ),
    );
  }

  if (configPolicies.externalAuthCommandConfigured) {
    diagnostics.push(
      degradation(
        "pi.external_auth_unavailable",
        "external-auth-provider",
        "当前工作区配置了外部认证提供程序命令；Pi worker 只支持 Host 管理的 API key，该登录方式在本次会话中不可用，其余能力不受影响。",
        "config.auth.auth_provider_command",
      ),
    );
  }

  if (configPolicies.oidcConfigured) {
    diagnostics.push(
      degradation(
        "pi.oidc_unavailable",
        "oidc-authentication",
        "当前工作区配置了 OIDC 登录；Pi 迁移版暂不提供浏览器/PKCE 登录流程，该登录方式在本次会话中不可用，其余能力不受影响。",
        "config.grok_com_config.oidc",
      ),
    );
  }

  const unsupportedDefinitions = (input.agentDefinitions ?? []).filter(
    (entry) => entry.enabled && !entry.supported,
  );
  const configHasUnsupportedDefinitions =
    configPolicies.subagentDefinitionPolicyUnsupported;
  if (configHasUnsupportedDefinitions || unsupportedDefinitions.length > 0) {
    diagnostics.push(
      degradation(
        "pi.subagent_definition_unavailable",
        "subagent-definition",
        "当前工作区存在需要动态工具、Hook、MCP 或完成门禁的 Melody 子代理定义；Pi 仅接管声明式提示、模型、权限和隔离，这些定义在本次会话中不可选，其余能力不受影响。",
        [
          configHasUnsupportedDefinitions ? "config.subagents" : "",
          ...unsupportedDefinitions.map((entry) => entry.path ?? entry.name),
        ]
          .filter(Boolean)
          .join(", "),
      ),
    );
  }

  if (configPolicies.terminalPolicyInvalid) {
    diagnostics.push(
      degradation(
        "pi.terminal_policy_unavailable",
        "terminal-policy",
        "当前工作区的终端超时或输出上限配置无法安全解析；Pi 迁移版拒绝静默忽略该策略，相关配置在本次会话中不生效（使用 Host 默认上限），其余能力不受影响。",
        "config.toolset.bash",
      ),
    );
  }

  if (configPolicies.questionTimeoutPolicyInvalid) {
    diagnostics.push(
      degradation(
        "pi.question_timeout_policy_unavailable",
        "question-timeout-policy",
        "当前工作区的提问等待策略无法安全解析；相关配置在本次会话中不生效（提问将按会话默认行为等待），其余能力不受影响。",
        "config.toolset.ask_user_question",
      ),
    );
  }

  const configuredLsp =
    input.lspServers === undefined && configPolicies.lspConfigPresent;
  const unsupportedLsp = unsupportedLspServers(input.lspServers ?? []);
  if (configuredLsp || unsupportedLsp.length > 0) {
    diagnostics.push(
      degradation(
        "pi.lsp_unavailable",
        "lsp",
        configuredLsp
          ? "当前工作区配置了 LSP 服务，但未提供可安全验证的 Host 清单；LSP 工具在本次会话中不可用，其余能力不受影响。"
          : `当前工作区有 ${unsupportedLsp.length} 个 LSP 配置无法由 Pi 的 Host stdio 桥接安全执行（项目配置需 trusted=true，且仅支持 stdio/local）；这些服务在本次会话中不可用，其余能力不受影响。`,
        configuredLsp
          ? "config.lsp_servers"
          : unsupportedLsp
              .map((server) => server.path ?? server.name)
              .join(", "),
      ),
    );
  }

  if (configPolicies.semanticMemoryNeedsDegradation) {
    diagnostics.push(
      degradation(
        "pi.memory_semantic_index_unavailable",
        "memory",
        "当前工作区启用了记忆语义索引或 dream consolidation（embedding/vector/dream）；语义索引在本次会话中不可用，基础 Markdown 检索、写入、首轮注入、会话保存与两阶段 memory flush（含 /flush）仍由 Pi/Host 提供。",
        "config.memory",
      ),
    );
  }

  if (configPolicies.advancedGoalOrchestrationConfigured) {
    diagnostics.push(
      degradation(
        "pi.goal_orchestration_unavailable",
        "goal-orchestration",
        "当前工作区启用了 goal 分类器、规划/验证器、重试或角色模型策略；Pi 已接管基础 update_goal 状态、token budget 与停滞护栏，复杂编排能力在本次会话中不可用。",
        "config.goal",
      ),
    );
  }

  const skills = input.skills ?? input.extensions;
  const unsupportedSkills = piUnsupportedSkills(skills, input.plugins);
  if (unsupportedSkills.length > 0) {
    diagnostics.push(
      degradation(
        "pi.skills_unavailable",
        "skills",
        `当前工作区启用了 ${unsupportedSkills.length} 个 Pi 尚未安全接管的 Skill（插件提供或来源无法识别）；这些 Skill 在本次会话中不注入，标准外部 Markdown Skill 仍正常工作。`,
        unsupportedSkills.map((skill) => skill.path ?? skill.name).join(", "),
      ),
    );
  }

  // Keep the old conservative behavior for callers that do not yet have the
  // Host parser. In the desktop runtime `hooks` is always supplied, so valid
  // JSON command hooks stay on Pi and only unsafe definitions fall back.
  const hooks =
    input.hooks === undefined
      ? enabledExtensions(input.extensions, "hooks").map((hook) => ({
          name: hook.name,
          path: hook.path,
          enabled: hook.enabled,
          supported: false,
          unsupportedFields: ["hostInventory"],
        }))
      : input.hooks.filter((hook) => hook.enabled && !hook.supported);
  if (hooks.length > 0) {
    diagnostics.push(
      degradation(
        "pi.hooks_unavailable",
        "hooks",
        `当前工作区有 ${hooks.length} 个 Hook 无法由 Pi 的 Host 命令桥接安全执行（仅支持受信任 JSON command hooks）；这些 Hook 在本次会话中不生效，其余能力不受影响。`,
        hooks.map((hook) => hook.path ?? hook.name).join(", "),
      ),
    );
  }

  const pluginExtensions = enabledExtensions(input.extensions, "plugins");
  const plugins =
    input.plugins === undefined
      ? pluginExtensions.map((extension) => ({
          name: extension.name,
          path: extension.path,
          scope: extension.scope,
          enabled: extension.enabled,
          staticResources: false,
          dynamicComponents: ["hostInventory"],
        }))
      : input.plugins.filter((plugin) => plugin.enabled);
  const unsupportedPlugins = plugins.filter(
    (plugin) =>
      !plugin.staticResources || (plugin.dynamicComponents?.length ?? 0) > 0,
  );
  if (unsupportedPlugins.length > 0) {
    diagnostics.push(
      degradation(
        "pi.plugins_unavailable",
        "plugins",
        `当前工作区有 ${unsupportedPlugins.length} 个插件包含动态扩展；纯 Markdown Skill/命令资源仍由 Host 受控投影，动态组件在本次会话中不加载，其余能力不受影响。`,
        unsupportedPlugins.map((plugin) => plugin.name).join(", "),
      ),
    );
  }

  return {
    engine: "pi",
    blocksPiSession: diagnostics.some((item) => item.severity === "blocking"),
    diagnostics,
    degradations: diagnostics.filter((item) => item.severity === "warning"),
  };
};
