import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type PiForkTargetManager = Pick<
  ReturnType<typeof SessionManager.open>,
  "getHeader" | "getLeafId" | "getEntry"
>;

/**
 * Derive a stable, opaque native-session filename from the product identity.
 *
 * Product IDs are intentionally not used as filenames: they may contain
 * characters meaningful to a filesystem and may reveal project/session
 * metadata in a diagnostic path. Including cwd prevents a product ID reused
 * under another workspace from joining native histories.
 */
export const piSessionFileFor = (
  sessionRoot: string,
  cwd: string,
  productSessionId: string,
): string => {
  const key = createHash("sha256")
    .update(cwd)
    .update("\0")
    .update(productSessionId)
    .digest("hex");
  return join(sessionRoot, `session-${key}.jsonl`);
};

/** Confirm that a persisted fork still belongs to its recorded source anchor. */
export const piForkTargetMatches = (
  targetManager: PiForkTargetManager,
  sourcePath: string,
  anchorEntryId: string,
): boolean => {
  const header = targetManager.getHeader();
  return (
    header?.parentSession === sourcePath &&
    targetManager.getLeafId() === anchorEntryId &&
    Boolean(targetManager.getEntry(anchorEntryId))
  );
};
