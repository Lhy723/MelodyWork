/**
 * Cross-check the Host-owned MCP inventory contract across the Tauri command,
 * renderer preflight, and capability report. The caller owns source loading;
 * this module remains a deterministic check over the manifest and snapshots.
 */
export const checkPiMcpInventoryCompatibility = ({
  inventory,
  sources,
} = {}) => {
  const failures = [];
  const { command, owner, validationAuthority } = inventory ?? {};

  if (
    typeof command !== "string" ||
    !/^[a-z_][a-z0-9_]*$/.test(command) ||
    typeof owner !== "string" ||
    !/^[a-z_][a-z0-9_]*::[a-z_][a-z0-9_]*$/.test(owner) ||
    validationAuthority !== "Host"
  ) {
    return ["Pi MCP inventory compatibility contract is malformed."];
  }

  const [ownerModule, ownerFunction] = owner.split("::");
  const snapshot = (name) =>
    typeof sources?.[name] === "string" ? sources[name] : "";
  const hostMcpRuntime = snapshot("hostMcpRuntime");
  const hostMcpConfig = snapshot("hostMcpConfig");
  const hostConfigRuntime = snapshot("hostConfigRuntime");
  const hostTauriCommands = snapshot("hostTauriCommands");
  const tauriPermissions = snapshot("tauriPermissions");
  const rendererBridge = snapshot("rendererBridge");
  const rendererPreflight = snapshot("rendererPreflight");
  const capabilityReport = snapshot("capabilityReport");
  const hostOwnerExport = new RegExp(
    `pub\\(crate\\)\\s+use\\s+mcp_config::\\{[^}]*\\b${ownerFunction}\\b[^}]*\\}`,
  ).test(hostMcpRuntime);
  const hostCommandBody =
    hostConfigRuntime.match(
      new RegExp(
        `pub\\s+fn\\s+${command}\\s*\\([^]*?\\)\\s*(?:->[^{}]*)?\\{([^{}]*)\\}`,
      ),
    )?.[1] ?? "";
  const authorizationIndex = hostCommandBody.indexOf(
    "registry.authorize(&cwd)?",
  );
  const ownerCallIndex = hostCommandBody.indexOf(
    `crate::${ownerModule}::${ownerFunction}(&cwd)`,
  );

  if (
    !hostMcpRuntime.includes("mod mcp_config;") ||
    !hostOwnerExport ||
    !hostMcpConfig.includes(`pub(crate) fn ${ownerFunction}`) ||
    !hostMcpConfig.includes("fn parse_server_entry")
  ) {
    failures.push(
      `Host MCP inventory is not owned by the configured module ${owner}.`,
    );
  }

  if (
    authorizationIndex < 0 ||
    ownerCallIndex <= authorizationIndex ||
    !hostTauriCommands.includes(`config_runtime::${command}`) ||
    !tauriPermissions.includes(`${JSON.stringify(command)}`)
  ) {
    failures.push(
      `Host MCP inventory command ${command} is not authorized and registered end to end.`,
    );
  }

  if (
    !rendererBridge.includes(JSON.stringify(command)) ||
    !rendererBridge.includes("listMelodyMcpServers") ||
    !rendererPreflight.includes("listMelodyMcpServers(cwd)") ||
    !rendererPreflight.includes("mcpServers,")
  ) {
    failures.push(
      "Pi preflight is not wired to the Host-validated MCP inventory.",
    );
  }

  if (
    !capabilityReport.includes("mcpServers: McpServerSnapshot[]") ||
    !capabilityReport.includes(
      "input.mcpServers.filter((server) => !server.supported)",
    ) ||
    capabilityReport.includes("mcpEntrySupported") ||
    capabilityReport.includes("collectMcpEntries")
  ) {
    failures.push(
      "Pi capability reporting must use Host MCP support status without a duplicate renderer parser.",
    );
  }

  return failures;
};
