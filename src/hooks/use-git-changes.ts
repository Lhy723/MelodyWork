import { useCallback, useEffect, useState } from "react";

import type { GitChange } from "@/domain/git";
import { getGitChanges } from "@/lib/melody-bridge";

export const useGitChanges = (cwd: string) => {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setChanges(await getGitChanges(cwd));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { changes, loading, error, refresh };
};
