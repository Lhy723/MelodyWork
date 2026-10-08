import { containsControlCharacters } from "./contract.ts";
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

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const objectHasEntries = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  const record = recordValue(value);
  return Boolean(record && Object.keys(record).length > 0);
};

const valueAtKey = (value: unknown, key: string): unknown => {
  const record = recordValue(value);
  return record?.[key];
};

const valueAtPath = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((current, key) => valueAtKey(current, key), value);

const hasConfiguredSection = (
  snapshots: AgentConfigSnapshot[],
  keys: string[],
  predicate: (value: unknown) => boolean = objectHasEntries,
): boolean =>
  snapshots.some((snapshot) =>
    keys.some((key) => predicate(valueAtKey(snapshot.values, key))),
  );

const hasConfiguredPath = (
  snapshots: AgentConfigSnapshot[],
  paths: string[][],
  predicate: (value: unknown) => boolean = objectHasEntries,
): boolean =>
  snapshots.some((snapshot) =>
    paths.some((path) => predicate(valueAtPath(snapshot.values, path))),
  );

const MCP_CONFIG_KEYS = ["mcp_servers", "mcpServers", "mcp", "mcps"];

const hasMcpDescriptorFields = (value: Record<string, unknown>): boolean =>
  [
    "name",
    "command",
    "args",
    "env",
    "cwd",
    "transport",
    "type",
    "url",
    "uri",
    "server_url",
    "serverUrl",
  ].some((key) => key in value);

interface McpConfigEntry {
  name: string;
  value: unknown;
}

const collectMcpEntries = (
  value: unknown,
  nameHint?: string,
): McpConfigEntry[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectMcpEntries(item, nameHint));
  }
  const record = recordValue(value);
  if (!record) return [];
  if (hasMcpDescriptorFields(record)) {
    const name =
      (typeof record.name === "string" && record.name.trim()) ||
      nameHint?.trim() ||
      "unnamed";
    return [{ name, value: record }];
  }
  const nested = Object.entries(record).flatMap(([key, item]) =>
    item && typeof item === "object" ? collectMcpEntries(item, key) : [],
  );
  return nested.length > 0
    ? nested
    : nameHint
      ? [{ name: nameHint, value }]
      : [];
};

const mcpEntrySupported = (value: unknown): boolean => {
  const record = recordValue(value);
  if (!record) return false;
  const command = record.command;
  const remoteKeys = ["url", "uri", "server_url", "serverUrl"];
  const hasRemoteField = remoteKeys.some(
    (key) => record[key] !== undefined && record[key] !== null,
  );
  const remote = remoteKeys
    .map((key) => record[key])
    .find((candidate) => typeof candidate === "string" && candidate.trim());
  const transport = record.transport ?? record.type;
  if (hasRemoteField) {
    // The Host owns the remote client.  Keep this check in lockstep with the
    // Rust parser so a malformed mixed entry never silently disappears when
    // Pi is selected.
    if (command !== undefined && command !== null) return false;
    if (typeof remote !== "string" || remote.length > 4096) return false;
    try {
      const parsed = new URL(remote.trim());
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        return false;
      }
    } catch {
      return false;
    }
    const remoteTransport =
      typeof transport === "string" ? transport.trim().toLowerCase() : "http";
    if (
      transport !== undefined &&
      transport !== null &&
      typeof transport !== "string"
    ) {
      return false;
    }
    if (
      transport !== undefined &&
      ![
        "http",
        "streamable-http",
        "streamable_http",
        "streamablehttp",
        "sse",
        "server-sent-events",
        "server_sent_events",
      ].includes(remoteTransport)
    ) {
      return false;
    }
    if (record.headers !== undefined) {
      const headers = recordValue(record.headers);
      if (!headers || Object.keys(headers).length > 64) return false;
      for (const [name, headerValue] of Object.entries(headers)) {
        if (
          !name ||
          name.length > 256 ||
          typeof headerValue !== "string" ||
          headerValue.length > 16 * 1024 ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
          [
            "accept",
            "content-type",
            "content-length",
            "connection",
            "host",
            "mcp-session-id",
            "transfer-encoding",
          ].includes(name.toLowerCase())
        ) {
          return false;
        }
      }
    }
    return true;
  }
  if (typeof command !== "string" || command.trim().length === 0) return false;
  if (
    transport !== undefined &&
    (typeof transport !== "string" ||
      !["stdio", "local"].includes(transport.trim().toLowerCase()))
  ) {
    return false;
  }
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) ||
      record.args.some((item) => typeof item !== "string"))
  ) {
    return false;
  }
  if (
    record.env !== undefined &&
    (!recordValue(record.env) ||
      Object.values(record.env as Record<string, unknown>).some(
        (item) => typeof item !== "string",
      ))
  ) {
    return false;
  }
  return true;
};

const unsupportedMcpEntries = (
  snapshots: AgentConfigSnapshot[],
): McpConfigEntry[] => {
  const entries: McpConfigEntry[] = [];
  for (const snapshot of snapshots) {
    for (const key of MCP_CONFIG_KEYS) {
      const value = valueAtKey(snapshot.values, key);
      if (value === undefined || value === null) continue;
      const collected = collectMcpEntries(value, key);
      if (collected.length === 0) {
        entries.push({ name: key, value });
      } else {
        entries.push(
          ...collected.filter((entry) => !mcpEntrySupported(entry.value)),
        );
      }
    }
  }
  return entries;
};

const memoryIsEnabled = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  const record = recordValue(value);
  if (!record) return false;
  // `enabled = false` is an explicit opt-out in Melody-build. Nested
  // lifecycle settings must not accidentally re-enable the entire feature.
  if (record.enabled === false) return false;
  // A non-empty memory table without an explicit `enabled = false` uses
  // Melody's enabled-by-configuration default and must not be silently lost.
  return Object.keys(record).length > 0;
};

/**
 * Pi's Host bridge now owns the common Markdown memory lifecycle: bounded
 * search/get/remember, first-turn injection, and deterministic session snapshots. The
 * Pi compaction extension also owns the bounded first-pass memory-flush note and
 * the user-facing `/flush` command;
 * only the semantic/vector index and dream consolidation paths are unavailable
 * in Pi. Keep this predicate narrow so ordinary memory stays fully available.
 */
const memoryNeedsPiDegradation = (value: unknown): boolean => {
  if (!memoryIsEnabled(value)) return false;
  const memory = recordValue(value);
  const embedding = recordValue(memory?.embedding);
  if (
    embedding &&
    (configuredString(embedding.model) || embedding.dimensions !== undefined)
  ) {
    return true;
  }
  return objectHasEntries(memory?.dream);
};

/**
 * Pi can persist and expose the basic goal lifecycle, but it does not yet
 * reproduce Melody-build's autonomous goal driver.  Keep this predicate
 * deliberately explicit: a harmless `[goal].enabled = true` should stay on
 * Pi, and its deterministic token/stall safety rails are projected through
 * the resource manifest. Classifier/planner/verifier, retry, and model pins
 * are unavailable in Pi and are reported as a session degradation.
 */
const hasUnsupportedGoalOrchestration = (value: unknown): boolean => {
  const goal = recordValue(value);
  if (!goal) return false;
  const advancedKeys = [
    "classifier_enabled",
    "classifierEnabled",
    "planner_enabled",
    "plannerEnabled",
    "verification_enabled",
    "verificationEnabled",
    "verifier_enabled",
    "verifierEnabled",
    "classifier_max_runs",
    "classifierMaxRuns",
    "max_classifier_runs",
    "maxClassifierRuns",
    "retry_limit",
    "retryLimit",
    "max_retries",
    "maxRetries",
    "budget",
    "planner_model",
    "plannerModel",
    "strategist_model",
    "strategistModel",
    "skeptic_model",
    "skepticModel",
    "skeptic_models",
    "skepticModels",
    "completion_gate",
    "completionGate",
    "adversarial_verification",
    "adversarialVerification",
  ];
  return advancedKeys.some((key) => {
    const candidate = goal[key];
    if (candidate === undefined || candidate === null) return false;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) && candidate > 0;
    }
    if (typeof candidate === "string") return candidate.trim().length > 0;
    return objectHasEntries(candidate);
  });
};

const hasAdvancedGoalOrchestration = (
  snapshots: AgentConfigSnapshot[],
): boolean =>
  snapshots.some((snapshot) => {
    const root = recordValue(snapshot.values);
    if (!root) return false;
    if (hasUnsupportedGoalOrchestration(root.goal)) return true;
    if (hasUnsupportedGoalOrchestration(root.goal_orchestration)) return true;
    return [
      "goal_classifier_enabled",
      "goal_planner_enabled",
      "goal_verification_enabled",
      "goal_retry_limit",
    ].some((key) => {
      const candidate = root[key];
      if (candidate === undefined || candidate === null) return false;
      if (typeof candidate === "boolean") return candidate;
      if (typeof candidate === "number") {
        return Number.isFinite(candidate) && candidate > 0;
      }
      if (typeof candidate === "string") return candidate.trim().length > 0;
      return objectHasEntries(candidate);
    });
  });

const unsupportedLspServers = (
  servers: LspServerSnapshot[],
): LspServerSnapshot[] =>
  servers.filter((server) => server.enabled && !server.supported);

const MAX_CODEBASE_INDEX_PATTERNS = 64;
const MAX_CODEBASE_INDEX_PATTERN_BYTES = 512;

/**
 * The default switch and Melody's path-glob form are covered by the bounded
 * Host tree-sitter bridge. Malformed values make codebase navigation
 * unavailable: the Host intentionally fails closed rather than indexing a
 * workspace under an ambiguous policy.
 */
const codebaseIndexingPolicyInvalid = (value: unknown): boolean => {
  if (
    value === undefined ||
    value === null ||
    value === false ||
    value === true
  ) {
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CODEBASE_INDEX_PATTERNS) return true;
    return value.some((entry) => {
      if (typeof entry !== "string") return true;
      const pattern = entry.trim();
      if (
        pattern.length === 0 ||
        pattern.length > MAX_CODEBASE_INDEX_PATTERN_BYTES ||
        containsControlCharacters(pattern)
      ) {
        return true;
      }
      const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
      if (!body) return true;
      let characterClassDepth = 0;
      for (const character of body) {
        if (character === "[") characterClassDepth += 1;
        if (character === "]") characterClassDepth -= 1;
        if (characterClassDepth < 0) return true;
      }
      return characterClassDepth !== 0;
    });
  }
  const record = recordValue(value);
  return record ? Object.keys(record).length > 0 : true;
};

const configuredString = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

/** A terminal policy value is safe to project only when it is a positive,
 * finite number. Invalid values must not be silently ignored by the Host
 * parser. */
const invalidTerminalPolicyValue = (value: unknown): boolean =>
  value !== undefined &&
  (typeof value !== "number" || !Number.isFinite(value) || value <= 0);

const invalidQuestionTimeoutEnabledValue = (value: unknown): boolean =>
  value !== undefined && typeof value !== "boolean";

const invalidQuestionTimeoutSecondsValue = (value: unknown): boolean =>
  value !== undefined &&
  (typeof value !== "number" || !Number.isFinite(value) || value <= 0);

/**
 * Basic subagent toggles, model pins, roles and personas are projected by the
 * Pi Host. Only full session/agent definitions with dynamic surfaces are
 * unavailable: they can change the tool graph and system prompt in ways the
 * bounded Pi manifest deliberately does not expose.
 */
const SAFE_AGENT_DEFINITION_KEYS = new Set([
  "name",
  "description",
  "model",
  "modelId",
  "model_id",
  "effort",
  "reasoningEffort",
  "reasoning_effort",
  "capabilityMode",
  "capability_mode",
  "defaultCapabilityMode",
  "default_capability_mode",
  "isolation",
  "defaultIsolation",
  "default_isolation",
  "permissionMode",
  "permission_mode",
  "instructions",
  "prompt",
  "prompt_file",
  "promptFile",
  // The Host resolves a tool allowlist into the narrowest Pi capability
  // ceiling; a list it cannot bound makes the definition unavailable and is
  // reported through the Host inventory, not through this key allowlist.
  "tools",
  "disallowedTools",
  "disallowed_tools",
]);

const agentDefinitionEntryUnsupported = (value: unknown): boolean => {
  const record = recordValue(value);
  if (!record) return true;
  return Object.keys(record).some(
    (key) => !SAFE_AGENT_DEFINITION_KEYS.has(key),
  );
};

/** Detect dynamic agent definitions in either array or name-keyed config form. */
const unsupportedAgentDefinitions = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(agentDefinitionEntryUnsupported);
  }
  const record = recordValue(value);
  if (!record || Object.keys(record).length === 0) return false;
  // A single inline definition may itself be supplied as an object.
  if (Object.keys(record).some((key) => SAFE_AGENT_DEFINITION_KEYS.has(key))) {
    return agentDefinitionEntryUnsupported(record);
  }
  // The common TOML shape is [subagents.agents.<name>]. Treat each value as
  // an independent definition and fail closed for scalar/nested dynamic data.
  return Object.values(record).some(agentDefinitionEntryUnsupported);
};

const unsupportedSubagentPolicy = (value: unknown): boolean => {
  const record = recordValue(value);
  if (!record) return false;
  return ["agents", "agent_definitions", "agentDefinitions"].some((key) =>
    unsupportedAgentDefinitions(record[key]),
  );
};

/**
 * Melody-build's sandbox is an OS-level execution boundary.  Pi's Host
 * gateway validates workspace paths, but it does not reproduce Melody's
 * kernel-enforced profiles or custom deny lists.  Treat every active profile
 * as a compatibility requirement so a sandboxed Melody session never becomes
 * an unconfined Pi session.  Explicit `off`/false values are opt-outs.
 */
const configuredSandbox = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized.length > 0 && !["off", "false", "none"].includes(normalized)
    );
  }
  if (value === true) return true;
  const record = recordValue(value);
  if (!record) return false;
  if ("profile" in record) {
    return configuredSandbox(record.profile);
  }
  if (record.enabled === false) return false;
  return Object.entries(record).some(
    ([key, nested]) => key !== "enabled" && configuredSandbox(nested),
  );
};

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

  const unsupportedMcp = unsupportedMcpEntries(input.configs);
  if (unsupportedMcp.length > 0) {
    diagnostics.push(
      degradation(
        "pi.mcp_unavailable",
        "mcp",
        `当前工作区有 ${unsupportedMcp.length} 个 MCP 配置无法由 Pi 的宿主桥接执行（仅支持校验通过的本地 stdio 与 HTTP/SSE）；这些服务在本次 Pi 会话中不可用，其余能力不受影响。`,
        unsupportedMcp.map((entry) => entry.name).join(", "),
      ),
    );
  }

  const configuredSandboxProfile = input.environment?.sandboxProfile;
  const sandboxConfigured =
    hasConfiguredSection(input.configs, ["sandbox"], configuredSandbox) ||
    configuredSandbox(configuredSandboxProfile);
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
  } else if (sandboxConfigured) {
    diagnostics.push(
      blockingDiagnostic(
        "pi.sandbox_unavailable",
        "sandbox",
        "当前工作区启用了 Melody 的 OS 级沙箱配置；Pi 只提供宿主路径校验，无法等价执行内核隔离，因此已阻止打开 Pi 会话。",
        configuredSandbox(configuredSandboxProfile)
          ? "env.MELODY_SANDBOX"
          : "config.sandbox",
      ),
    );
  }

  if (
    hasConfiguredPath(
      input.configs,
      [["features", "codebase_indexing"]],
      codebaseIndexingPolicyInvalid,
    )
  ) {
    diagnostics.push(
      degradation(
        "pi.codebase_indexing_unavailable",
        "codebase-indexing",
        "当前工作区的代码库索引策略格式无法由 Host 安全解析；Pi 的 tree-sitter 导航拒绝静默忽略该策略，代码库导航在本次会话中不可用，其余能力不受影响。",
        "config.features.codebase_indexing",
      ),
    );
  }

  if (
    hasConfiguredPath(
      input.configs,
      [
        ["auth", "auth_provider_command"],
        ["grok_com_config", "auth_provider_command"],
      ],
      configuredString,
    )
  ) {
    diagnostics.push(
      degradation(
        "pi.external_auth_unavailable",
        "external-auth-provider",
        "当前工作区配置了外部认证提供程序命令；Pi worker 只支持 Host 管理的 API key，该登录方式在本次会话中不可用，其余能力不受影响。",
        "config.auth.auth_provider_command",
      ),
    );
  }

  if (
    hasConfiguredPath(
      input.configs,
      [
        ["grok_com_config", "oidc"],
        ["auth", "oidc"],
      ],
      objectHasEntries,
    )
  ) {
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
  const configHasUnsupportedDefinitions = hasConfiguredPath(
    input.configs,
    [["subagents"]],
    unsupportedSubagentPolicy,
  );
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

  if (
    hasConfiguredPath(
      input.configs,
      [
        ["toolset", "bash", "timeout_secs"],
        ["toolset", "bash", "max_timeout_secs"],
        ["toolset", "bash", "output_byte_limit"],
      ],
      invalidTerminalPolicyValue,
    )
  ) {
    diagnostics.push(
      degradation(
        "pi.terminal_policy_unavailable",
        "terminal-policy",
        "当前工作区的终端超时或输出上限配置无法安全解析；Pi 迁移版拒绝静默忽略该策略，相关配置在本次会话中不生效（使用 Host 默认上限），其余能力不受影响。",
        "config.toolset.bash",
      ),
    );
  }

  if (
    hasConfiguredPath(
      input.configs,
      [["toolset", "ask_user_question", "timeout_enabled"]],
      invalidQuestionTimeoutEnabledValue,
    ) ||
    hasConfiguredPath(
      input.configs,
      [["toolset", "ask_user_question", "timeout_secs"]],
      invalidQuestionTimeoutSecondsValue,
    )
  ) {
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
    input.lspServers === undefined
      ? hasConfiguredSection(input.configs, [
          "lsp_servers",
          "lspServers",
          "lsp",
          "lsps",
        ]) ||
        hasConfiguredPath(
          input.configs,
          [["features", "lsp_tools"]],
          (value) => value === true,
        )
      : false;
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

  if (
    hasConfiguredSection(input.configs, ["memory"], memoryNeedsPiDegradation)
  ) {
    diagnostics.push(
      degradation(
        "pi.memory_semantic_index_unavailable",
        "memory",
        "当前工作区启用了记忆语义索引或 dream consolidation（embedding/vector/dream）；语义索引在本次会话中不可用，基础 Markdown 检索、写入、首轮注入、会话保存与两阶段 memory flush（含 /flush）仍由 Pi/Host 提供。",
        "config.memory",
      ),
    );
  }

  if (hasAdvancedGoalOrchestration(input.configs)) {
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
