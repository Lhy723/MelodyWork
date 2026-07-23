import { create } from "zustand";

import type {
  AcpEnvelope,
  AcpSessionPhase,
  AgentStatus,
  PermissionOption,
  TimelineEntry,
} from "@/domain/acp";
import {
  findPermissionRule,
  isTauriRuntime,
  sendAcp,
  updateStoredSession,
  upsertPermissionRule,
} from "@/lib/melody-bridge";
import { useWorkspaceStore } from "@/stores/workspace-store";

const INITIALIZE_REQUEST_ID = 1;
const NEW_SESSION_REQUEST_ID = 2;
let nextPromptRequestId = 100;

const previewTimeline: TimelineEntry[] = [
  {
    id: "user-1",
    kind: "message",
    role: "user",
    content:
      "Connect MelodyWork to the bundled Melody Build agent over ACP stdio.",
  },
  {
    id: "assistant-1",
    kind: "message",
    role: "assistant",
    content:
      "I’ll verify the desktop bridge, initialize an ACP session, and keep the UI synchronized with tool and permission events.",
  },
  {
    id: "tool-1",
    kind: "tool",
    toolCallId: "preview-check",
    title: "Run frontend checks",
    command: "pnpm check",
    output:
      "> melody-work@0.1.0 check\n> tsc --noEmit\n\nWaiting for permission to run this command.",
    status: "pending",
    permission: "pending",
    permissionRequestId: "preview-permission",
    permissionOptions: [
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "always-allow",
        name: "Allow for session",
        kind: "allow_always",
      },
    ],
  },
];

interface AgentStore {
  activeSessionId: string;
  localSessionId?: string;
  cwd: string;
  status: AgentStatus;
  acpPhase: AcpSessionPhase;
  acpSessionId?: string;
  timeline: TimelineEntry[];
  stderr: string[];
  chatStatus: "ready" | "submitted" | "streaming" | "error";
  setStatus: (status: AgentStatus) => void;
  appendStderr: (line: string) => void;
  beginSession: (
    cwd: string,
    localSessionId: string,
    acpSessionId?: string,
    timelineJson?: string,
  ) => Promise<void>;
  receiveAcp: (message: AcpEnvelope) => Promise<void>;
  submitPrompt: (content: string) => Promise<void>;
  resolvePermission: (entryId: string, optionId: string) => Promise<void>;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const stringifyValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value, null, 2);
};

const toolCommand = (tool: Record<string, unknown>): string => {
  const rawInput = objectValue(tool.rawInput);
  return (
    stringValue(rawInput?.command) ??
    stringValue(rawInput?.cmd) ??
    stringValue(rawInput?.path) ??
    stringifyValue(tool.rawInput)
  );
};

const toolOutput = (tool: Record<string, unknown>): string => {
  const content = Array.isArray(tool.content) ? tool.content : [];
  const contentText = content
    .map((item) => {
      const block = objectValue(item);
      return (
        stringValue(block?.text) ??
        stringifyValue(block?.content) ??
        stringifyValue(item)
      );
    })
    .filter(Boolean)
    .join("\n");
  return contentText || stringifyValue(tool.rawOutput);
};

const permissionToolKey = (title: string, command: string) =>
  `${title.trim()}\n${command.trim()}`;

const appendAgentChunk = (
  timeline: TimelineEntry[],
  text: string,
): TimelineEntry[] => {
  const last = timeline.at(-1);
  if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
    return [
      ...timeline.slice(0, -1),
      { ...last, content: `${last.content}${text}` },
    ];
  }
  return [
    ...timeline,
    {
      id: `assistant-${Date.now()}`,
      kind: "message",
      role: "assistant",
      content: text,
      streaming: true,
    },
  ];
};

const upsertTool = (
  timeline: TimelineEntry[],
  tool: Record<string, unknown>,
): TimelineEntry[] => {
  const toolCallId =
    stringValue(tool.toolCallId) ?? `tool-${Date.now().toString(36)}`;
  const index = timeline.findIndex(
    (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
  );
  const existing = index >= 0 ? timeline[index] : undefined;
  const next: TimelineEntry = {
    id: existing?.id ?? `tool-${toolCallId}`,
    kind: "tool",
    toolCallId,
    title:
      stringValue(tool.title) ??
      (existing?.kind === "tool" ? existing.title : "Tool call"),
    command:
      toolCommand(tool) ||
      (existing?.kind === "tool" ? existing.command : ""),
    output:
      toolOutput(tool) ||
      (existing?.kind === "tool" ? existing.output : ""),
    status:
      stringValue(tool.status) ??
      (existing?.kind === "tool" ? existing.status : undefined),
    permission:
      existing?.kind === "tool" ? existing.permission : undefined,
    permissionRequestId:
      existing?.kind === "tool" ? existing.permissionRequestId : undefined,
    permissionOptions:
      existing?.kind === "tool" ? existing.permissionOptions : undefined,
  };

  if (index < 0) {
    return [...timeline, next];
  }
  return timeline.map((entry, entryIndex) =>
    entryIndex === index ? next : entry,
  );
};

const parsePermissionOptions = (value: unknown): PermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((option) => {
        const item = objectValue(option);
        const optionId = stringValue(item?.optionId);
        const name = stringValue(item?.name);
        const kind = stringValue(item?.kind) as PermissionOption["kind"];
        return optionId && name && kind
          ? [{ optionId, name, kind }]
          : [];
      })
    : [];

const errorMessage = (message: AcpEnvelope, fallback: string) =>
  message.error?.message ?? fallback;

const parseTimeline = (timelineJson?: string): TimelineEntry[] => {
  if (!timelineJson) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(timelineJson);
    return Array.isArray(value) ? (value as TimelineEntry[]) : [];
  } catch {
    return [];
  }
};

const sendSessionOpen = async (
  cwd: string,
  acpSessionId?: string,
) => {
  await sendAcp({
    jsonrpc: "2.0",
    id: NEW_SESSION_REQUEST_ID,
    method: acpSessionId ? "session/load" : "session/new",
    params: acpSessionId
      ? { sessionId: acpSessionId, cwd, mcpServers: [] }
      : { cwd, mcpServers: [] },
  });
};

export const useAgentStore = create<AgentStore>((set, get) => ({
  activeSessionId: "implement-acp-bridge",
  cwd: ".",
  status: {
    phase: "stopped",
    message: "Starting desktop bridge…",
  },
  acpPhase: "idle",
  timeline: previewTimeline,
  stderr: [],
  chatStatus: "ready",
  setStatus: (status) =>
    set({
      status,
      ...(status.phase === "missing" || status.phase === "failed"
        ? { chatStatus: "error" as const, acpPhase: "error" as const }
        : {}),
    }),
  appendStderr: (line) =>
    set((state) => ({ stderr: [...state.stderr.slice(-49), line] })),
  beginSession: async (
    cwd,
    localSessionId,
    acpSessionId,
    timelineJson,
  ) => {
    const restoredTimeline = parseTimeline(timelineJson);
    if (!isTauriRuntime()) {
      set({
        activeSessionId: localSessionId,
        localSessionId,
        cwd,
        acpSessionId,
        acpPhase: "ready",
        timeline:
          localSessionId === "implement-acp-bridge" && restoredTimeline.length === 0
            ? previewTimeline
            : restoredTimeline,
        chatStatus: "ready",
      });
      return;
    }

    const state = get();
    if (
      state.localSessionId === localSessionId &&
      (state.acpPhase === "initializing" ||
        state.acpPhase === "creating" ||
        state.acpPhase === "ready" ||
        state.acpPhase === "prompting")
    ) {
      return;
    }

    set({
      activeSessionId: localSessionId,
      localSessionId,
      cwd,
      acpSessionId,
      timeline: restoredTimeline,
      acpPhase: state.acpPhase === "idle" ? "initializing" : "creating",
      chatStatus: "submitted",
    });
    try {
      if (state.acpPhase !== "idle") {
        await sendSessionOpen(cwd, acpSessionId);
        return;
      }
      await sendAcp({
        jsonrpc: "2.0",
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          _meta: {
            startupHints: {
              nonInteractive: false,
              skipGitStatus: false,
              skipProjectLayout: false,
            },
            clientType: "melody-work",
            clientVersion: "0.1.0",
          },
        },
      });
    } catch (reason) {
      set({
        acpPhase: "error",
        chatStatus: "error",
        status: {
          ...get().status,
          message: reason instanceof Error ? reason.message : String(reason),
        },
      });
    }
  },
  receiveAcp: async (message) => {
    if (message.id === INITIALIZE_REQUEST_ID) {
      if (message.error) {
        set({
          acpPhase: "error",
          chatStatus: "error",
          status: {
            ...get().status,
            message: errorMessage(message, "ACP initialize failed"),
          },
        });
        return;
      }
      set({ acpPhase: "creating" });
      await sendSessionOpen(get().cwd, get().acpSessionId);
      return;
    }

    if (message.id === NEW_SESSION_REQUEST_ID) {
      const sessionId =
        stringValue(message.result?.sessionId) ?? get().acpSessionId;
      if (message.error || !sessionId) {
        set({
          acpPhase: "error",
          chatStatus: "error",
          status: {
            ...get().status,
            message: errorMessage(message, "session/new did not return a session ID"),
          },
        });
        return;
      }
      set({
        acpPhase: "ready",
        acpSessionId: sessionId,
        chatStatus: "ready",
      });
      const localSessionId = get().localSessionId;
      if (localSessionId) {
        const updated = await updateStoredSession({
          id: localSessionId,
          acpSessionId: sessionId,
        });
        useWorkspaceStore.getState().replaceSession(updated);
      }
      return;
    }

    if (
      typeof message.id === "number" &&
      message.id >= 100 &&
      !message.method
    ) {
      set((state) => ({
        acpPhase: message.error ? "error" : "ready",
        chatStatus: message.error ? "error" : "ready",
        timeline: state.timeline.map((entry) =>
          entry.kind === "message" && entry.streaming
            ? { ...entry, streaming: false }
            : entry,
        ),
      }));
      return;
    }

    if (message.method === "session/request_permission" && message.id !== undefined) {
      const params = message.params ?? {};
      const tool = objectValue(params.toolCall) ?? {};
      const toolCallId =
        stringValue(tool.toolCallId) ?? `permission-${String(message.id)}`;
      const options = parsePermissionOptions(params.options);

      set((state) => {
        const withTool = upsertTool(state.timeline, {
          ...tool,
          toolCallId,
        });
        return {
          timeline: withTool.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === toolCallId
              ? {
                  ...entry,
                  permission: "pending",
                  permissionRequestId: message.id,
                  permissionOptions: options,
                }
              : entry,
          ),
        };
      });

      const projectId =
        useWorkspaceStore.getState().activeProject?.id;
      const title = stringValue(tool.title) ?? "Tool call";
      const command = toolCommand(tool);
      if (projectId) {
        const rule = await findPermissionRule(
          projectId,
          permissionToolKey(title, command),
        );
        const option = rule
          ? options.find((item) =>
              rule.decision === "deny"
                ? item.kind.startsWith("reject")
                : item.kind.startsWith("allow"),
            )
          : undefined;
        if (rule && option) {
          set((state) => ({
            timeline: state.timeline.map((entry) =>
              entry.kind === "tool" && entry.toolCallId === toolCallId
                ? {
                    ...entry,
                    permission:
                      rule.decision === "deny" ? "denied" : "allowed",
                  }
                : entry,
            ),
          }));
          await sendAcp({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              outcome: {
                outcome: "selected",
                optionId: option.optionId,
              },
            },
          });
        }
      }
      return;
    }

    if (message.method !== "session/update") {
      return;
    }

    const update = objectValue(message.params?.update);
    const updateType = stringValue(update?.sessionUpdate);
    if (updateType === "agent_message_chunk") {
      const content = objectValue(update?.content);
      const text = stringValue(content?.text);
      if (text) {
        set((state) => ({
          chatStatus: "streaming",
          timeline: appendAgentChunk(state.timeline, text),
        }));
      }
      return;
    }

    if (updateType === "tool_call" || updateType === "tool_call_update") {
      set((state) => ({
        timeline: upsertTool(state.timeline, update ?? {}),
      }));
    }
  },
  submitPrompt: async (content) => {
    const trimmed = content.trim();
    if (!trimmed || get().chatStatus !== "ready") {
      return;
    }

    set((state) => ({
      chatStatus: "submitted",
      timeline: [
        ...state.timeline,
        {
          id: `user-${Date.now()}`,
          kind: "message",
          role: "user",
          content: trimmed,
        },
      ],
    }));

    if (!isTauriRuntime()) {
      window.setTimeout(() => {
        set((state) => ({
          chatStatus: "ready",
          timeline: [
            ...state.timeline,
            {
              id: `assistant-${Date.now()}`,
              kind: "message",
              role: "assistant",
              content:
                "The browser preview is using the same timeline renderer. In the desktop app this prompt is sent through ACP session/prompt.",
            },
          ],
        }));
      }, 500);
      return;
    }

    const sessionId = get().acpSessionId;
    if (!sessionId) {
      set({ chatStatus: "error", acpPhase: "error" });
      return;
    }
    const id = nextPromptRequestId++;
    set({ acpPhase: "prompting" });
    await sendAcp({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: trimmed }],
      },
    });
  },
  resolvePermission: async (entryId, optionId) => {
    const entry = get().timeline.find((item) => item.id === entryId);
    if (
      entry?.kind !== "tool" ||
      entry.permissionRequestId === undefined
    ) {
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
    const permission =
      option?.kind.startsWith("reject") ? "denied" : "allowed";

    if (projectDecision) {
      const projectId =
        useWorkspaceStore.getState().activeProject?.id;
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

    set((state) => ({
      timeline: state.timeline.map((item) =>
        item.id === entryId ? { ...item, permission } : item,
      ),
    }));

    if (!isTauriRuntime()) {
      return;
    }
    await sendAcp({
      jsonrpc: "2.0",
      id: entry.permissionRequestId,
      result: {
        outcome: {
          outcome: "selected",
          optionId: option.optionId,
        },
      },
    });
  },
}));
