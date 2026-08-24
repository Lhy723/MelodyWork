import { useCallback, useEffect, useRef, useState } from "react";

import { toUserMessage } from "@/domain/app-error";
import { RequestGate } from "@/domain/request-gate";

export type AsyncOperationPhase = "idle" | "pending" | "success" | "error";

export interface AsyncOperationState {
  phase: AsyncOperationPhase;
  error?: string;
}

/**
 * Keeps loading/error state and the latest-request rule together. A stale
 * result can still finish at the transport layer, but it cannot commit UI
 * data or replace the current error.
 */
export const useAsyncOperation = () => {
  const gateRef = useRef(new RequestGate());
  const [state, setState] = useState<AsyncOperationState>({ phase: "idle" });

  const run = useCallback(
    async <T>(task: () => Promise<T>, apply?: (value: T) => void) => {
      const gate = gateRef.current;
      const token = gate.begin();
      setState({ phase: "pending" });
      try {
        const value = await task();
        if (gate.isCurrent(token)) {
          setState({ phase: "success" });
          apply?.(value);
        }
        return value;
      } catch (reason) {
        if (gate.isCurrent(token)) {
          setState({ phase: "error", error: toUserMessage(reason) });
        }
        throw reason;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    gateRef.current.invalidate();
    setState({ phase: "idle" });
  }, []);

  useEffect(() => () => gateRef.current.invalidate(), []);

  return { state, run, reset };
};
