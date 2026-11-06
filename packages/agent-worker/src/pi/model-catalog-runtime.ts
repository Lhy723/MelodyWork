import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentCommandEnvelope, AgentError } from "@melody/agent-contract";
import {
  mapPiModelCatalog,
  type PiProviderAuthState,
} from "./model-catalog.ts";
import {
  loadPiModelPolicies,
  settingsOverridesForModel,
  type PiModelIdentity,
  type PiModelPolicySnapshot,
  type PiSettingsOverrides,
} from "./model-policy.ts";
import type { WorkerEmitter } from "../protocol.ts";

export type PiModelRuntimeFactory = typeof ModelRuntime.create;
type PiModelRuntime = Awaited<ReturnType<PiModelRuntimeFactory>>;
type AuthenticateCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "runtime.authenticate" }
>;
type SyncModelsCommand = Extract<
  AgentCommandEnvelope["command"],
  { type: "runtime.models.sync" }
>;

const PI_AUTH_PATH_ENV = "MELODY_PI_AUTH_PATH";
const PI_MODELS_PATH_ENV = "MELODY_PI_MODELS_PATH";
const PI_MODEL_NETWORK_ENV = "MELODY_PI_ALLOW_MODEL_NETWORK";
const PI_CATALOG_BASE_URL_ENV = "MELODY_PI_CATALOG_BASE_URL";

const parseBooleanEnvironment = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");

const runtimePaths = (): { authPath: string; modelsPath: string } => {
  const configuredRoot = process.env.MELODY_HOME?.trim();
  const dataRoot = configuredRoot
    ? join(configuredRoot, "pi")
    : join(tmpdir(), "melody-pi");
  mkdirSync(dataRoot, { recursive: true });
  return {
    authPath:
      process.env[PI_AUTH_PATH_ENV]?.trim() || join(dataRoot, "auth.json"),
    modelsPath:
      process.env[PI_MODELS_PATH_ENV]?.trim() || join(dataRoot, "models.json"),
  };
};

const modelError = (modelId: string): Error & { agentError: AgentError } => {
  const message = `Pi 找不到模型：${modelId}。`;
  const error = new Error(message) as Error & { agentError: AgentError };
  error.agentError = {
    code: "pi.model_not_found",
    message,
    retriable: false,
    scope: "session",
  };
  return error;
};

const authenticationError = (
  error: unknown,
): Error & { agentError: AgentError } => {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(message) as Error & { agentError: AgentError };
  wrapped.agentError = {
    code: "pi.authentication_failed",
    message,
    retriable: false,
    scope: "runtime",
  };
  return Object.assign(wrapped, { cause: error });
};

const parseModelId = (
  modelId: string,
): { provider: string; id: string } | undefined => {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
};

/**
 * The Host keeps Melody's config alias as the product-facing model id, while
 * Pi needs the provider/model pair from the generated catalog. The suffix is
 * an ordinal added by the Host to make sanitized provider ids deterministic.
 */
const customProviderPrefix = (modelId: string): string => {
  let alias = "";
  for (const character of modelId) {
    if (/^[a-zA-Z0-9_-]$/.test(character)) alias += character.toLowerCase();
    else alias += "-";
    // Keep this aligned with the Host's stable provider-id sanitizer.
    if (alias.length >= 48) break;
  }
  return `melody-${alias || "model"}-`;
};

/**
 * Owns the Pi provider/model runtime and its serialized Host-projected
 * catalog lifecycle. SessionAdapter remains responsible for applying policy
 * changes at safe live-session boundaries.
 */
export class PiModelCatalogRuntime {
  private runtimePromise?: Promise<PiModelRuntime>;
  private policiesPromise?: Promise<PiModelPolicySnapshot>;
  private catalogRevision = 0;
  private catalogTail: Promise<unknown> = Promise.resolve();
  private readonly emit: WorkerEmitter;
  private readonly refreshLiveSessionSettings: () => Promise<void>;
  private readonly createModelRuntime: PiModelRuntimeFactory;

  public constructor(
    emit: WorkerEmitter,
    refreshLiveSessionSettings: () => Promise<void>,
    dependencies: { createModelRuntime?: PiModelRuntimeFactory } = {},
  ) {
    this.emit = emit;
    this.refreshLiveSessionSettings = refreshLiveSessionSettings;
    this.createModelRuntime =
      dependencies.createModelRuntime ??
      ((options) => ModelRuntime.create(options));
  }

  public async getModelRuntime(): Promise<PiModelRuntime> {
    this.runtimePromise ??= (async () => {
      const paths = runtimePaths();
      return this.createModelRuntime({
        refreshOnCreate: false,
        allowModelNetwork: parseBooleanEnvironment(
          process.env[PI_MODEL_NETWORK_ENV],
        ),
        modelRefreshTimeoutMs: 15_000,
        ...(process.env[PI_CATALOG_BASE_URL_ENV]?.trim()
          ? { catalogBaseUrl: process.env[PI_CATALOG_BASE_URL_ENV].trim() }
          : {}),
        authPath: paths.authPath,
        modelsPath: paths.modelsPath,
      });
    })();
    return this.runtimePromise;
  }

  public async settingsOverridesForModel(
    model: PiModelIdentity | undefined,
  ): Promise<PiSettingsOverrides> {
    this.policiesPromise ??= loadPiModelPolicies();
    return settingsOverridesForModel(model, await this.policiesPromise);
  }

  public async resolveModel(modelId: string) {
    const runtime = await this.getModelRuntime();
    const parsed = parseModelId(modelId);
    const direct = parsed
      ? runtime.getModel(parsed.provider, parsed.id)
      : runtime.getModels().find((candidate) => candidate.id === modelId);
    if (direct) return direct;

    const byName = runtime
      .getModels()
      .find((candidate) => candidate.name === modelId);
    if (byName) return byName;
    const prefix = customProviderPrefix(modelId);
    const byAlias = runtime
      .getModels()
      .find((candidate) => candidate.provider.startsWith(prefix));
    if (byAlias) return byAlias;
    throw modelError(modelId);
  }

  public async authenticate(
    command: AuthenticateCommand,
    requestId: string | number,
  ): Promise<void> {
    const runtime = await this.getModelRuntime();
    const providerId = command.providerId?.trim() || command.methodId.trim();
    const action = command.action ?? "status";
    try {
      if (action === "setApiKey") {
        if (!command.apiKey) {
          const message = "设置 API key 时必须提供 apiKey。";
          const error = new Error(message) as Error & {
            agentError: AgentError;
          };
          error.agentError = {
            code: "pi.auth_key_missing",
            message,
            retriable: false,
            scope: "runtime",
          };
          throw error;
        }
        await runtime.setRuntimeApiKey(providerId, command.apiKey);
      } else if (action === "removeApiKey") {
        await runtime.removeRuntimeApiKey(providerId);
      } else {
        await runtime.checkAuth(providerId);
      }
      await this.emit({
        requestId,
        event: {
          type: "runtime.warning",
          error: {
            code: "pi.authentication.updated",
            message:
              action === "status"
                ? `已检查 ${providerId} 的认证状态。`
                : `${providerId} 的认证信息已更新。`,
            retriable: false,
            scope: "runtime",
            details: { providerId, action },
          },
        },
      });
      await this.listModels(requestId, true);
    } catch (error) {
      throw authenticationError(error);
    }
  }

  public async listModels(
    requestId: string | number,
    refresh = false,
  ): Promise<void> {
    return this.enqueueCatalog(() =>
      this.listModelsInternal(requestId, refresh),
    );
  }

  public async syncModels(
    command: SyncModelsCommand,
    requestId: string | number,
  ): Promise<void> {
    return this.enqueueCatalog(async () => {
      const runtime = await this.getModelRuntime();
      const previousPoliciesPromise = this.policiesPromise;
      const generatedPrefix = "MELODY_PI_MODEL_";
      const previousEnvironment = new Map<string, string>();
      for (const name of Object.keys(process.env)) {
        if (name.startsWith(generatedPrefix)) {
          const value = process.env[name];
          if (value !== undefined) previousEnvironment.set(name, value);
          delete process.env[name];
        }
      }
      for (const credential of command.credentials) {
        process.env[credential.name] = credential.value;
      }

      try {
        await Promise.all(
          command.providerIds.map((providerId) =>
            runtime.removeRuntimeApiKey(providerId),
          ),
        );
        const policies = await loadPiModelPolicies();
        this.policiesPromise = Promise.resolve(policies);
        await this.listModelsInternal(requestId, true);
        await this.refreshLiveSessionSettings();
      } catch (error) {
        for (const name of Object.keys(process.env)) {
          if (name.startsWith(generatedPrefix)) delete process.env[name];
        }
        for (const [name, value] of previousEnvironment) {
          process.env[name] = value;
        }
        this.policiesPromise = previousPoliciesPromise;
        throw error;
      }
    });
  }

  private async listModelsInternal(
    requestId: string | number,
    refresh: boolean,
  ): Promise<void> {
    const runtime = await this.getModelRuntime();
    const refreshErrors: Record<string, string> = {};
    if (refresh) {
      const result = await runtime.refresh({
        allowNetwork: parseBooleanEnvironment(
          process.env[PI_MODEL_NETWORK_ENV],
        ),
        force: true,
      });
      for (const [provider, error] of result.errors) {
        refreshErrors[`refresh:${provider}`] = error.message;
      }
    }

    const models = runtime.getModels();
    let availableModels = models;
    try {
      availableModels = await runtime.getAvailable();
    } catch (error) {
      availableModels = [];
      refreshErrors["availability"] =
        error instanceof Error ? error.message : String(error);
    }

    const providerAuth = new Map<string, PiProviderAuthState>();
    await Promise.all(
      runtime.getProviders().map(async (provider) => {
        try {
          const auth = await runtime.checkAuth(provider.id);
          providerAuth.set(
            provider.id,
            auth
              ? {
                  status: "configured",
                  ...(auth.source ? { source: auth.source } : {}),
                }
              : { status: "missing" },
          );
        } catch (error) {
          providerAuth.set(provider.id, { status: "unknown" });
          refreshErrors[`auth:${provider.id}`] =
            error instanceof Error ? error.message : String(error);
        }
      }),
    );

    await this.emit({
      requestId,
      event: {
        type: "runtime.models",
        revision: ++this.catalogRevision,
        models: mapPiModelCatalog(models, availableModels, providerAuth),
        ...(Object.keys(refreshErrors).length > 0 ? { refreshErrors } : {}),
      },
    });
  }

  private async enqueueCatalog<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.catalogTail;
    const current = previous.catch(() => undefined).then(operation);
    this.catalogTail = current;
    try {
      return await current;
    } finally {
      if (this.catalogTail === current) {
        this.catalogTail = Promise.resolve();
      }
    }
  }
}
