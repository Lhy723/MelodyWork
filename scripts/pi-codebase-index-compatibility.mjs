import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

/**
 * Compare the manifest codebase-index contract with Host owners and worker
 * routing. The aggregate checker owns repository reads and supplies source
 * snapshots.
 */
export const checkPiCodebaseIndexCompatibility = (policy, sourceSnapshots) => {
  const failures = [];
  if (!policy) return failures;

  const {
    workerToolGateway = "",
    hostCodebaseRuntime = "",
    hostCodebaseParser = "",
    hostCodebaseRequest = "",
    hostCodebaseIndex = "",
    workerRuntime = "",
    workerToolRouting = "",
  } = sourceSnapshots ?? {};

  const tool = policy.tool;
  if (!tool || !workerToolGateway.includes(`"${tool}"`)) {
    failures.push("Host 代码库索引桥接缺少 worker 工具映射。");
  }
  if (
    policy.implementation === "host-tree-sitter" &&
    (!workerToolGateway.includes("codebaseNavigationParameters") ||
      !workerToolGateway.includes("PI_CODEBASE_NAVIGATION") ||
      !hostCodebaseRuntime.includes("codebase_tool_kind"))
  ) {
    failures.push("Pi 代码库索引工具没有实现清单声明的 Host bridge。");
  }
  for (const marker of [
    "MAX_INDEX_PATTERNS",
    "MAX_INDEX_PATTERN_BYTES",
    "codebase_indexing_policy",
    "glob::Pattern",
  ]) {
    if (!hostCodebaseRuntime.includes(marker)) {
      failures.push(`Host 代码库索引桥缺少实现 ${marker}。`);
    }
  }
  for (const marker of [
    "MAX_FILES",
    "MAX_FILE_BYTES",
    "MAX_TOTAL_BYTES",
    "MAX_RESULTS",
    "MAX_INDEX_WORKSPACES",
    "FileFingerprint",
    "CODEBASE_INDEXES",
    "fn refresh",
    "pub(super) fn with_index",
  ]) {
    if (!hostCodebaseIndex.includes(marker)) {
      failures.push(`Host 代码库 index owner 缺少实现 ${marker}。`);
    }
  }
  for (const marker of [
    "parse_source",
    "language_for_path",
    "MAX_SYMBOL_BYTES",
    "MAX_AST_DEPTH",
  ]) {
    if (!hostCodebaseParser.includes(marker)) {
      failures.push(`Host 代码库 parser 缺少实现 ${marker}。`);
    }
  }
  for (const marker of [
    "MAX_POSITION",
    "MAX_QUERY_BYTES",
    "MAX_FILE_PATH_BYTES",
    "canonicalize()",
    "normalize_file_path",
    "starts_with(root)",
    "pub(super) fn parse_request",
  ]) {
    if (!hostCodebaseRequest.includes(marker)) {
      failures.push(`Host 代码库 request owner 缺少实现 ${marker}。`);
    }
  }
  if (
    !hostCodebaseRuntime.includes(
      '#[path = "pi_codebase_runtime/parser.rs"]',
    ) ||
    !hostCodebaseRuntime.includes("mod parser;") ||
    !hostCodebaseIndex.includes("parse_source(") ||
    !hostCodebaseIndex.includes("supports_path(") ||
    !hostCodebaseParser.includes("pub(super) fn parse_source")
  ) {
    failures.push("Host 代码库 parser 没有接入 indexing runtime。");
  }
  if (
    !hostCodebaseRuntime.includes('#[path = "pi_codebase_runtime/index.rs"]') ||
    !hostCodebaseRuntime.includes("mod index;") ||
    !hostCodebaseRuntime.includes("with_index(") ||
    !hostCodebaseIndex.includes("pub(super) fn with_index")
  ) {
    failures.push("Host 代码库 index owner 没有接入 indexing runtime。");
  }
  if (
    !hostCodebaseRuntime.includes(
      '#[path = "pi_codebase_runtime/request.rs"]',
    ) ||
    !hostCodebaseRuntime.includes("mod request;") ||
    !hostCodebaseRuntime.includes("parse_request(root, arguments)") ||
    !hostCodebaseRequest.includes("CodebaseOperation") ||
    !hostCodebaseRequest.includes("ValidatedCodebaseRequest")
  ) {
    failures.push("Host 代码库 request owner 没有接入 indexing runtime。");
  }
  if (
    !workerRuntime.includes("mod host_tool_routing;") ||
    !workerToolRouting.includes("pi_codebase_runtime::resolve_request")
  ) {
    failures.push("Host worker 启动链路没有接入代码库索引桥。");
  }
  for (const [constant, field, label] of [
    ["MAX_INDEX_PATTERNS", "maxPatterns", "代码库索引 glob 数量上限"],
    ["MAX_INDEX_PATTERN_BYTES", "maxPatternBytes", "代码库索引 glob 长度上限"],
  ]) {
    const expected = Number(policy[field]);
    if (!Number.isSafeInteger(expected)) continue;
    const actual = readNumericSourceConstant(hostCodebaseRuntime, constant);
    if (actual !== expected) {
      failures.push(`Host ${label}没有同步兼容清单。`);
    }
  }
  const expectedWorkspaces = Number(policy.maxWorkspaceIndexes);
  if (Number.isSafeInteger(expectedWorkspaces)) {
    const actualWorkspaces = readNumericSourceConstant(
      hostCodebaseIndex,
      "MAX_INDEX_WORKSPACES",
    );
    if (actualWorkspaces !== expectedWorkspaces) {
      failures.push("Host 代码库索引工作区数量上限没有同步兼容清单。");
    }
  }

  return failures;
};
