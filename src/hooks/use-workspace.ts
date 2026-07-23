import { useEffect } from "react";

import { useWorkspaceStore } from "@/stores/workspace-store";

export const useWorkspace = () => {
  const initialize = useWorkspaceStore((state) => state.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);
};
