import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentGoalPolicy,
  AgentResourceManifest,
} from "@melody/agent-contract";
import { createCompactionExtension } from "./compaction-extension.ts";
import { createGoalExtension } from "./goal-extension.ts";
import { createPiInstructionScope } from "./instruction-scope-extension.ts";
import { piPromptPathsFor } from "./prompt-discovery.ts";
import {
  normalizePiResourcePolicySnapshot,
  type PiResourcePolicySnapshot,
} from "./resource-policy-snapshot.ts";
import type {
  PiPromptRootSpec,
  PiSkillRootSpec,
} from "./resource-discovery.ts";
import { piSkillPathsFor } from "./skill-discovery.ts";
import { type PiResourceBinding, type PiSdk } from "./session-runtime-types.ts";
import { createTodoExtension } from "./todo-extension.ts";
import type { PiSubagentCapabilityMode } from "./tool-access-policy.ts";

export interface PiSessionResourceLoaderOptions {
  cwd: string;
  getSessionMode: () => string;
  getCapabilityMode?: () => PiSubagentCapabilityMode;
  getTokenUsage?: () => number | undefined;
  getGoalPolicy: () => AgentGoalPolicy | undefined;
  applyPolicySnapshot: (snapshot: PiResourcePolicySnapshot) => void;
}

/** Create one Pi session's Host-scoped resources and refreshable path bindings. */
export async function createPiSessionResourceBinding(
  pi: PiSdk,
  options: PiSessionResourceLoaderOptions,
): Promise<PiResourceBinding> {
  const {
    cwd,
    getSessionMode,
    getTokenUsage,
    getGoalPolicy,
    applyPolicySnapshot,
  } = options;
  const getCapabilityMode = options.getCapabilityMode ?? (() => "all");
  const configuredRoot = process.env.MELODY_HOME?.trim();
  const agentDir = configuredRoot
    ? join(configuredRoot, "pi", "agent")
    : join(tmpdir(), "melody-pi-agent");

  // Pi retains these arrays by reference, so existing sessions can discover
  // Host-projected resource changes on the next turn without ambient scans.
  const additionalSkillPaths = piSkillPathsFor(cwd);
  const additionalPromptTemplatePaths = piPromptPathsFor(cwd);
  const instructionScope = createPiInstructionScope();
  const extensionFactories = [
    instructionScope.extensionFactory,
    // Compaction is safe in every session mode. It uses Pi's public
    // session_before_compact hook and falls back to Pi's native one-pass
    // summary whenever the first or second pass cannot complete.
    createCompactionExtension(),
    // Goal state is durable and read-only to the model outside an active
    // lifecycle; unsupported classifier-backed orchestration is diagnosed
    // as unavailable in Pi.
    createGoalExtension(getSessionMode, getCapabilityMode, {
      policy: getGoalPolicy,
      getTokenUsage,
    }),
    ...(getCapabilityMode() === "read-only"
      ? []
      : [createTodoExtension(getSessionMode, getCapabilityMode)]),
  ];
  let skillRootSpecs: PiSkillRootSpec[] | undefined;
  let promptRootSpecs: PiPromptRootSpec[] | undefined;
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    // Melody plugins are discovered and trusted by the Host. Do not let a
    // Pi worker silently execute ambient ~/.pi extensions or skills. The
    // workspace context files remain available through Pi's standard,
    // read-only AGENTS/context loader.
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths,
    noPromptTemplates: true,
    additionalPromptTemplatePaths,
    noThemes: true,
    // Keep the first-party compaction/goal/todo implementations in-process while
    // ambient user/plugin extensions stay disabled. Pi owns their lifecycle
    // and custom-entry persistence; Melody still owns session-mode policy.
    extensionFactories,
  });
  await loader.reload();
  instructionScope.seed(loader.getAgentsFiles().agentsFiles);
  return {
    loader,
    activateScopedInstructions: instructionScope.activate,
    refreshPaths: (manifest?: AgentResourceManifest) => {
      if (manifest) {
        const normalized = normalizePiResourcePolicySnapshot(
          cwd,
          manifest,
          process.env,
        );
        skillRootSpecs = normalized.skillRoots;
        promptRootSpecs = normalized.promptRoots;
        applyPolicySnapshot(normalized);
      }
      const nextSkillPaths = piSkillPathsFor(cwd, skillRootSpecs);
      additionalSkillPaths.splice(
        0,
        additionalSkillPaths.length,
        ...nextSkillPaths,
      );
      const nextPromptTemplatePaths = piPromptPathsFor(cwd, promptRootSpecs);
      additionalPromptTemplatePaths.splice(
        0,
        additionalPromptTemplatePaths.length,
        ...nextPromptTemplatePaths,
      );
    },
  };
}
