/**
 * Compare the contract tool-name table with the Rust Host routing constants.
 *
 * Rust cannot import the TypeScript contract, so the aggregate checker supplies
 * source snapshots and this module owns the one cross-language agreement:
 *
 * 1. every advertised name has a Rust constant, except the worker-owned ones;
 * 2. every internal bridge name has a Rust constant;
 * 3. no Rust constant holds a value outside the contract table;
 * 4. worker-owned names never appear in the Host routing policy;
 * 5. the manifest advertises exactly the contract's advertised names.
 */
const rustConstantPattern = /pub\(crate\) const [A-Z_]+: &str = "([^"]+)";/gu;

export const rustToolNameValues = (source) => {
  const values = new Set();
  for (const match of (source ?? "").matchAll(rustConstantPattern)) {
    values.add(match[1]);
  }
  return values;
};

export const checkPiToolNamesCompatibility = ({
  contract,
  requestPolicy = "",
  codebaseRuntime = "",
  lspRuntime = "",
  manifestTools = [],
}) => {
  const failures = [];
  if (!contract) return failures;

  const advertised = contract.AGENT_TOOL_NAMES ?? [];
  const internal = contract.AGENT_INTERNAL_TOOL_NAMES ?? [];
  const workerOwned = contract.AGENT_WORKER_OWNED_TOOL_NAMES ?? [];
  const routedByOtherModules = new Set(["codebase_navigation", "lsp"]);

  const requestPolicyValues = rustToolNameValues(requestPolicy);
  const otherModuleValues = new Set([
    ...rustToolNameValues(codebaseRuntime),
    ...rustToolNameValues(lspRuntime),
  ]);

  for (const name of advertised) {
    if (workerOwned.includes(name)) continue;
    if (routedByOtherModules.has(name)) {
      if (!otherModuleValues.has(name)) {
        failures.push(`契约工具 ${name} 在其 Host 模块中没有常量。`);
      }
      continue;
    }
    if (!requestPolicyValues.has(name)) {
      failures.push(`契约工具 ${name} 在 Host 路由策略中没有常量。`);
    }
  }

  for (const name of internal) {
    if (!requestPolicyValues.has(name)) {
      failures.push(`内部工具 ${name} 在 Host 路由策略中没有常量。`);
    }
  }

  const contractValues = new Set([...advertised, ...internal]);
  for (const value of requestPolicyValues) {
    if (!contractValues.has(value)) {
      failures.push(`Host 路由策略包含契约外的工具 ${value}。`);
    }
  }

  for (const name of workerOwned) {
    if (requestPolicyValues.has(name)) {
      failures.push(`Host 路由策略不应包含 worker 自有的工具 ${name}。`);
    }
  }

  const advertisedSet = new Set(advertised);
  for (const name of manifestTools) {
    if (!advertisedSet.has(name)) {
      failures.push(`兼容清单声明了契约外的工具 ${name}。`);
    }
  }
  for (const name of advertised) {
    if (!manifestTools.includes(name)) {
      failures.push(`兼容清单缺少契约工具 ${name}。`);
    }
  }

  return failures;
};
