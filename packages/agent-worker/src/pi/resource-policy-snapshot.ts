import { resolve } from "node:path";
import type {
  AgentGoalPolicy,
  AgentQuestionTimeoutPolicy,
  AgentResourceManifest,
  AgentSubagentPolicyManifest,
} from "@melody/agent-contract";
import {
  emptyPiSubagentPolicyManifest,
  normalizePiSubagentPolicyManifest,
} from "./subagent-policy-normalization.ts";
import { normalizeGoalPolicy } from "./goal-state.ts";
import {
  normalizePiResourceRoots,
  type PiPromptRootSpec,
  type PiSkillRootSpec,
} from "./resource-discovery.ts";
import { fail } from "./session-errors.ts";

const PI_RESPECT_GITIGNORE_ENV = "MELODY_RESPECT_GITIGNORE";
const PI_QUESTION_TIMEOUT_POLICY_ENV = "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON";
const PI_GOAL_POLICY_ENV = "MELODY_PI_GOAL_POLICY_JSON";
const PI_SUBAGENT_POLICIES_ENV = "MELODY_PI_SUBAGENT_POLICIES_JSON";

type EnvironmentSnapshot = Record<string, string | undefined>;

export interface PiRuntimePolicySnapshot {
  respectGitignore: boolean;
  questionTimeoutPolicy?: AgentQuestionTimeoutPolicy;
  goalPolicy?: AgentGoalPolicy;
  subagentPolicies: AgentSubagentPolicyManifest;
}

export interface PiResourcePolicySnapshot extends PiRuntimePolicySnapshot {
  skillRoots: PiSkillRootSpec[];
  promptRoots: PiPromptRootSpec[];
}

const parseBooleanEnvironment = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

const parseQuestionTimeoutPolicyEnvironment = (
  value: string | undefined,
): AgentQuestionTimeoutPolicy | undefined => {
  if (!value?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.enabled !== "boolean" ||
      typeof record.timeoutMs !== "number" ||
      !Number.isSafeInteger(record.timeoutMs) ||
      record.timeoutMs < 1 ||
      record.timeoutMs > 2_147_483_647
    ) {
      return undefined;
    }
    return { enabled: record.enabled, timeoutMs: record.timeoutMs };
  } catch {
    return undefined;
  }
};

const parseGoalPolicyEnvironment = (
  value: string | undefined,
): AgentGoalPolicy | undefined => {
  if (!value?.trim()) return undefined;
  try {
    return normalizeGoalPolicy(JSON.parse(value));
  } catch {
    // Direct worker launches fail closed for malformed policy snapshots. A
    // Host refresh will replace this value with the authoritative manifest.
    return undefined;
  }
};

const disabledPiSubagentPolicyManifest = (): AgentSubagentPolicyManifest => ({
  enabled: false,
  models: {},
  toggle: {},
  roles: [],
  personas: [],
  agents: [],
});

const parseSubagentPolicyEnvironment = (
  value: string | undefined,
): AgentSubagentPolicyManifest => {
  if (!value?.trim()) return emptyPiSubagentPolicyManifest();
  try {
    return normalizePiSubagentPolicyManifest(JSON.parse(value));
  } catch {
    // A malformed Host projection must never silently restore all custom
    // subagent capabilities. Disable delegation until the next authoritative
    // resource refresh replaces the snapshot.
    return disabledPiSubagentPolicyManifest();
  }
};

/** Parse the bounded, non-secret policy snapshot supplied at worker launch. */
export const parsePiRuntimePolicyEnvironment = (
  environment: EnvironmentSnapshot,
): PiRuntimePolicySnapshot => ({
  respectGitignore: parseBooleanEnvironment(
    environment[PI_RESPECT_GITIGNORE_ENV],
  ),
  questionTimeoutPolicy: parseQuestionTimeoutPolicyEnvironment(
    environment[PI_QUESTION_TIMEOUT_POLICY_ENV],
  ),
  goalPolicy: parseGoalPolicyEnvironment(environment[PI_GOAL_POLICY_ENV]),
  subagentPolicies: parseSubagentPolicyEnvironment(
    environment[PI_SUBAGENT_POLICIES_ENV],
  ),
});

/** Validate and normalize a Host-owned resource/policy refresh snapshot. */
export const normalizePiResourcePolicySnapshot = (
  cwd: string,
  manifest: AgentResourceManifest,
  environment: EnvironmentSnapshot,
): PiResourcePolicySnapshot => {
  if (resolve(manifest.cwd) !== resolve(cwd)) {
    throw fail(
      "pi.resource_cwd_mismatch",
      "Pi 资源清单的工作区必须与当前 worker 一致。",
      "session",
    );
  }
  const roots = normalizePiResourceRoots(
    cwd,
    manifest.skillRoots,
    manifest.promptRoots,
    environment,
  );
  if (!roots.ok && roots.kind === "skill") {
    throw fail(
      "pi.resource_root_invalid",
      "Pi 资源清单包含不属于受信工作区的 Skill 根目录。",
      "session",
    );
  }
  if (!roots.ok) {
    throw fail(
      "pi.resource_root_invalid",
      "Pi 资源清单包含不属于受信工作区的命令根目录。",
      "session",
    );
  }
  const { skillRoots, promptRoots } = roots;
  const respectGitignore =
    manifest.respectGitignore === undefined
      ? parseBooleanEnvironment(environment[PI_RESPECT_GITIGNORE_ENV])
      : manifest.respectGitignore;
  if (typeof respectGitignore !== "boolean") {
    throw fail(
      "pi.resource_manifest_invalid",
      "Pi 资源清单的 respectGitignore 必须是布尔值。",
      "session",
    );
  }
  // A Host refresh is authoritative. If the Host omits the optional policy,
  // clear the previous snapshot instead of falling back to a stale startup
  // environment value. The environment fallback is applied once by the
  // adapter field for direct worker launches.
  const questionTimeoutPolicy = manifest.questionTimeoutPolicy;
  if (
    questionTimeoutPolicy !== undefined &&
    (typeof questionTimeoutPolicy !== "object" ||
      questionTimeoutPolicy === null ||
      typeof questionTimeoutPolicy.enabled !== "boolean" ||
      !Number.isSafeInteger(questionTimeoutPolicy.timeoutMs) ||
      questionTimeoutPolicy.timeoutMs < 1 ||
      questionTimeoutPolicy.timeoutMs > 2_147_483_647)
  ) {
    throw fail(
      "pi.resource_manifest_invalid",
      "Pi 资源清单的 questionTimeoutPolicy 无效。",
      "session",
    );
  }
  let goalPolicy: AgentGoalPolicy | undefined;
  if (manifest.goalPolicy !== undefined) {
    goalPolicy = normalizeGoalPolicy(manifest.goalPolicy);
    if (!goalPolicy) {
      throw fail(
        "pi.goal_policy_invalid",
        "Pi 资源清单的 goalPolicy 无效。",
        "session",
      );
    }
  }
  let subagentPolicies: AgentSubagentPolicyManifest;
  try {
    subagentPolicies = normalizePiSubagentPolicyManifest(
      manifest.subagentPolicies,
    );
  } catch (error) {
    throw fail(
      "pi.subagent_policy_invalid",
      error instanceof Error ? error.message : String(error),
      "session",
    );
  }
  return {
    skillRoots,
    promptRoots,
    respectGitignore,
    questionTimeoutPolicy,
    subagentPolicies,
    goalPolicy,
  };
};
