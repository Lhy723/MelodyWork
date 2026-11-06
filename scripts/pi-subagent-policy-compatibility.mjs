import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

const capabilityModes = [
  "read-only",
  "read-write",
  "execute",
  "read-write-execute",
];

/**
 * Compare the declarative subagent policy contract across Host projection,
 * worker normalization, and the exact call-time MCP grant gate. Source
 * snapshots keep this owner fixture-testable while the aggregate checker
 * remains responsible for file I/O and diagnostic aggregation.
 */
export const checkPiSubagentPolicyCompatibility = ({ policy, sources }) => {
  const failures = [];
  if (!policy) return failures;

  const {
    hostSubagentParser = "",
    hostSubagentConfig = "",
    workerSessionAdapter = "",
    workerPolicy = "",
    workerToolGateway = "",
    workerToolAccessPolicy = "",
  } = sources ?? {};

  const grants = policy.mcpToolGrants;
  if (grants) {
    if (
      grants.field !== "mcpTools" ||
      !hostSubagentParser.includes("fn valid_mcp_tool_name") ||
      !hostSubagentConfig.includes("mcpTools") ||
      !workerSessionAdapter.includes("mcpTools") ||
      !workerPolicy.includes("mcpTools")
    ) {
      failures.push("MCP 工具授权没有在 Host 与 worker 之间同步。");
    }

    const bounds = [
      [
        hostSubagentParser,
        "MAX_MCP_TOOL_GRANTS",
        grants.maxTools,
        "Host MCP 授权数量",
      ],
      [workerPolicy, "MAX_MCP_TOOLS", grants.maxTools, "worker MCP 授权数量"],
      [
        hostSubagentParser,
        "MAX_MCP_SERVER_NAME_BYTES",
        grants.maxServerBytes,
        "Host MCP server 名称",
      ],
      [
        workerPolicy,
        "MAX_MCP_SERVER_NAME_LENGTH",
        grants.maxServerBytes,
        "worker MCP server 名称",
      ],
      [
        hostSubagentParser,
        "MAX_MCP_TOOL_NAME_BYTES",
        grants.maxToolBytes,
        "Host MCP tool 名称",
      ],
      [
        workerPolicy,
        "MAX_MCP_TOOL_NAME_LENGTH",
        grants.maxToolBytes,
        "worker MCP tool 名称",
      ],
      [
        hostSubagentParser,
        "MAX_MCP_FULL_NAME_BYTES",
        grants.maxNameBytes,
        "Host MCP 全名",
      ],
      [
        workerPolicy,
        "MAX_MCP_NAME_LENGTH",
        grants.maxNameBytes,
        "worker MCP 全名",
      ],
    ];
    for (const [source, constant, expected, label] of bounds) {
      if (
        !Number.isSafeInteger(expected) ||
        readNumericSourceConstant(source, constant) !== expected
      ) {
        failures.push(`${label}上限没有同步兼容清单。`);
      }
    }

    if (
      !hostSubagentParser.includes(
        'character.is_ascii_alphanumeric() || "_.-".contains(character)',
      )
    ) {
      failures.push("Host MCP 名称字符集没有同步 worker 校验。");
    }
    if (
      !workerPolicy.includes("const MCP_TOOL_PATTERN = new RegExp(") ||
      !workerPolicy.includes("[A-Za-z0-9_.-]") ||
      !workerPolicy.includes("${MAX_MCP_SERVER_NAME_LENGTH}") ||
      !workerPolicy.includes("${MAX_MCP_TOOL_NAME_LENGTH}")
    ) {
      failures.push("worker MCP 名称格式没有与 Host 校验保持同步。");
    }
    if (
      !hostSubagentParser.includes("value.len() <= MAX_MCP_FULL_NAME_BYTES") ||
      !hostSubagentParser.includes(
        "bounded(server, MAX_MCP_SERVER_NAME_BYTES)",
      ) ||
      !hostSubagentParser.includes("bounded(tool, MAX_MCP_TOOL_NAME_BYTES)")
    ) {
      failures.push("Host MCP 全名校验没有使用兼容清单上限。");
    }
    if (!workerPolicy.includes("name.length > MAX_MCP_NAME_LENGTH")) {
      failures.push("worker MCP 全名校验没有使用兼容清单上限。");
    }
    if (!workerToolGateway.includes("mcp__${server}__${tool}")) {
      failures.push("worker 没有按 mcp__<server>__<tool> 校验 MCP 授权。");
    }
  }

  if (policy.toolAllowlistMapping) {
    if (
      !hostSubagentConfig.includes('#[path = "config_subagent_markdown.rs"]') ||
      !hostSubagentConfig.includes("mod subagent_markdown;") ||
      !hostSubagentParser.includes("fn apply_agent_tool_ceiling")
    ) {
      failures.push("Host 没有把工具白名单换算为 Pi 能力档。");
    }
    for (const mode of capabilityModes) {
      if (
        !(mode in policy.toolAllowlistMapping) ||
        !hostSubagentParser.includes(`"${mode}"`) ||
        !workerToolAccessPolicy.includes(`"${mode}"`)
      ) {
        failures.push(`Host/worker 能力档 ${mode} 没有同步。`);
      }
    }
  }

  return failures;
};
