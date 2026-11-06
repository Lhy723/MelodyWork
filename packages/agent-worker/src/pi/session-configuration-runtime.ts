import type { AgentCommandEnvelope } from "@melody/agent-contract";
import type { WorkerEmitter } from "../protocol.ts";
import { applyModelPolicyOverrides } from "./model-policy.ts";
import type { PiModelCatalogRuntime } from "./model-catalog-runtime.ts";
import { fail } from "./session-errors.ts";
import {
  effectiveThinkingLevelForSession,
  modelIdForSession,
  type PiSessionHandle,
} from "./session-runtime-types.ts";
import {
  normalizeSessionModeId,
  normalizeThinkingLevel,
} from "./turn-policy.ts";

type ConfigureCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.configure" }
>;

/**
 * Owns the Pi-side session configuration transaction. The adapter retains
 * command admission and per-session lifecycle serialization; this module
 * validates the complete update before applying it and publishing its revision.
 */
export class PiSessionConfigurationRuntime {
  private readonly getSession: (
    sessionId: string,
  ) => PiSessionHandle | undefined;
  private readonly modelCatalog: Pick<
    PiModelCatalogRuntime,
    "resolveModel" | "settingsOverridesForModel"
  >;
  private readonly emit: WorkerEmitter;

  public constructor(dependencies: {
    getSession: (sessionId: string) => PiSessionHandle | undefined;
    modelCatalog: Pick<
      PiModelCatalogRuntime,
      "resolveModel" | "settingsOverridesForModel"
    >;
    emit: WorkerEmitter;
  }) {
    this.getSession = dependencies.getSession;
    this.modelCatalog = dependencies.modelCatalog;
    this.emit = dependencies.emit;
  }

  public async configure(
    command: ConfigureCommand,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.getSession(command.sessionId);
    if (!handle) {
      const message = `Pi 会话不存在：${command.sessionId}。`;
      throw fail("pi.session_not_found", message, "session");
    }
    if (
      command.expectedRevision !== undefined &&
      command.expectedRevision !== handle.configRevision
    ) {
      throw fail(
        "pi.config_revision_conflict",
        `Pi 会话配置已更新（当前 revision ${handle.configRevision}），请刷新后重试。`,
        "session",
      );
    }

    const changed =
      command.modelId !== undefined ||
      command.reasoningEffort !== undefined ||
      command.sessionModeId !== undefined ||
      command.permissionMode !== undefined;
    if (!changed) {
      throw fail(
        "pi.config_change_missing",
        "Pi 会话配置没有可应用的变更。",
        "session",
      );
    }

    // Resolve every potentially failing value before mutating either the
    // product-side handle or the Pi session. In particular, an invalid
    // reasoning level must not leave a successfully switched model behind;
    // callers use the revision as the atomic commit marker.
    const nextThinkingLevel =
      command.reasoningEffort !== undefined
        ? normalizeThinkingLevel(command.reasoningEffort)
        : undefined;
    const nextSessionModeId =
      command.sessionModeId !== undefined
        ? normalizeSessionModeId(command.sessionModeId)
        : undefined;
    const nextModel =
      command.modelId !== undefined
        ? await this.modelCatalog.resolveModel(command.modelId)
        : undefined;

    if (nextModel) {
      await handle.session.setModel(nextModel);
      applyModelPolicyOverrides(
        handle.session.settingsManager,
        await this.modelCatalog.settingsOverridesForModel(nextModel),
      );
    }
    if (nextThinkingLevel) {
      handle.session.setThinkingLevel(nextThinkingLevel);
    }

    // Only publish the local configuration after the Pi mutation succeeds.
    // `setThinkingLevel` is synchronous and clamps to the model's supported
    // levels; normalization above guarantees the input is a valid protocol
    // value before it reaches Pi.
    if (nextSessionModeId !== undefined) {
      handle.sessionModeId = nextSessionModeId;
    }
    if (command.permissionMode !== undefined) {
      handle.permissionMode = command.permissionMode;
    }
    if (command.modelId !== undefined) {
      handle.modelId = modelIdForSession(handle.session, command.modelId);
    }
    if (
      command.modelId !== undefined ||
      command.reasoningEffort !== undefined
    ) {
      handle.reasoningEffort = effectiveThinkingLevelForSession(
        handle.session,
        nextThinkingLevel,
      );
    }
    handle.configRevision += 1;
    await this.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "session.configured",
        revision: handle.configRevision,
        ...(command.modelId !== undefined && handle.modelId
          ? { modelId: handle.modelId }
          : {}),
        ...(command.modelId !== undefined ||
        command.reasoningEffort !== undefined
          ? { reasoningEffort: handle.reasoningEffort }
          : {}),
        ...(command.sessionModeId
          ? { sessionModeId: command.sessionModeId }
          : {}),
        ...(command.permissionMode
          ? { permissionMode: command.permissionMode }
          : {}),
      },
    });
  }
}
