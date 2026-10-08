import assert from "node:assert/strict";
import test from "node:test";

import {
  composePiSubagentPrompt,
  normalizePiSubagentPolicyManifest,
  resolvePiSubagentPolicy,
} from "./subagent-policy.ts";

const manifest = {
  enabled: true,
  toggle: { explore: false, reviewer: true },
  models: { explore: "provider/explore", plan: "provider/plan" },
  roles: [
    {
      name: "reviewer",
      description: "Read-only review",
      defaultCapabilityMode: "read-only",
      modelId: "provider/reviewer",
      reasoningEffort: "high",
      isolation: "worktree",
      instructions: "Review the change and report concrete findings.",
    },
  ],
  agents: [
    {
      name: "security-reviewer",
      description: "Review security-sensitive changes.",
      instructions: "Look for trust-boundary regressions.",
      defaultCapabilityMode: "read-only",
      permissionMode: "auto",
      modelId: "provider/security",
      reasoningEffort: "high",
      isolation: "worktree",
    },
  ],
  personas: [
    {
      name: "concise",
      description: "Concise responses",
      instructions: "Be concise and omit filler.",
      reasoningEffort: "low",
    },
  ],
};

test("normalizes and bounds Host subagent policies", () => {
  const normalized = normalizePiSubagentPolicyManifest(manifest);
  assert.equal(normalized.roles[0].name, "reviewer");
  assert.equal(
    normalized.personas[0].instructions,
    "Be concise and omit filler.",
  );
  assert.equal(normalized.toggle.explore, false);
  assert.equal(normalized.agents[0].permissionMode, "auto");
  assert.throws(
    () =>
      normalizePiSubagentPolicyManifest({
        ...manifest,
        roles: [{ ...manifest.roles[0], defaultCapabilityMode: "root" }],
      }),
    (error) => error?.agentError?.code === "pi.subagent_policy_invalid",
  );
  assert.throws(
    () =>
      normalizePiSubagentPolicyManifest({
        ...manifest,
        personas: [
          { ...manifest.personas[0], instructions: "x".repeat(32_769) },
        ],
      }),
    (error) => error?.agentError?.code === "pi.subagent_policy_invalid",
  );
});

test("resolves a declarative agent definition and composes its instructions", () => {
  const policies = normalizePiSubagentPolicyManifest(manifest);
  const resolved = resolvePiSubagentPolicy(policies, {
    agent: "security-reviewer",
    subagentType: "general-purpose",
  });
  assert.equal(resolved.agent?.name, "security-reviewer");
  assert.equal(resolved.modelId, "provider/security");
  assert.equal(resolved.permissionMode, "auto");
  assert.match(
    composePiSubagentPrompt(resolved, "Inspect auth changes."),
    /<agent-instructions>[\s\S]*trust-boundary[\s\S]*Inspect auth changes\./u,
  );
});

test("resolves role/persona defaults with explicit values taking precedence", () => {
  const policies = normalizePiSubagentPolicyManifest(manifest);
  const resolved = resolvePiSubagentPolicy(policies, {
    subagentType: "reviewer",
    role: "reviewer",
    persona: "concise",
    modelId: "provider/explicit",
    reasoningEffort: "medium",
    isolation: "none",
  });
  assert.equal(resolved.role?.name, "reviewer");
  assert.equal(resolved.persona?.name, "concise");
  assert.equal(resolved.modelId, "provider/explicit");
  assert.equal(resolved.reasoningEffort, "medium");
  assert.equal(resolved.isolation, "none");
  assert.equal(resolved.capabilityMode, "read-only");
  assert.match(
    composePiSubagentPrompt(resolved, "Inspect the diff."),
    /<role-instructions>[\s\S]*Review the change[\s\S]*<persona>[\s\S]*Be concise[\s\S]*Inspect the diff/u,
  );
});

test("applies per-type model defaults and rejects disabled or unknown definitions", () => {
  const policies = normalizePiSubagentPolicyManifest(manifest);
  assert.equal(
    resolvePiSubagentPolicy(policies, { subagentType: "plan" }).modelId,
    "provider/plan",
  );
  assert.throws(
    () => resolvePiSubagentPolicy(policies, { subagentType: "explore" }),
    (error) => error?.agentError?.code === "pi.subagent_disabled",
  );
  assert.throws(
    () =>
      resolvePiSubagentPolicy(policies, {
        subagentType: "general-purpose",
        role: "missing",
      }),
    (error) => error?.agentError?.code === "pi.subagent_role_not_found",
  );
  assert.throws(
    () =>
      resolvePiSubagentPolicy(policies, {
        subagentType: "general-purpose",
        persona: "missing",
      }),
    (error) => error?.agentError?.code === "pi.subagent_persona_not_found",
  );
});

test("fails closed for definitions that still require the ACP tool graph", () => {
  const policies = normalizePiSubagentPolicyManifest({
    enabled: true,
    roles: [],
    personas: [],
    agents: [],
    unsupportedAgents: ["plugin-agent"],
    models: {},
    toggle: {},
  });
  assert.throws(
    () =>
      resolvePiSubagentPolicy(policies, {
        agent: "plugin-agent",
      }),
    (error) => error?.agentError?.code === "pi.subagent_definition_unavailable",
  );
});

test("carries exact MCP grants and rejects malformed ones", () => {
  const policies = normalizePiSubagentPolicyManifest({
    enabled: true,
    roles: [],
    personas: [],
    models: {},
    toggle: {},
    agents: [
      {
        name: "literature-reviewer",
        defaultCapabilityMode: "read-write",
        mcpTools: [
          "mcp__zotero__zotero_search_items",
          "mcp__zotero__zotero_search_items",
        ],
      },
    ],
  });
  const resolved = resolvePiSubagentPolicy(policies, {
    agent: "literature-reviewer",
  });
  assert.deepEqual(resolved.mcpTools, ["mcp__zotero__zotero_search_items"]);
  assert.equal(resolved.capabilityMode, "read-write");

  // A definition without grants exposes none, so a bounded child cannot widen
  // into the whole MCP surface.
  const noGrants = normalizePiSubagentPolicyManifest({
    enabled: true,
    roles: [],
    personas: [],
    models: {},
    toggle: {},
    agents: [{ name: "reader", defaultCapabilityMode: "read-only" }],
  });
  assert.equal(
    resolvePiSubagentPolicy(noGrants, { agent: "reader" }).mcpTools,
    undefined,
  );

  for (const mcpTools of [
    ["zotero_search_items"],
    ["mcp__zotero"],
    ["mcp__zotero__"],
    ["mcp__zot__has space"],
    Array.from({ length: 65 }, (_value, index) => `mcp__zotero__tool_${index}`),
  ]) {
    assert.throws(
      () =>
        normalizePiSubagentPolicyManifest({
          enabled: true,
          roles: [],
          personas: [],
          models: {},
          toggle: {},
          agents: [{ name: "bad", mcpTools }],
        }),
      (error) => error?.agentError?.code === "pi.subagent_policy_invalid",
      `expected rejection for ${JSON.stringify(mcpTools).slice(0, 60)}`,
    );
  }
});
