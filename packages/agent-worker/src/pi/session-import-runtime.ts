import type { AgentCommandEnvelope } from "@melody/agent-contract";
import { fail } from "./session-errors.ts";
import { materializePiSessionImport } from "./session-import.ts";
import { piSessionFileFor } from "./session-persistence-policy.ts";
import {
  normalizeSessionModeId,
  normalizeThinkingLevel,
} from "./turn-policy.ts";
import {
  PI_SESSION_ROOT_ENV,
  type PiSessionHandle,
} from "./session-runtime-types.ts";
import type { WorkerEmitter } from "../protocol.ts";

type ImportCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.import" }
>;
type OpenCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.open" }
>;
type ImportSession = Pick<
  PiSessionHandle,
  | "session"
  | "permissionMode"
  | "sessionModeId"
  | "configRevision"
  | "modelId"
  | "reasoningEffort"
>;

interface PiSessionImportDependencies {
  getSession: (sessionId: string) => ImportSession | undefined;
  closeSession: (
    sessionId: string,
    requestId: string | number,
    emitLifecycle: boolean,
  ) => Promise<void>;
  openSession: (
    command: OpenCommand,
    requestId: string | number,
    emitLifecycle: boolean,
  ) => Promise<void>;
  emit: WorkerEmitter;
}

/** Own the Host-to-Pi import transaction and its ordered lifecycle handoff. */
export class PiSessionImportRuntime {
  private readonly dependencies: PiSessionImportDependencies;

  public constructor(dependencies: PiSessionImportDependencies) {
    this.dependencies = dependencies;
  }

  public async importSession(
    command: ImportCommand,
    requestId: string | number,
  ): Promise<void> {
    const handle = this.dependencies.getSession(command.sessionId);
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot) {
      throw fail(
        "pi.import_storage_unavailable",
        "Pi 原生会话目录尚未由 Host 配置，不能安全导入。",
        "session",
      );
    }
    const cwd = command.cwd.trim();
    if (handle && handle.session.sessionManager.getCwd() !== cwd) {
      throw fail(
        "pi.import_cwd_mismatch",
        "导入会话的工作区必须与当前 Pi 会话一致。",
        "session",
      );
    }
    const path = piSessionFileFor(sessionRoot, cwd, command.sessionId);
    const permissionMode =
      command.permissionMode ?? handle?.permissionMode ?? "ask";
    const sessionModeId = normalizeSessionModeId(
      command.sessionModeId ?? handle?.sessionModeId,
    );
    // Validate Pi-specific thinking levels before replacing any native session.
    const reasoningEffort = normalizeThinkingLevel(command.reasoningEffort);

    // The Host still has the legacy binding until `session.imported` arrives;
    // emitting `session.closed` here would be rejected as a stale Pi event.
    if (handle) {
      await this.dependencies.closeSession(command.sessionId, requestId, false);
    }
    const materialized = materializePiSessionImport(command.plan, {
      path,
      cwd,
      // Reusing an existing native id would append imported records to a live
      // Pi history. Every explicit replacement receives a fresh native id.
      nativeSessionId: undefined,
      backup: command.backup,
    });
    await this.dependencies.openSession(
      {
        type: "session.open",
        sessionId: command.sessionId,
        productSessionId: command.sessionId,
        cwd,
        permissionMode,
        modelId: command.modelId,
        reasoningEffort,
        sessionModeId,
      },
      requestId,
      false,
    );

    const importedHandle = this.dependencies.getSession(command.sessionId);
    await this.dependencies.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "session.imported",
        nativeSessionId: materialized.nativeSessionId,
        importedRecords: materialized.records,
        migrationId: command.migrationId,
        ...(materialized.backupPath
          ? { backupPath: materialized.backupPath }
          : {}),
        revision: importedHandle?.configRevision ?? 0,
        ...(importedHandle?.modelId ? { modelId: importedHandle.modelId } : {}),
        ...(importedHandle?.reasoningEffort
          ? { reasoningEffort: importedHandle.reasoningEffort }
          : {}),
        sessionModeId: importedHandle?.sessionModeId ?? "default",
        permissionMode: importedHandle?.permissionMode ?? permissionMode,
      },
    });
    // The Host commits its Pi binding while handling this event. Only afterward
    // may the worker publish the ordinary acknowledgement and next warning.
    await this.dependencies.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "session.opened",
        nativeSessionId: materialized.nativeSessionId,
        revision: importedHandle?.configRevision ?? 0,
        ...(importedHandle?.modelId ? { modelId: importedHandle.modelId } : {}),
        ...(importedHandle?.reasoningEffort
          ? { reasoningEffort: importedHandle.reasoningEffort }
          : {}),
        sessionModeId: importedHandle?.sessionModeId ?? "default",
        permissionMode: importedHandle?.permissionMode ?? permissionMode,
      },
    });
    await this.dependencies.emit({
      requestId,
      sessionId: command.sessionId,
      event: {
        type: "runtime.warning",
        error: {
          code: "pi.builtin_tools_disabled",
          message:
            "Pi worker 已禁用 Pi 内置工具，仅通过 Melody ToolGateway 提供受控的文件、终端和交互工具。",
          retriable: false,
          scope: "runtime",
        },
      },
    });
  }
}
