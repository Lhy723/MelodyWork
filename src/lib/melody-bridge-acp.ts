import type { UnlistenFn } from "@tauri-apps/api/event";

import type { AcpEnvelope, AgentStatus } from "../domain/acp.ts";
import {
  PREVIEW_AGENT_MESSAGE,
  PREVIEW_FIXTURE_VERSION,
} from "./preview-fixtures.ts";
import { isTauriRuntime } from "./melody-bridge-runtime-context.ts";

type PreviewAcpListener = (message: AcpEnvelope) => void;
const previewAcpListeners = new Set<PreviewAcpListener>();
const previewAcpStderrListeners = new Set<(line: string) => void>();
let previewSequence = 0;

const emitPreviewAcp = (message: AcpEnvelope, delay = 0) => {
  window.setTimeout(() => {
    for (const listener of previewAcpListeners) {
      listener(message);
    }
  }, delay);
};

const dispatchPreviewAcp = (message: AcpEnvelope) => {
  const method = message.method;
  const params = message.params ?? {};
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : undefined;
  const requestMeta =
    params._meta !== null && typeof params._meta === "object"
      ? (params._meta as Record<string, unknown>)
      : undefined;
  const promptId =
    typeof requestMeta?.promptId === "string"
      ? requestMeta.promptId
      : undefined;
  const fixtureMeta = { fixtureVersion: PREVIEW_FIXTURE_VERSION };
  if (method === "initialize") {
    emitPreviewAcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        _meta: {
          ...fixtureMeta,
          modelState: {
            currentModelId: "grok-4.5",
            availableModels: [
              {
                modelId: "grok-4.5",
                name: "Grok 4.5",
                _meta: {
                  totalContextTokens: 128_000,
                  supportsReasoningEffort: true,
                },
              },
            ],
          },
        },
      },
    });
    return;
  }
  if (method === "authenticate") {
    emitPreviewAcp({ jsonrpc: "2.0", id: message.id, result: fixtureMeta });
    return;
  }
  if (method === "session/new" || method === "session/load") {
    const nextSessionId =
      typeof params.sessionId === "string"
        ? params.sessionId
        : `preview-acp-${++previewSequence}`;
    emitPreviewAcp({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: nextSessionId,
        _meta: fixtureMeta,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "标准" },
            { id: "fast", name: "快速", description: "降低延迟的预览模式" },
          ],
        },
      },
    });
    return;
  }
  if (method === "session/prompt" && sessionId) {
    const eventPrefix = `preview-${++previewSequence}`;
    emitPreviewAcp(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: PREVIEW_AGENT_MESSAGE },
          },
          _meta: {
            ...fixtureMeta,
            eventId: `${eventPrefix}-chunk`,
            ...(promptId ? { promptId } : {}),
          },
        },
      },
      20,
    );
    emitPreviewAcp(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "turn_completed",
            stopReason: "end_turn",
            usage: {
              inputTokens: 24,
              outputTokens: 18,
              modelCalls: 1,
              apiDurationMs: 18,
            },
          },
          _meta: {
            ...fixtureMeta,
            eventId: `${eventPrefix}-complete`,
            ...(promptId ? { promptId } : {}),
          },
        },
      },
      40,
    );
    // ACP may acknowledge session/prompt before the turn emits its final
    // session/update. Keep this ordering aligned with the event consumer.
    emitPreviewAcp(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          _meta: {
            ...fixtureMeta,
            ...(promptId ? { promptId } : {}),
            usage: {
              inputTokens: 24,
              outputTokens: 18,
              cachedReadTokens: 0,
              reasoningTokens: 0,
              modelCalls: 1,
              apiDurationMs: 18,
              usageIsIncomplete: false,
              costIsPartial: true,
            },
          },
        },
      },
      10,
    );
    return;
  }
  if (method === "session/cancel" && sessionId) {
    return;
  }
  if (method === "session/set_model" || method === "session/set_mode") {
    emitPreviewAcp({ jsonrpc: "2.0", id: message.id, result: fixtureMeta });
  }
};

const desktopAcpUnavailable = () =>
  new Error(
    "Legacy ACP transport is unavailable in the Desktop runtime; Pi is the only Desktop Agent runtime.",
  );

export const sendAcp = async (message: AcpEnvelope): Promise<void> => {
  if (isTauriRuntime()) throw desktopAcpUnavailable();
  dispatchPreviewAcp(message);
};

export const subscribeToAcp = async (
  onMessage: (message: AcpEnvelope) => void,
  onStderr: (line: string) => void,
  _onStatus?: (status: AgentStatus) => void,
): Promise<UnlistenFn[]> => {
  if (isTauriRuntime()) throw desktopAcpUnavailable();

  const onMessageListener: PreviewAcpListener = onMessage;
  const onStderrListener = onStderr;
  previewAcpListeners.add(onMessageListener);
  previewAcpStderrListeners.add(onStderrListener);
  return [
    () => previewAcpListeners.delete(onMessageListener),
    () => previewAcpStderrListeners.delete(onStderrListener),
  ];
};
