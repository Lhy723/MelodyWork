import type { MelodyConfigDocument, MelodyExtension } from "@/domain/config";
import {
  inspectPiCapabilityReport,
  type PiCapabilityReport,
} from "@/domain/agent/capability-report";
import {
  listMelodyExtensions,
  listMelodyAgentDefinitions,
  listMelodyHooks,
  listMelodyLspServers,
  listMelodyMcpServers,
  listMelodyPluginCapabilities,
  listMelodySkills,
  readMelodyRuntimeEnvironment,
  readMelodyConfig,
  readWorkspaceSandboxPlan,
} from "./melody-bridge-config";

/**
 * Read the same trusted config/extension inventory shown in Settings and turn
 * it into a deterministic Pi routing decision. No extension code is loaded or
 * executed here; this is only a preflight for choosing the engine.
 */
export const getPiCapabilityReport = async (
  cwd: string,
): Promise<PiCapabilityReport> => {
  const [
    configs,
    mcpServers,
    extensions,
    skills,
    environment,
    agentDefinitions,
    lspServers,
    hooks,
    sandboxPlan,
    plugins,
  ] = await Promise.all([
    Promise.all(
      (["user", "project"] as const).map((scope) =>
        readMelodyConfig(scope, cwd),
      ),
    ),
    listMelodyMcpServers(cwd).catch(
      (
        error,
      ): import("@/domain/agent/capability-report").McpServerSnapshot[] => [
        {
          name: "<unreadable>",
          transport: "unknown",
          supported: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    ),
    listMelodyExtensions(cwd),
    listMelodySkills(cwd),
    readMelodyRuntimeEnvironment(),
    listMelodyAgentDefinitions(cwd),
    listMelodyLspServers(cwd).catch(
      (
        error,
      ): import("@/domain/agent/capability-report").LspServerSnapshot[] => [
        {
          name: "<unreadable>",
          scope: "unknown",
          path: error instanceof Error ? error.message : String(error),
          enabled: true,
          supported: false,
          unsupportedFields: ["config"],
        },
      ],
    ),
    listMelodyHooks(cwd).catch(
      (
        error,
      ): import("@/domain/agent/capability-report").HookDefinitionSnapshot[] => [
        {
          name: "<unreadable>",
          scope: "unknown",
          path: error instanceof Error ? error.message : String(error),
          enabled: true,
          supported: false,
          unsupportedFields: ["config"],
        },
      ],
    ),
    readWorkspaceSandboxPlan(cwd),
    listMelodyPluginCapabilities(cwd).catch(
      (
        error,
      ): import("@/domain/agent/capability-report").PluginCapabilitySnapshot[] => [
        {
          name: "<unreadable>",
          scope: "unknown",
          path: error instanceof Error ? error.message : String(error),
          enabled: true,
          staticResources: false,
          dynamicComponents: ["hostInventory"],
        },
      ],
    ),
  ]);
  const mapExtension = (extension: MelodyExtension) => ({
    kind: extension.kind,
    name: extension.name,
    pluginName: extension.pluginName,
    scope: extension.scope,
    provider: extension.provider,
    path: extension.path,
    enabled: extension.enabled,
  });
  return inspectPiCapabilityReport({
    ...(sandboxPlan ? { sandboxPlan } : {}),
    configs: configs.map((config: MelodyConfigDocument) => ({
      scope: config.scope,
      values: config.values,
      path: config.path,
      parseError: config.parseError,
    })),
    extensions: extensions.map(mapExtension),
    mcpServers,
    skills: skills.map(mapExtension),
    environment,
    agentDefinitions,
    lspServers,
    hooks,
    plugins,
  });
};
