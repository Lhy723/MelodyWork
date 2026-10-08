import type {
  AgentModelAvailability,
  AgentModelDescriptor,
} from "@melody/agent-contract";

/** The Pi model fields that are safe and useful to expose to the product. */
export interface PiModelCatalogEntry {
  provider: string;
  id: string;
  name?: string;
  api: string;
  input?: readonly ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export type PiProviderAuthState =
  | { status: "configured"; source?: string }
  | { status: "missing" }
  | { status: "unknown" };

const modelKey = (model: Pick<PiModelCatalogEntry, "provider" | "id">) =>
  `${model.provider}/${model.id}`;

const positiveInteger = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const normalizedInput = (
  input: PiModelCatalogEntry["input"],
): Array<"text" | "image"> => {
  const values = input?.filter(
    (item, index, all): item is "text" | "image" =>
      (item === "text" || item === "image") && all.indexOf(item) === index,
  );
  return values && values.length > 0 ? [...values] : ["text"];
};

const availabilityFor = (
  model: PiModelCatalogEntry,
  available: ReadonlySet<string>,
  auth: ReadonlyMap<string, PiProviderAuthState>,
): { availability: AgentModelAvailability; authSource?: string } => {
  const key = modelKey(model);
  if (available.has(key)) {
    return { availability: "available" };
  }
  const providerAuth = auth.get(model.provider);
  if (!providerAuth || providerAuth.status === "unknown") {
    return { availability: "unknown" };
  }
  if (providerAuth.status === "missing") {
    return { availability: "auth-needed" };
  }
  return {
    availability: "unavailable",
    ...(providerAuth.source ? { authSource: providerAuth.source } : {}),
  };
};

/**
 * Convert Pi's model records into a stable, non-secret product snapshot.
 *
 * `getModels()` is the complete configured catalog while `getAvailable()` is
 * the auth-filtered list. Keeping both inputs lets settings distinguish a
 * missing credential from a model filtered by a provider policy.
 */
export const mapPiModelCatalog = (
  models: readonly PiModelCatalogEntry[],
  availableModels: readonly PiModelCatalogEntry[],
  providerAuth: ReadonlyMap<string, PiProviderAuthState>,
): AgentModelDescriptor[] => {
  const available = new Set(availableModels.map(modelKey));
  const seen = new Set<string>();
  const result: AgentModelDescriptor[] = [];
  for (const model of models) {
    if (
      !model.provider.trim() ||
      !model.id.trim() ||
      seen.has(modelKey(model))
    ) {
      continue;
    }
    seen.add(modelKey(model));
    const status = availabilityFor(model, available, providerAuth);
    result.push({
      provider: model.provider,
      id: model.id,
      name: model.name?.trim() || model.id,
      api: model.api,
      input: normalizedInput(model.input),
      reasoning: model.reasoning === true,
      contextWindow: positiveInteger(model.contextWindow, 128_000),
      maxTokens: positiveInteger(model.maxTokens, 16_384),
      availability: status.availability,
      ...(status.authSource ? { authSource: status.authSource } : {}),
    });
  }
  return result;
};

export const piModelKey = modelKey;
