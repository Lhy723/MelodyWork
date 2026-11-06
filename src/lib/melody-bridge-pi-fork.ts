import { invoke } from "@tauri-apps/api/core";

import type { SessionRecord } from "@/domain/workspace";
import {
  getPiAgentSessionBinding,
  isTauriRuntime,
  sendPiAgentCommand,
  startPiWorker,
  subscribeToPiAgentEvents,
} from "./melody-bridge-runtime";

/** Create a durable Pi-native branch and wait for the Host-accepted open ack. */
export const forkPiSession = async (
  source: SessionRecord,
  target: SessionRecord,
  nativeEntryId: string,
): Promise<void> => {
  if (!isTauriRuntime()) {
    throw new Error("Pi 会话分支仅在桌面运行时可用。 ");
  }
  if (source.cwd !== target.cwd || source.projectId !== target.projectId) {
    throw new Error("探索分支必须留在源会话所属的工作区。 ");
  }
  const forkRequestId = `pi-fork-${target.id}-${Date.now()}`;
  await invoke("prepare_pi_session_fork", {
    sourceSessionId: source.id,
    branchSessionId: target.id,
    anchorNativeEntryId: nativeEntryId,
    requestId: forkRequestId,
    cwd: source.cwd,
  });
  await startPiWorker(source.cwd);

  const sourceBinding = await getPiAgentSessionBinding(source.id);
  let expectedRequestId = "";
  let expectedSessionId = "";
  let acknowledge: (() => void) | undefined;
  let rejectAcknowledge: ((reason: Error) => void) | undefined;
  const unlisteners = await subscribeToPiAgentEvents(
    (envelope) => {
      if (envelope.requestId !== expectedRequestId) return;
      if (
        envelope.event.type === "session.opened" &&
        envelope.sessionId === expectedSessionId
      ) {
        acknowledge?.();
      } else if (envelope.event.type === "runtime.error") {
        rejectAcknowledge?.(new Error(envelope.event.error.message));
      }
    },
    () => {},
  );

  const sendAndWaitForOpen = async (
    requestId: string,
    sessionId: string,
    command: Parameters<typeof sendPiAgentCommand>[0]["command"],
  ) => {
    expectedRequestId = requestId;
    expectedSessionId = sessionId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      rejectAcknowledge = reject;
    });
    try {
      await sendPiAgentCommand({
        protocolVersion: 1,
        requestId,
        sessionId: source.id,
        command,
      });
      await Promise.race([
        acknowledgement,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("恢复 Pi 探索分支超时。")),
            15_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      acknowledge = undefined;
      rejectAcknowledge = undefined;
    }
  };

  try {
    await sendAndWaitForOpen(
      `pi-open-fork-source-${source.id}-${Date.now()}`,
      source.id,
      {
        type: "session.open",
        sessionId: source.id,
        productSessionId: source.id,
        cwd: source.cwd,
        permissionMode: sourceBinding?.permissionMode ?? "ask",
        sessionModeId: sourceBinding?.sessionModeId ?? "default",
        ...(sourceBinding?.modelId ? { modelId: sourceBinding.modelId } : {}),
        ...(sourceBinding?.reasoningEffort
          ? { reasoningEffort: sourceBinding.reasoningEffort }
          : {}),
      },
    );
    await sendAndWaitForOpen(forkRequestId, target.id, {
      type: "session.fork",
      sessionId: source.id,
      targetSessionId: target.id,
      cwd: source.cwd,
      nativeEntryId,
    });
  } finally {
    for (const unlisten of unlisteners) unlisten();
  }
};
