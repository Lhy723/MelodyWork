import type {
  AgentCommandEnvelope,
  AgentQuestionTimeoutPolicy,
} from "@melody/agent-contract";
import { IdempotencyLedger } from "../idempotency.ts";
import { applyModelPolicyOverrides } from "./model-policy.ts";
import type { PiModelCatalogRuntime } from "./model-catalog-runtime.ts";
import { fail } from "./session-errors.ts";
import {
  effectiveThinkingLevelForSession,
  modelIdForSession,
  PI_SESSION_ROOT_ENV,
  type PiResourceLoaderFactory,
  type PiSdk,
  type PiSession,
  type PiSessionContext,
  type PiSessionHandle,
} from "./session-runtime-types.ts";
import {
  normalizeSessionModeId,
  normalizeThinkingLevel,
} from "./turn-policy.ts";
import type { PiToolGateway } from "./tool-gateway.ts";
import type { PiSubagentRuntime } from "./subagent-runtime.ts";
import type { WorkerEmitter } from "../protocol.ts";
import { piSessionFileFor } from "./session-persistence-policy.ts";

type OpenCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "session.open" }
>;

type SessionContext = { handle: PiSessionContext };

interface PiSessionOpenToolContext {
  gateway: Pick<PiToolGateway, "createTools">;
  subagents: Pick<PiSubagentRuntime, "spawnSubagent" | "taskController">;
  contextForSession: (sessionId: string) => SessionContext | undefined;
  getRespectGitignore: () => boolean;
  getQuestionTimeoutPolicy: () => AgentQuestionTimeoutPolicy | undefined;
}

interface PiSessionOpenDependencies {
  sessions: Map<string, PiSessionHandle>;
  emit: WorkerEmitter;
  loadPiSdk: () => Promise<PiSdk>;
  modelCatalog: Pick<
    PiModelCatalogRuntime,
    "getModelRuntime" | "resolveModel" | "settingsOverridesForModel"
  >;
  createResourceLoader: PiResourceLoaderFactory;
  toolContext: PiSessionOpenToolContext;
  tools: string[];
  subscribeToEvents: (
    sessionId: string,
    handle: PiSessionHandle,
    session: PiSession,
  ) => () => void;
}

/**
 * Own the worker-side Pi session opening workflow: resolve its model and
 * Host-scoped resources, construct the restricted session, register its
 * runtime handle, then publish the established lifecycle events.
 */
export class PiSessionOpenRuntime {
  private readonly dependencies: PiSessionOpenDependencies;

  public constructor(dependencies: PiSessionOpenDependencies) {
    this.dependencies = dependencies;
  }

  public async open(
    command: OpenCommand,
    requestId: string | number,
    emitLifecycle: boolean,
  ): Promise<void> {
    const productSessionId = command.productSessionId ?? command.sessionId;
    const requestedSessionModeId = normalizeSessionModeId(
      command.sessionModeId,
    );
    const requestedThinkingLevel = normalizeThinkingLevel(
      command.reasoningEffort,
    );
    if (productSessionId) {
      const existing = this.dependencies.sessions.get(productSessionId);
      if (existing) {
        const existingCwd = existing.session.sessionManager.getCwd();
        if (existingCwd !== command.cwd) {
          throw fail(
            "pi.session_cwd_mismatch",
            "Pi 会话 " + productSessionId + " 已绑定到另一个工作区。",
            "session",
          );
        }
        // Reconnecting to a live product session is intentionally
        // idempotent and re-acknowledges its current config revision.
        if (emitLifecycle) {
          await this.dependencies.emit({
            requestId,
            sessionId: productSessionId,
            event: {
              type: "session.opened",
              nativeSessionId: existing.nativeSessionId,
              revision: existing.configRevision,
              ...(existing.modelId ? { modelId: existing.modelId } : {}),
              ...(existing.reasoningEffort
                ? { reasoningEffort: existing.reasoningEffort }
                : {}),
              sessionModeId: existing.sessionModeId,
              permissionMode: existing.permissionMode,
            },
          });
          await this.emitContextUsage(
            productSessionId,
            existing.session,
            requestId,
          );
        }
        return;
      }
    }
    const pi = await this.dependencies.loadPiSdk();
    const modelRuntime = await this.dependencies.modelCatalog.getModelRuntime();
    const requestedModelId =
      command.modelId === "unknown/unknown" ? undefined : command.modelId;
    // Initial model selection reads Pi's availability snapshot. Hydrate it
    // before creating a session, even if the renderer catalog is still loading.
    if (!requestedModelId) await modelRuntime.getAvailable();
    let sessionIdRef = productSessionId ?? "";
    const resourceBinding = await this.dependencies.createResourceLoader(
      pi,
      command.cwd,
      () =>
        this.dependencies.toolContext.contextForSession(sessionIdRef)?.handle
          .sessionModeId ?? requestedSessionModeId,
      () => "all",
      () =>
        this.dependencies.toolContext
          .contextForSession(sessionIdRef)
          ?.handle.session.getSessionStats().tokens.total,
    );
    const resourceLoader = resourceBinding.loader;
    const model = requestedModelId
      ? await this.dependencies.modelCatalog.resolveModel(requestedModelId)
      : undefined;
    const settingsManager = pi.SettingsManager.inMemory(
      await this.dependencies.modelCatalog.settingsOverridesForModel(model),
    );
    // The product id is stable across renderer reconnects; Pi owns the native
    // UUID and session-file binding.
    const sessionManager = this.createSessionManager(
      pi,
      command.cwd,
      productSessionId,
    );
    const { session } = await pi.createAgentSession({
      cwd: command.cwd,
      model,
      ...(requestedThinkingLevel
        ? { thinkingLevel: requestedThinkingLevel }
        : {}),
      modelRuntime,
      customTools: this.dependencies.toolContext.gateway.createTools(
        () => sessionIdRef,
        () =>
          this.dependencies.toolContext.contextForSession(sessionIdRef)?.handle
            .runId,
        () =>
          this.dependencies.toolContext.contextForSession(sessionIdRef)?.handle
            .permissionMode ?? command.permissionMode,
        () =>
          this.dependencies.toolContext
            .contextForSession(sessionIdRef)
            ?.handle.session.sessionManager.getCwd() ?? command.cwd,
        (input) => this.dependencies.toolContext.subagents.spawnSubagent(input),
        () =>
          this.dependencies.toolContext.contextForSession(sessionIdRef)?.handle
            .rootSessionId ?? sessionIdRef,
        () =>
          this.dependencies.toolContext.contextForSession(sessionIdRef)?.handle
            .sessionModeId ?? "default",
        this.dependencies.toolContext.subagents.taskController,
        this.dependencies.toolContext.getRespectGitignore,
        this.dependencies.toolContext.getQuestionTimeoutPolicy,
        undefined,
        undefined,
        resourceBinding.activateScopedInstructions,
      ),
      sessionManager,
      resourceLoader,
      settingsManager,
      // Pi's ambient shell/read/write tools stay disabled; the Host ToolGateway
      // proxies are the only worker-side tools available to the session.
      noTools: "builtin",
      tools: this.dependencies.tools,
    });
    if (!modelIdForSession(session)) {
      session.dispose();
      throw fail(
        "pi.model_unavailable",
        "尚无可用模型，请先在设置中配置模型及认证信息，然后重新连接。",
        "session",
      );
    }
    const nativeSessionId = session.sessionId;
    const sessionId = productSessionId ?? nativeSessionId;
    sessionIdRef = sessionId;
    const handle: PiSessionHandle = {
      session,
      refreshResources: async (manifest) => {
        resourceBinding.refreshPaths(manifest);
        // Rebuild the prompt only while idle; the next fresh turn refreshes
        // the loader again if this session was active.
        if (!session.isStreaming) await session.reload();
      },
      refreshModelSettings: async () => {
        if (session.isStreaming) return;
        applyModelPolicyOverrides(
          session.settingsManager,
          await this.dependencies.modelCatalog.settingsOverridesForModel(
            session.model,
          ),
        );
      },
      nativeSessionId,
      runFinished: true,
      nextMessage: 0,
      offsets: new Map(),
      activeMessageIds: new Map(),
      eventTail: Promise.resolve(),
      idempotency: new IdempotencyLedger(),
      unsubscribe: () => undefined,
      permissionMode: command.permissionMode,
      sessionModeId: requestedSessionModeId,
      capabilityMode: "all",
      ...(modelIdForSession(session, requestedModelId)
        ? { modelId: modelIdForSession(session, requestedModelId) }
        : {}),
      reasoningEffort: effectiveThinkingLevelForSession(
        session,
        requestedThinkingLevel,
      ),
      configRevision: 0,
      rootSessionId: sessionId,
      streamSessionId: sessionId,
    };
    this.dependencies.sessions.set(sessionId, handle);
    handle.unsubscribe = this.dependencies.subscribeToEvents(
      sessionId,
      handle,
      session,
    );
    if (emitLifecycle) {
      await this.dependencies.emit({
        requestId,
        sessionId,
        event: {
          type: "session.opened",
          nativeSessionId,
          revision: handle.configRevision,
          ...(handle.modelId ? { modelId: handle.modelId } : {}),
          reasoningEffort: handle.reasoningEffort,
          sessionModeId: handle.sessionModeId,
          permissionMode: handle.permissionMode,
        },
      });
      await this.dependencies.emit({
        requestId,
        sessionId,
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
      await this.emitContextUsage(sessionId, session, requestId);
    }
  }

  private async emitContextUsage(
    sessionId: string,
    session: PiSession,
    requestId: string | number,
  ): Promise<void> {
    const usage = session.getContextUsage();
    if (
      usage?.tokens === undefined ||
      usage.tokens === null ||
      !Number.isFinite(usage.tokens) ||
      usage.tokens < 0 ||
      !Number.isFinite(usage.contextWindow) ||
      usage.contextWindow <= 0
    )
      return;
    await this.dependencies.emit({
      requestId,
      sessionId,
      event: {
        type: "context.updated",
        tokens: usage.tokens,
        limit: usage.contextWindow,
        confidence: "measured",
      },
    });
  }

  private createSessionManager(
    pi: PiSdk,
    cwd: string,
    productSessionId?: string,
  ) {
    const sessionRoot = process.env[PI_SESSION_ROOT_ENV]?.trim();
    if (!sessionRoot || !productSessionId) {
      // Direct worker invocations without a Host root remain disposable
      // development sessions instead of writing into Pi's ambient ~/.pi dir.
      return pi.SessionManager.inMemory(cwd);
    }
    return pi.SessionManager.open(
      piSessionFileFor(sessionRoot, cwd, productSessionId),
      sessionRoot,
      cwd,
    );
  }
}
