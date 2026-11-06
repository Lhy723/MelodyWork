import { readNumericSourceConstant } from "./source-numeric-constant.mjs";

/**
 * Compare the manifest memory-tool contract with worker schemas, Host routes,
 * the Markdown-backed store, its optional lexical sidecar, and worker lifecycle
 * wiring. The aggregate checker supplies source snapshots and owns file reads.
 */
export const checkPiMemoryToolsCompatibility = ({ policy, sources }) => {
  const failures = [];
  if (!policy) return failures;

  const {
    workerToolGateway = "",
    hostToolGateway = "",
    hostMemoryRuntime = "",
    hostMemoryStore = "",
    hostMemorySearchIndex = "",
    hostConfigRuntime = "",
    hostWorkerRuntime = "",
    workerMemoryLifecycle = "",
  } = sources ?? {};

  for (const tool of policy.tools ?? []) {
    if (!workerToolGateway.includes(`"${tool}"`)) {
      failures.push(`Host memory 工具桥接缺少工具 ${tool}。`);
    }
  }

  if (
    policy.implementation === "host-memory-gateway" &&
    (!workerToolGateway.includes("memorySearchParameters") ||
      !workerToolGateway.includes("memoryGetParameters") ||
      !workerToolGateway.includes("memoryRememberParameters") ||
      !hostToolGateway.includes("MEMORY_SEARCH") ||
      !hostToolGateway.includes("MEMORY_GET") ||
      !hostToolGateway.includes("MEMORY_REMEMBER"))
  ) {
    failures.push("Pi memory 工具没有实现清单声明的 Host bridge。 ");
  }

  if (policy.implementation === "host-memory-gateway") {
    const bounds = [
      ["maxQueryBytes", "MAX_QUERY_BYTES"],
      ["maxFileBytes", "MAX_FILE_BYTES"],
      ["maxTotalBytes", "MAX_TOTAL_BYTES"],
      ["maxFiles", "MAX_FILES"],
      ["maxOutputBytes", "MAX_OUTPUT_BYTES"],
      ["maxNoteBytes", "MAX_MEMORY_NOTE_BYTES"],
    ];
    for (const [field, constant] of bounds) {
      const manifestLimit = policy[field];
      if (
        !Number.isSafeInteger(manifestLimit) ||
        readNumericSourceConstant(hostMemoryStore, constant) !== manifestLimit
      ) {
        failures.push(
          `Host memory ${field} limit does not match the manifest.`,
        );
      }
    }
  }

  for (const marker of [
    "resolve_request",
    "initial_injection",
    "save_session_transcript",
  ]) {
    if (!hostMemoryRuntime.includes(marker)) {
      failures.push(`Host memory bridge 缺少实现 ${marker}。`);
    }
  }
  for (const marker of ["rank_chunks", "memory_remember", "TextFileStore"]) {
    if (!hostMemoryStore.includes(marker)) {
      failures.push(`Host memory store 缺少实现 ${marker}。`);
    }
  }
  if (
    !hostMemoryRuntime.includes('#[path = "pi_memory_runtime/store.rs"]') ||
    !hostMemoryRuntime.includes("store::memory_search") ||
    !hostMemoryRuntime.includes("store::initial_memory_search") ||
    !hostMemoryStore.includes('#[path = "store/search_index.rs"]') ||
    !hostMemoryStore.includes("mod search_index;")
  ) {
    failures.push("Host memory store is not wired to the Pi memory runtime.");
  }

  const persistentIndex = policy.persistentIndex;
  if (persistentIndex?.implementation === "host-sqlite-lexical") {
    const memoryIndexRuntime = [
      hostMemoryRuntime,
      hostMemoryStore,
      hostMemorySearchIndex,
    ].join("\n");
    for (const marker of [
      "MemoryIndexSummary",
      "MEMORY_INDEX_SCHEMA_VERSION",
      "sync_memory_index_path",
      "memory_index_digest",
      "pi_memory_chunks",
      "rebuild_memory_index",
    ]) {
      if (!memoryIndexRuntime.includes(marker)) {
        failures.push(`Host memory lexical index 缺少实现 ${marker}。`);
      }
    }
    if (!hostConfigRuntime.includes(persistentIndex.rebuildCommand)) {
      failures.push("Host memory lexical index 缺少显式重建命令。");
    }
    if (!hostMemorySearchIndex.includes(persistentIndex.file)) {
      failures.push("Host memory lexical index 没有绑定 index.sqlite 侧车。");
    }
    if (
      !hostMemoryStore.includes("search_chunks") ||
      !hostMemorySearchIndex.includes("pub(super) fn search_chunks")
    ) {
      failures.push(
        "Host memory search is not wired to the disposable Markdown-derived index.",
      );
    }
  }

  if (
    !hostWorkerRuntime.includes("mod memory_lifecycle;") ||
    !hostWorkerRuntime.includes("HostMemoryLifecycle")
  ) {
    failures.push(
      "Pi worker supervisor is not wired to its memory-lifecycle module.",
    );
  }
  for (const marker of [
    "maybe_inject(",
    "observe_event(",
    "flush_transcripts(",
  ]) {
    if (!workerMemoryLifecycle.includes(marker)) {
      failures.push(`Host worker memory lifecycle module lacks ${marker}.`);
    }
  }

  return failures;
};
