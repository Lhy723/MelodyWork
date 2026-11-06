import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

/**
 * Compare the manifest web-tool contract with worker schemas, Host routing,
 * and Host-side request/response safety markers. The aggregate compatibility
 * checker supplies source snapshots and owns repository file reads.
 */
export const checkPiWebToolsCompatibility = ({ policy, sources }) => {
  const failures = [];
  if (!policy) return failures;

  const {
    workerToolGateway = "",
    hostToolGateway = "",
    hostWebRuntime = "",
  } = sources ?? {};

  for (const tool of policy.tools ?? []) {
    if (!workerToolGateway.includes(`"${tool}"`)) {
      failures.push(`Host web 工具桥接缺少工具 ${tool}。`);
    }
  }

  if (
    policy.implementation === "host-tool-gateway" &&
    (!workerToolGateway.includes("webSearchParameters") ||
      !workerToolGateway.includes("webFetchParameters") ||
      !hostToolGateway.includes("WEB_SEARCH") ||
      !hostToolGateway.includes("WEB_FETCH"))
  ) {
    failures.push("Pi web 工具没有实现清单声明的 Host bridge。 ");
  }

  for (const marker of [
    "resolve_request",
    "read_bounded_body",
    "public_https_url",
    "format_search_output",
  ]) {
    if (!hostWebRuntime.includes(marker)) {
      failures.push(`Host web bridge 缺少安全边界实现 ${marker}。`);
    }
  }

  if (policy.implementation === "host-tool-gateway") {
    const bounds = [
      ["maxQueryBytes", "MAX_QUERY_BYTES"],
      ["maxUrlBytes", "MAX_URL_BYTES"],
      ["maxResponseBytes", "MAX_RESPONSE_BYTES"],
      ["maxFetchedTextBytes", "MAX_SEARCH_OUTPUT_BYTES"],
    ];
    for (const [field, constant] of bounds) {
      const manifestLimit = policy[field];
      if (
        !Number.isSafeInteger(manifestLimit) ||
        readNumericSourceConstant(hostWebRuntime, constant) !== manifestLimit
      ) {
        failures.push(`Host web ${field} limit does not match the manifest.`);
      }
    }
  }

  return failures;
};
