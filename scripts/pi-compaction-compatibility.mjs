/**
 * Check the worker compaction extension against its manifest contract. The
 * aggregate checker owns repository reads and passes this owner a source
 * snapshot, so the cross-layer contract can be verified with fixtures.
 */
export const checkPiCompactionCompatibility = (contract, compactionSource) => {
  const failures = [];
  if (!contract) return failures;

  const source = compactionSource ?? "";
  const entryPoint = contract.entryPoint || "session_before_compact";
  if (!source.includes(`pi.on("${entryPoint}"`)) {
    failures.push(`worker 压缩扩展没有挂在 Pi 的 ${entryPoint} 上。`);
  }
  if (!source.includes("compact(") || !source.includes("memoryFlushPrompt")) {
    failures.push("worker 压缩扩展丢失了两遍式压缩的某一遍。");
  }

  for (const entry of contract.taskDigest?.sources ?? []) {
    // The digest reads tracker state through the same reconstruction helpers
    // the tools use, so follow each manifest source to its owning extension.
    const owner = entry.replace(/^melody\./, "").replace(/_state$/, "");
    const reconstruct = `reconstruct${owner[0].toUpperCase()}${owner.slice(1)}State`;
    const module = owner === "goal" ? "goal-state" : `${owner}-extension`;
    if (
      !source.includes(`from "./${module}.ts"`) ||
      !source.includes(reconstruct)
    ) {
      failures.push(`worker 压缩摘要没有读取 ${entry}。`);
    }
  }

  // Fail-open is the contract: a broken flush must never strand a session.
  if (!source.includes("compactTaskStateOnly")) {
    failures.push("worker 压缩扩展缺少失败兜底路径。");
  }

  return failures;
};
