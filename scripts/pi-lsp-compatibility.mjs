/**
 * Compare the manifest LSP bridge contract with Host owners and worker routing.
 * The aggregate checker owns repository reads and supplies source snapshots.
 */
export const checkPiLspCompatibility = (policy, sources) => {
  const failures = [];
  if (!policy) return failures;

  const {
    workerToolGateway = "",
    hostLspRuntime = "",
    hostLspConfig = "",
    hostLspProjection = "",
    workerRuntime = "",
    workerToolRouting = "",
  } = sources ?? {};
  for (const tool of policy.tools ?? []) {
    if (!workerToolGateway.includes(`"${tool}"`)) {
      failures.push(`Host LSP 工具桥接缺少工具 ${tool}。`);
    }
  }
  if (
    policy.implementation === "host-lsp-stdio" &&
    (!workerToolGateway.includes("lspParameters") ||
      !workerToolGateway.includes("PI_LSP") ||
      !hostLspRuntime.includes("lsp_tool_kind"))
  ) {
    failures.push("Pi LSP 工具没有实现清单声明的 Host bridge。");
  }
  for (const marker of [
    "list_melody_lsp_servers",
    "load_servers",
    "write_frame",
    "read_frame",
    "LSP_TOOL",
    "MAX_DOCUMENT_BYTES",
  ]) {
    if (!hostLspRuntime.includes(marker)) {
      failures.push(`Host LSP bridge 缺少实现 ${marker}。`);
    }
  }
  for (const marker of [
    "read_config_file",
    "validate_server",
    "CONFIG_MAX_BYTES",
    "MAX_ENV_ENTRIES",
    "projectTrustRequired",
    "canonical_workspace",
    "normalize_file_path",
  ]) {
    if (!hostLspConfig.includes(marker)) {
      failures.push(`Host LSP config owner 缺少实现 ${marker}。`);
    }
  }
  for (const marker of [
    "bounded_text",
    "format_locations",
    "format_symbols",
    "hover_text",
    "MAX_OUTPUT_BYTES",
  ]) {
    if (!hostLspProjection.includes(marker)) {
      failures.push(`Host LSP projection 缺少实现 ${marker}。`);
    }
  }
  if (
    !hostLspRuntime.includes("mod projection;") ||
    !hostLspRuntime.includes("projection::{")
  ) {
    failures.push(
      "Host LSP runtime is not wired to its result projection owner.",
    );
  }
  if (
    !hostLspRuntime.includes("mod lsp_config;") ||
    !hostLspRuntime.includes("lsp_config::{")
  ) {
    failures.push("Host LSP runtime is not wired to its config owner.");
  }
  if (
    !workerRuntime.includes("mod host_tool_routing;") ||
    !workerToolRouting.includes("pi_lsp_runtime::resolve_request")
  ) {
    failures.push("Host worker 启动链路没有接入 LSP bridge。");
  }

  return failures;
};
