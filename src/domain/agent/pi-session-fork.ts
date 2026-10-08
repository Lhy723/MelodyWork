export interface PiSessionFork {
  branchSessionId: string;
  sourceSessionId: string;
  anchorNativeEntryId: string;
  status: "pending" | "ready" | "failed";
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}
