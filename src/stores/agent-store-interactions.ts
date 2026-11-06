import { toUserMessage as reasonMessage } from "@/domain/app-error";
import type { JsonObject } from "@/domain/agent/contract";
import { settlePlanApproval } from "@/domain/plan-approval";
import { sendAgentCommand } from "@/lib/agent-client";
import { isTauriRuntime, upsertPermissionRule } from "@/lib/melody-bridge";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { permissionToolKey, updateQuestionEntry } from "./agent-store-parsing";
import type { AgentStore, AgentStoreAccess } from "./agent-store-types";

/** Resolve user-facing plan, permission and question interactions for a session. */
export const resolveAgentPlan = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["resolvePlan"]>
) => {
  const [entryId, outcome, feedback] = args;
  const { get, set } = store;
  const entry = get().timeline.find((item) => item.id === entryId);
  if (
    entry?.kind !== "plan" ||
    entry.status !== "awaiting-approval" ||
    entry.requestId === undefined
  ) {
    return;
  }
  const normalizedFeedback = feedback?.trim();
  if (outcome === "cancelled" && !normalizedFeedback) {
    return;
  }
  const settledStatus =
    outcome === "approved"
      ? "approved"
      : outcome === "abandoned"
        ? "abandoned"
        : "changes-requested";
  set((state) => ({
    timeline: settlePlanApproval(state.timeline, entryId, settledStatus),
  }));

  if (!isTauriRuntime()) {
    return;
  }
  try {
    const sessionId = get().runtimeSessionId;
    if (!sessionId) {
      return;
    }
    await sendAgentCommand({
      protocolVersion: 1,
      requestId: entry.requestId,
      sessionId,
      command: {
        type: "interaction.resolve",
        sessionId,
        interactionId: String(entry.requestId),
        resolution: {
          outcome,
          ...(normalizedFeedback ? { feedback: normalizedFeedback } : {}),
        },
      },
    });
  } catch (reason) {
    set((state) => ({
      timeline: state.timeline.map((item) =>
        item.kind === "plan" && item.id === entryId
          ? {
              ...item,
              requestId: entry.requestId,
              status: "awaiting-approval",
            }
          : item,
      ),
      status: {
        ...state.status,
        message: reasonMessage(reason),
      },
    }));
    throw reason;
  }
};

/** Resolve a permission interaction, including Host-persisted project rules. */
export const resolveAgentPermission = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["resolvePermission"]>
) => {
  const [entryId, optionId] = args;
  const { get, set } = store;
  const state = get();
  let entry = state.timeline.find((item) => item.id === entryId);
  let backgroundSessionId: string | undefined;
  if (!entry) {
    for (const [sessionId, timeline] of Object.entries(
      state.backgroundTimelines,
    )) {
      const candidate = timeline.find((item) => item.id === entryId);
      if (candidate) {
        entry = candidate;
        backgroundSessionId = sessionId;
        break;
      }
    }
  }
  if (entry?.kind !== "tool" || entry.permissionRequestId === undefined) {
    return;
  }
  const projectDecision = optionId.startsWith("project:")
    ? (optionId.slice("project:".length) as "allow" | "deny")
    : undefined;
  const option = projectDecision
    ? entry.permissionOptions?.find((item) =>
        projectDecision === "deny"
          ? item.kind.startsWith("reject")
          : item.kind.startsWith("allow"),
      )
    : entry.permissionOptions?.find((item) => item.optionId === optionId);
  if (!option) {
    return;
  }
  const permission = option.kind.startsWith("reject") ? "denied" : "allowed";

  if (projectDecision) {
    const projectId = useWorkspaceStore.getState().activeProject?.id;
    if (projectId) {
      await upsertPermissionRule({
        projectId,
        toolKey: permissionToolKey(entry.title, entry.command),
        title: entry.title,
        command: entry.command,
        decision: projectDecision,
      });
    }
  }

  set((current) =>
    backgroundSessionId
      ? {
          backgroundTimelines: {
            ...current.backgroundTimelines,
            [backgroundSessionId]: current.backgroundTimelines[
              backgroundSessionId
            ].map((item) =>
              item.id === entryId ? { ...item, permission } : item,
            ),
          },
        }
      : {
          timeline: current.timeline.map((item) =>
            item.id === entryId ? { ...item, permission } : item,
          ),
        },
  );

  if (!isTauriRuntime()) {
    return;
  }
  // Pi child interactions are stored in a background timeline, but the
  // ToolGateway also accepts the root product session as the authorization
  // identity. Keep the command on that root instead of sending a child
  // stream id that may not have a product binding of its own.
  const sessionId = get().runtimeSessionId;
  if (!sessionId) {
    return;
  }
  await sendAgentCommand({
    protocolVersion: 1,
    requestId: entry.permissionRequestId,
    sessionId,
    command: {
      type: "interaction.resolve",
      sessionId,
      interactionId: String(entry.permissionRequestId),
      resolution: {
        outcome: {
          outcome: "selected",
          optionId: option.optionId,
        },
      },
    },
  });
};

/** Resolve a pending question and update its root or background timeline. */
export const resolveAgentQuestion = async (
  store: AgentStoreAccess,
  ...args: Parameters<AgentStore["resolveQuestion"]>
) => {
  const [entryId, response] = args;
  const { get, set } = store;
  const state = get();
  let entry = state.timeline.find((item) => item.id === entryId);
  let backgroundSessionId: string | undefined;
  if (!entry) {
    for (const [sessionId, timeline] of Object.entries(
      state.backgroundTimelines,
    )) {
      const candidate = timeline.find((item) => item.id === entryId);
      if (candidate) {
        entry = candidate;
        backgroundSessionId = sessionId;
        break;
      }
    }
  }
  if (
    entry?.kind !== "tool" ||
    !entry.question ||
    entry.question.outcome !== "pending"
  ) {
    return;
  }
  const requestId = entry.question.requestId;
  const wireResponse = (response.outcome === "chat_about_this" ||
  response.outcome === "skip_interview"
    ? {
        outcome: response.outcome,
        partial_answers: response.partialAnswers,
      }
    : response) as unknown as JsonObject;
  try {
    const sessionId = entry.question.sessionId || backgroundSessionId;
    if (!sessionId) {
      return;
    }
    await sendAgentCommand({
      protocolVersion: 1,
      requestId,
      sessionId,
      command: {
        type: "interaction.resolve",
        sessionId,
        interactionId: String(requestId),
        resolution: wireResponse,
      },
    });
  } catch (reason) {
    set({
      status: { ...get().status, message: reasonMessage(reason) },
    });
    throw reason;
  }
  set((current) =>
    backgroundSessionId
      ? {
          backgroundTimelines: {
            ...current.backgroundTimelines,
            [backgroundSessionId]: updateQuestionEntry(
              current.backgroundTimelines[backgroundSessionId] ?? [],
              entryId,
              response,
            ),
          },
        }
      : {
          timeline: updateQuestionEntry(current.timeline, entryId, response),
        },
  );
};
