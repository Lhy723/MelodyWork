import type {
  AgentPlanStatus,
  JsonRpcId,
  TimelineEntry,
} from "@/domain/acp";

export interface PlanApprovalRequest {
  content: string;
  requestId: JsonRpcId;
  toolCallId: string;
}

export const upsertPlanApproval = (
  timeline: TimelineEntry[],
  request: PlanApprovalRequest,
): TimelineEntry[] => {
  const id = `plan-${request.toolCallId}`;
  const nextTimeline = timeline.map((entry): TimelineEntry =>
    entry.kind === "plan" &&
      entry.status === "awaiting-approval" &&
      entry.id !== id
      ? { ...entry, requestId: undefined, status: "superseded" }
      : entry,
  );
  const index = nextTimeline.findIndex((entry) => entry.id === id);
  const plan: TimelineEntry = {
    id,
    kind: "plan",
    toolCallId: request.toolCallId,
    content: request.content,
    requestId: request.requestId,
    status: "awaiting-approval",
  };
  if (index < 0) {
    return [...nextTimeline, plan];
  }
  return nextTimeline.map((entry, entryIndex) =>
    entryIndex === index ? plan : entry,
  );
};

export const settlePlanApproval = (
  timeline: TimelineEntry[],
  entryId: string,
  status: Exclude<AgentPlanStatus, "streaming" | "awaiting-approval">,
) =>
  timeline.map((entry): TimelineEntry =>
    entry.kind === "plan" && entry.id === entryId
      ? { ...entry, requestId: undefined, status }
      : entry,
  );
