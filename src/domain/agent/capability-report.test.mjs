import assert from "node:assert/strict";
import test from "node:test";

import { inspectPiCapabilityReport } from "./capability-report.ts";

const config = (scope, values, parseError) => ({
  scope,
  values,
  ...(parseError ? { parseError } : {}),
});

// A degradation states the capability is unavailable in the current Pi session
// (不同规则的措辞分别是 不可用/无法/不生效/不可选/不注入/不加载) without ever
// claiming a compatibility-engine fallback.
const assertDegradation = (diagnostic, note) => {
  assert.equal(diagnostic.severity, "warning", note);
  assert.equal(diagnostic.fallbackEngine, undefined, note);
  assert.doesNotMatch(diagnostic.message, /回退|fallback|ACP/iu, note);
  assert.match(
    diagnostic.message,
    /不可用|无法|不生效|不可选|不注入|不加载/u,
    note,
  );
};

test("keeps a clean workspace on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("user", { models: { default: "grok-4.5" } })],
    extensions: [
      {
        kind: "skills",
        name: "review",
        enabled: true,
      },
    ],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps managed and standard external Markdown Skills on Pi", () => {
  const managed = {
    kind: "skills",
    name: "review",
    provider: "melody",
    path: "/home/me/.melody/skills/review",
    enabled: true,
  };
  const external = {
    kind: "skills",
    name: "ai-elements",
    provider: "agents",
    path: "/home/me/.agents/skills/ai-elements",
    enabled: true,
  };

  const clean = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    skills: [managed],
  });
  assert.equal(clean.blocksPiSession, false);

  const report = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    skills: [managed, external],
  });
  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);

  const plugin = {
    ...external,
    name: "plugin-skill",
    provider: "plugin",
  };
  const pluginReport = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    skills: [plugin],
  });
  assert.equal(pluginReport.blocksPiSession, false);
  assert.equal(pluginReport.diagnostics[0].code, "pi.skills_unavailable");
  assertDegradation(pluginReport.diagnostics[0]);
  assert.equal(pluginReport.degradations.length, 1);
});

test("keeps static-only plugin Skills on Pi and degrades dynamic plugins", () => {
  const staticPlugin = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    skills: [
      {
        kind: "skills",
        name: "static-tools:review",
        pluginName: "static-tools",
        provider: "plugin",
        path: "/home/me/.melody/installed-plugins/static-tools/skills/review",
        enabled: true,
      },
    ],
    plugins: [
      {
        name: "static-tools",
        path: "/home/me/.melody/installed-plugins/static-tools",
        scope: "user",
        enabled: true,
        staticResources: true,
        dynamicComponents: [],
      },
    ],
  });
  assert.equal(staticPlugin.blocksPiSession, false);
  assert.deepEqual(staticPlugin.diagnostics, []);

  const dynamicPlugin = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    skills: [
      {
        kind: "skills",
        name: "git-tools:review",
        pluginName: "git-tools",
        provider: "plugin",
        path: "/home/me/.melody/installed-plugins/git-tools/skills/review",
        enabled: true,
      },
    ],
    plugins: [
      {
        name: "git-tools",
        path: "/home/me/.melody/installed-plugins/git-tools",
        scope: "user",
        enabled: true,
        staticResources: false,
        dynamicComponents: ["hooks"],
      },
    ],
  });
  assert.equal(dynamicPlugin.blocksPiSession, false);
  assert.deepEqual(
    dynamicPlugin.diagnostics.map((item) => item.code),
    ["pi.skills_unavailable", "pi.plugins_unavailable"],
  );
  for (const item of dynamicPlugin.diagnostics) assertDegradation(item);
});

test("ignores discovered-but-inactive plugins when deciding the engine", () => {
  // Melody activates a plugin only when `[plugins].enabled` lists it, so a
  // marketplace clone or install cache full of dynamic plugins must not force
  // opening a Pi session on its own.
  const report = inspectPiCapabilityReport({
    configs: [
      {
        scope: "user",
        values: { plugins: { enabled: ["alpha"], disabled: [] } },
      },
    ],
    extensions: [],
    skills: [],
    plugins: [
      {
        name: "alpha",
        path: "/home/me/.melody/installed-plugins/alpha",
        scope: "user",
        enabled: true,
        staticResources: true,
        dynamicComponents: [],
      },
      {
        name: "marketplace-only",
        path: "/home/me/.claude/plugins/marketplaces/official/plugins/marketplace-only",
        scope: "user",
        enabled: false,
        staticResources: false,
        dynamicComponents: ["agents", "hooks", "scripts"],
      },
    ],
  });
  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("recognizes external skill roots when reported as relative or Windows paths", () => {
  for (const path of [".agents/skills/review", ".claude\\skills\\review"]) {
    const report = inspectPiCapabilityReport({
      configs: [],
      extensions: [],
      skills: [
        {
          kind: "skills",
          name: "review",
          path,
          enabled: true,
        },
      ],
    });

    assert.equal(report.blocksPiSession, false, path);
    assert.deepEqual(report.diagnostics, [], path);
  }
});

test("reports every configured capability that Pi cannot safely execute", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        mcp_servers: { filesystem: { command: "mcp-server-filesystem" } },
        memory: { enabled: true },
      }),
      config("project", {
        lspServers: { rust: { command: "rust-analyzer" } },
      }),
    ],
    extensions: [
      { kind: "hooks", name: "after-tool.sh", enabled: true },
      { kind: "plugins", name: "git-tools", enabled: true },
      { kind: "plugins", name: "disabled-plugin", enabled: false },
    ],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.lsp_unavailable", "pi.hooks_unavailable", "pi.plugins_unavailable"],
  );
  assert.equal(report.degradations.length, 3);
  for (const item of report.diagnostics) assertDegradation(item);
});

test("keeps Host-validated command hooks on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [],
    extensions: [{ kind: "hooks", name: "after-tool.json", enabled: true }],
    hooks: [
      {
        name: "after-tool.json",
        path: ".melody/hooks/after-tool.json",
        scope: "project",
        enabled: true,
        supported: true,
      },
    ],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("flags unsafe Host hook definitions as degradations", () => {
  const report = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    hooks: [
      {
        name: "dynamic.json",
        path: ".melody/hooks/dynamic.json",
        scope: "project",
        enabled: true,
        supported: false,
        unsupportedFields: ["PreToolUse.hooks[0].type"],
      },
      {
        name: "disabled.json",
        enabled: false,
        supported: false,
      },
    ],
  });

  assert.equal(report.blocksPiSession, false);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].code, "pi.hooks_unavailable");
  assert.match(report.diagnostics[0].source ?? "", /dynamic\.json/);
  assertDegradation(report.diagnostics[0]);
});

test("keeps stdio MCP on Pi and degrades unverified LSP inventory", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        mcpServers: [{ name: "filesystem", command: "mcp-server" }],
        lsp_servers: [{ name: "typescript" }],
      }),
    ],
    extensions: [],
  });

  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.lsp_unavailable"],
  );
  assert.equal(report.blocksPiSession, false);
  assertDegradation(report.diagnostics[0]);
});

test("keeps Host-validated trusted stdio LSP on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    lspServers: [
      {
        name: "typescript",
        scope: "project",
        path: ".melody/lsp.json",
        enabled: true,
        supported: true,
      },
    ],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("flags unsafe LSP inventory entries as degradations without blocking unrelated Pi work", () => {
  const report = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    lspServers: [
      {
        name: "untrusted-project",
        scope: "project",
        path: ".melody/lsp.json",
        enabled: true,
        supported: false,
        unsupportedFields: ["projectTrustRequired"],
      },
      {
        name: "disabled",
        scope: "user",
        path: "~/.melody/lsp.json",
        enabled: false,
        supported: false,
      },
    ],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.lsp_unavailable"],
  );
  assertDegradation(report.diagnostics[0]);
});

test("keeps validated stdio and remote MCP transports on the Pi bridge", () => {
  const stdio = inspectPiCapabilityReport({
    configs: [
      config("project", {
        mcp_servers: { local: { command: "mcp-server" } },
      }),
    ],
    extensions: [],
  });
  assert.equal(stdio.blocksPiSession, false);
  assert.deepEqual(stdio.diagnostics, []);

  const remote = inspectPiCapabilityReport({
    configs: [
      config("project", {
        mcp_servers: {
          remote: { url: "https://example.test/mcp", transport: "sse" },
        },
      }),
    ],
    extensions: [],
  });
  assert.equal(remote.blocksPiSession, false);
  assert.deepEqual(remote.diagnostics, []);

  const malformedRemote = inspectPiCapabilityReport({
    configs: [
      config("project", {
        mcp_servers: {
          remote: { url: "https://example.test/mcp", transport: "websocket" },
        },
      }),
    ],
    extensions: [],
  });
  assert.equal(malformedRemote.blocksPiSession, false);
  assert.equal(malformedRemote.diagnostics[0].code, "pi.mcp_unavailable");
  assert.match(malformedRemote.diagnostics[0].source, /remote/u);
  assertDegradation(malformedRemote.diagnostics[0]);
});

test("keeps Host-owned web search and web fetch on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        models: { web_search: "grok-4.20-multi-agent" },
        features: { web_fetch: true },
        toolset: {
          web_fetch: { allowed_domains: ["docs.rs"] },
        },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps disabled web tools and online catalog opt-out on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        models: { web_search: "" },
        features: { web_fetch: false, remote_fetch: false },
        toolset: { web_fetch: { enabled: false } },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps remote model-catalog refresh on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("user", { features: { remote_fetch: true } })],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps the default codebase index on the Host tree-sitter bridge", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        features: { codebase_indexing: true, two_pass_compaction: true },
        session: { load_envrc: true },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps codebase index path policies on the Host tree-sitter bridge", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        features: {
          codebase_indexing: ["/Users/*/repo", "!/Users/*/repo/tmp"],
        },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("degrades malformed codebase index path policies", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        features: { codebase_indexing: ["/Users/*/[repo"] },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.codebase_indexing_unavailable"],
  );
  assertDegradation(report.diagnostics[0]);
});

test("keeps Pi-native two-pass compaction and memory flush on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        features: { two_pass_compaction: true },
        compaction: { memory_flush: { enabled: true } },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps deterministic goal safety rails on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        goal: {
          enabled: true,
          token_budget: 20_000,
          stall_detection: true,
          stall_timeout_secs: 120,
        },
      }),
    ],
    extensions: [],
  });
  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps the basic goal toggle on Pi but degrades advanced goal orchestration", () => {
  const basic = inspectPiCapabilityReport({
    configs: [config("project", { goal: { enabled: true } })],
    extensions: [],
  });
  assert.equal(basic.blocksPiSession, false);
  assert.deepEqual(basic.diagnostics, []);

  const advanced = inspectPiCapabilityReport({
    configs: [
      config("project", {
        goal: {
          enabled: true,
          classifier_enabled: true,
          skeptic_models: ["reviewer"],
        },
      }),
    ],
    extensions: [],
  });
  assert.equal(advanced.blocksPiSession, false);
  assert.deepEqual(
    advanced.diagnostics.map((item) => item.code),
    ["pi.goal_orchestration_unavailable"],
  );
  assertDegradation(advanced.diagnostics[0]);
});

test("keeps Host-owned .envrc projection on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("project", { session: { load_envrc: true } })],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps projected subagent toggles, models, roles, and personas on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        tools: {
          respect_gitignore: true,
        },
        session: {
          auto_compact_threshold_percent: 80,
        },
        auth: {
          auth_provider_command: "/usr/local/bin/company-login",
        },
        grok_com_config: {
          oidc: { issuer: "https://login.example.test" },
        },
        subagents: {
          enabled: false,
          toggle: { explore: false },
          models: { explore: "melody-build" },
          roles: { reviewer: { default_capability_mode: "read-only" } },
          personas: { concise: { instructions: "Be concise." } },
        },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.external_auth_unavailable", "pi.oidc_unavailable"],
  );
  for (const item of report.diagnostics) assertDegradation(item);
});

test("flags dynamic Melody agent definitions as degradations while keeping declarative agents on Pi", () => {
  // The Host resolves a tool allowlist into the narrowest Pi capability
  // ceiling, so `tools` alone is no longer a blocking field.
  const withTools = inspectPiCapabilityReport({
    configs: [
      config("project", {
        subagents: {
          agents: { secure_reviewer: { tools: ["workspace_read_file"] } },
          roles: { reviewer: { default_capability_mode: "read-only" } },
        },
      }),
    ],
    extensions: [],
  });
  assert.equal(withTools.blocksPiSession, false);
  assert.deepEqual(withTools.diagnostics, []);

  // A definition that changes the tool graph or the completion contract in ways
  // the bounded Pi manifest cannot express is still reported as a degradation.
  const dynamic = inspectPiCapabilityReport({
    configs: [
      config("project", {
        subagents: {
          agents: {
            secure_reviewer: {
              tools: ["workspace_read_file"],
              mcpServers: ["linear"],
              maxTurns: 12,
            },
          },
        },
      }),
    ],
    extensions: [],
  });
  assert.equal(dynamic.blocksPiSession, false);
  assert.deepEqual(
    dynamic.diagnostics.map((item) => item.code),
    ["pi.subagent_definition_unavailable"],
  );
  assertDegradation(dynamic.diagnostics[0]);
});

test("keeps declarative agent definitions on Pi and flags dynamic inventory entries as degradations", () => {
  const clean = inspectPiCapabilityReport({
    configs: [
      config("project", {
        subagents: {
          agents: {
            reviewer: {
              prompt: "Review the change.",
              model: "provider/reviewer",
              capability_mode: "read-only",
              permission_mode: "ask",
            },
          },
        },
      }),
    ],
    extensions: [],
    agentDefinitions: [
      {
        name: "reviewer",
        path: ".melody/config.toml",
        scope: "project",
        enabled: true,
        supported: true,
      },
    ],
  });
  assert.equal(clean.blocksPiSession, false);
  assert.deepEqual(clean.diagnostics, []);

  const dynamic = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    agentDefinitions: [
      {
        name: "with-tools",
        path: ".melody/agents/with-tools.md",
        scope: "project",
        enabled: true,
        supported: false,
        unsupportedFields: ["tools"],
      },
    ],
  });
  assert.equal(dynamic.blocksPiSession, false);
  assert.equal(
    dynamic.diagnostics[0].code,
    "pi.subagent_definition_unavailable",
  );
  assert.match(dynamic.diagnostics[0].source, /with-tools/u);
  assertDegradation(dynamic.diagnostics[0]);
});

test("keeps Host-owned gitignore filtering on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        tools: { respect_gitignore: true },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps a custom auto-compaction threshold on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        session: { auto_compact_threshold_percent: 85 },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("keeps valid custom terminal and question timeout policies on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        toolset: {
          bash: { timeout_secs: 45 },
          ask_user_question: { timeout_enabled: false },
        },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(report.diagnostics, []);
});

test("degrades invalid question timeout policy values", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        toolset: {
          ask_user_question: {
            timeout_enabled: "false",
            timeout_secs: 0,
          },
        },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.question_timeout_policy_unavailable"],
  );
  assertDegradation(report.diagnostics[0]);
});

test("degrades invalid custom terminal policy values", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        toolset: {
          bash: { timeout_secs: "45", output_byte_limit: 0 },
        },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.terminal_policy_unavailable"],
  );
  assertDegradation(report.diagnostics[0]);
});

test("keeps an enforceable Host sandbox on Pi and blocks an unenforceable one", () => {
  const enforceable = inspectPiCapabilityReport({
    configs: [config("user", { sandbox: { profile: "workspace" } })],
    extensions: [],
    sandboxPlan: { profile: "workspace", enforceable: true },
  });
  // The Host can confine terminal children, so the session stays on Pi.
  assert.equal(enforceable.blocksPiSession, false);
  assert.deepEqual(enforceable.diagnostics, []);

  const unenforceable = inspectPiCapabilityReport({
    configs: [config("user", { sandbox: { profile: "strict" } })],
    extensions: [],
    sandboxPlan: {
      profile: "strict",
      enforceable: false,
      reason: "profile 'strict' also restricts child networking",
    },
  });
  assert.equal(unenforceable.blocksPiSession, true);
  assert.deepEqual(
    unenforceable.diagnostics.map((item) => item.code),
    ["pi.sandbox_unavailable"],
  );
  assert.equal(unenforceable.diagnostics[0].severity, "blocking");
  assert.equal(unenforceable.diagnostics[0].fallbackEngine, undefined);
  assert.equal(unenforceable.degradations.length, 0);
  assert.match(unenforceable.diagnostics[0].message, /网络|networking/u);
});

test("a platform without any sandbox implementation degrades with a prominent warning", () => {
  // Windows (and any other OS without an enforcement implementation) must not
  // lock the user out: the session stays on Pi and runs unsandboxed, with the
  // trade-off stated in the diagnostic.
  const report = inspectPiCapabilityReport({
    configs: [config("user", { sandbox: { profile: "workspace" } })],
    extensions: [],
    sandboxPlan: {
      profile: "workspace",
      enforceable: false,
      reason: "OS sandbox enforcement is not implemented for windows yet",
      reasonCode: "platform-unsupported",
    },
  });
  assert.equal(report.blocksPiSession, false);
  assert.equal(report.degradations.length, 1);
  assert.equal(report.degradations[0].code, "pi.sandbox_unavailable");
  assert.equal(report.degradations[0].severity, "warning");
  assert.equal(report.degradations[0].fallbackEngine, undefined);
  assert.match(report.degradations[0].message, /无沙箱/u);
  assert.match(report.degradations[0].message, /可信/u);
});

test("blocks Pi when a configured Melody sandbox cannot be enforced", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        sandbox: { profile: "strict" },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, true);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.sandbox_unavailable"],
  );
  assert.equal(report.diagnostics[0].severity, "blocking");
  assert.equal(report.diagnostics[0].fallbackEngine, undefined);

  for (const value of [{ profile: "off" }, { enabled: false }, "off", false]) {
    const optOut = inspectPiCapabilityReport({
      configs: [config("user", { sandbox: value })],
      extensions: [],
    });
    assert.equal(optOut.blocksPiSession, false, JSON.stringify(value));
    assert.deepEqual(optOut.diagnostics, [], JSON.stringify(value));
  }

  const environmentReport = inspectPiCapabilityReport({
    configs: [],
    extensions: [],
    environment: { sandboxProfile: "workspace" },
  });
  assert.equal(environmentReport.blocksPiSession, true);
  assert.equal(environmentReport.diagnostics[0].code, "pi.sandbox_unavailable");
  assert.equal(environmentReport.diagnostics[0].source, "env.MELODY_SANDBOX");
  assert.equal(environmentReport.diagnostics[0].severity, "blocking");
  assert.equal(environmentReport.diagnostics[0].fallbackEngine, undefined);
});

test("recognizes the settings-page LSP switch and unsupported alternate MCP root", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        features: { lsp_tools: true },
        mcps: { github: { enabled: true } },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.mcp_unavailable", "pi.lsp_unavailable"],
  );
  for (const item of report.diagnostics) assertDegradation(item);
});

test("does not treat explicitly disabled memory as a Pi blocker", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("user", { memory: { enabled: false } })],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
});

test("keeps common Host-owned memory lifecycle on Pi", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("project", {
        memory: {
          enabled: true,
          session: { save_on_end: true },
          initial_injection: { enabled: true },
          search: { max_results: 8 },
        },
      }),
    ],
    extensions: [],
  });

  assert.deepEqual(report.diagnostics, []);
});

test("degrades semantic memory index and dream consolidation settings", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {
        memory: {
          enabled: true,
          embedding: { model: "text-embedding-3-small", dimensions: 1536 },
        },
      }),
      config("project", {
        memory: { dream: { enabled: true } },
      }),
    ],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.memory_semantic_index_unavailable"],
  );
  assertDegradation(report.diagnostics[0]);
});

test("blocks Pi when either config document cannot be parsed", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("project", {}, "invalid TOML")],
    extensions: [],
  });

  assert.equal(report.blocksPiSession, true);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.config_unreadable"],
  );
  assert.equal(report.diagnostics[0].severity, "blocking");
  assert.equal(report.diagnostics[0].fallbackEngine, undefined);
  assert.equal(report.diagnostics[0].source, undefined);
});

test("keeps a Pi session running with degradation-only capability gaps", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("project", { mcp_servers: { broken: { command: "" } } })],
    extensions: [{ kind: "plugins", name: "git-tools", enabled: true }],
    agentDefinitions: [
      {
        name: "with-tools",
        path: ".melody/agents/with-tools.md",
        scope: "project",
        enabled: true,
        supported: false,
        unsupportedFields: ["tools"],
      },
    ],
  });

  assert.equal(report.engine, "pi");
  assert.equal(report.blocksPiSession, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    [
      "pi.mcp_unavailable",
      "pi.subagent_definition_unavailable",
      "pi.plugins_unavailable",
    ],
  );
  assert.equal(report.degradations.length, 3);
  for (const item of report.degradations) {
    assertDegradation(item);
    assert.ok(
      report.diagnostics.some((candidate) => candidate.code === item.code),
      item.code,
    );
  }
});

test("still lists degradations when a blocking config failure coexists", () => {
  const report = inspectPiCapabilityReport({
    configs: [config("user", {}, "invalid TOML")],
    extensions: [{ kind: "plugins", name: "git-tools", enabled: true }],
  });

  assert.equal(report.blocksPiSession, true);
  assert.deepEqual(
    report.diagnostics.map((item) => item.code),
    ["pi.config_unreadable", "pi.plugins_unavailable"],
  );
  assert.equal(report.diagnostics[0].severity, "blocking");
  assert.equal(report.diagnostics[0].fallbackEngine, undefined);
  assert.equal(report.degradations.length, 1);
  assert.equal(report.degradations[0].code, "pi.plugins_unavailable");
  assertDegradation(report.degradations[0]);
});

test("collects degradations as exactly the warning-severity diagnostics", () => {
  const report = inspectPiCapabilityReport({
    configs: [
      config("user", {}, "invalid TOML"),
      config("project", { mcp_servers: { broken: { command: "" } } }),
    ],
    extensions: [{ kind: "plugins", name: "git-tools", enabled: true }],
    hooks: [
      {
        name: "dynamic.json",
        path: ".melody/hooks/dynamic.json",
        scope: "project",
        enabled: true,
        supported: false,
      },
    ],
  });

  assert.equal(report.blocksPiSession, true);
  assert.deepEqual(
    report.degradations,
    report.diagnostics.filter((item) => item.severity === "warning"),
  );
  assert.ok(report.degradations.length >= 2);
  assert.ok(
    report.degradations.every((item) => item.fallbackEngine === undefined),
  );
  assert.deepEqual(
    report.degradations.map((item) => item.code),
    ["pi.mcp_unavailable", "pi.hooks_unavailable", "pi.plugins_unavailable"],
  );
});
