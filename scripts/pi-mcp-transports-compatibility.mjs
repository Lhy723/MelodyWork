const canonicalTransports = ["http", "sse", "stdio"];

const hasRemoteTransportMapping = (source, canonicalName, variant) => {
  const aliases = `"${canonicalName}"(?:\\s*\\|\\s*"[^"]+")*`;
  return new RegExp(
    `${aliases}\\s*=>\\s*\\{?\\s*Some\\(McpTransport::${variant}\\)`,
    "s",
  ).test(source);
};

/**
 * Cross-check the canonical MCP transport contract against Host parsing,
 * runtime wiring, and its local/remote implementation owners.
 */
export const checkPiMcpTransportsCompatibility = ({ transports, sources }) => {
  const failures = [];
  const declared = Array.isArray(transports) ? [...transports].sort() : [];

  if (
    declared.length !== canonicalTransports.length ||
    declared.some(
      (transport, index) => transport !== canonicalTransports[index],
    )
  ) {
    failures.push(
      "MCP transport manifest must declare exactly the canonical transports stdio, http, and sse.",
    );
  }

  const {
    hostMcpRuntime = "",
    hostMcpConfig = "",
    hostStdioTransport = "",
    hostRemoteTransport = "",
  } = sources ?? {};

  const hasCanonicalRemoteMappings =
    hasRemoteTransportMapping(hostMcpConfig, "http", "Http") &&
    hasRemoteTransportMapping(hostMcpConfig, "sse", "Sse");
  if (!hasCanonicalRemoteMappings) {
    failures.push(
      "Host MCP config parser does not map canonical HTTP and SSE transports to their matching remote variants.",
    );
  }

  const normalizesLocalStdio =
    /else if declared_transport\.is_empty\(\)\s*\{\s*"stdio"\.to_string\(\)/s.test(
      hostMcpConfig,
    ) &&
    /matches!\(\s*declared_transport\.as_str\(\),\s*"stdio"\s*\|\s*"local"\s*\)/s.test(
      hostMcpConfig,
    ) &&
    hostMcpConfig.includes("spec: Some(McpServerSpec {");
  if (!normalizesLocalStdio) {
    failures.push(
      "Host MCP config parser does not normalize canonical stdio entries to the local server owner.",
    );
  }

  if (
    !hostMcpRuntime.includes("mod stdio_transport;") ||
    !hostMcpRuntime.includes("mod remote_transport;") ||
    !hostMcpRuntime.includes("use stdio_transport::McpConnection;") ||
    !hostMcpRuntime.includes("use remote_transport::RemoteMcpConnection;") ||
    !hostMcpRuntime.includes("McpConnection::start(spec)?;") ||
    !hostMcpRuntime.includes(
      "RemoteMcpConnection::start(root.to_path_buf(), spec)?;",
    )
  ) {
    failures.push(
      "Host MCP runtime is not wired to both stdio and remote transport owners.",
    );
  }

  if (
    !hostStdioTransport.includes("pub(super) fn start(spec: McpServerSpec)") ||
    !hostStdioTransport.includes("Command::new(&spec.command)")
  ) {
    failures.push(
      "Host MCP stdio owner does not start its configured local command.",
    );
  }

  if (
    !hostRemoteTransport.includes('Self::Http => "http"') ||
    !hostRemoteTransport.includes('Self::Sse => "sse"') ||
    !hostRemoteTransport.includes(
      "pub(super) fn start(root: PathBuf, spec: McpRemoteSpec)",
    ) ||
    !hostRemoteTransport.includes(
      "pub(super) async fn execute_remote_request(",
    ) ||
    !hostRemoteTransport.includes(".execute(request)") ||
    !hostRemoteTransport.includes(
      "execute_remote_request(&self.client, request, request_id, method)",
    ) ||
    !hostRemoteTransport.includes("McpTransport::Sse") ||
    !hostRemoteTransport.includes("bootstrap_sse().await?")
  ) {
    failures.push(
      "Host MCP remote owner does not preserve canonical HTTP and SSE support.",
    );
  }

  return failures;
};
