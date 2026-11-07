import { useCallback, useEffect, useRef, useState } from "react";

import { toUserMessage } from "@/domain/app-error";
import type { GitChange } from "@/domain/git";
import { RequestGate } from "@/domain/request-gate";
import { getGitChanges } from "@/lib/melody-bridge";

interface UseGitChangesOptions {
  /** Bump to refetch after an external change, e.g. an agent turn settling. */
  revision?: number;
}

export const useGitChanges = (
  cwd: string,
  { revision = 0 }: UseGitChangesOptions = {},
) => {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const gateRef = useRef(new RequestGate());
  const appliedRevisionRef = useRef(revision);

  const refresh = useCallback(async () => {
    const gate = gateRef.current;
    const token = gate.begin();
    setLoading(true);
    setError(undefined);
    try {
      const nextChanges = await getGitChanges(cwd);
      if (gate.isCurrent(token)) {
        setChanges(nextChanges);
      }
    } catch (reason) {
      if (gate.isCurrent(token)) {
        setError(toUserMessage(reason));
      }
    } finally {
      if (gate.isCurrent(token)) {
        setLoading(false);
      }
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (appliedRevisionRef.current === revision) return;
    appliedRevisionRef.current = revision;
    void refresh();
  }, [revision, refresh]);

  return { changes, loading, error, refresh };
};
