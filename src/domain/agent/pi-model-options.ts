import type { AgentModelOption, AgentReasoningEffortOption } from "../acp.ts";
import type { AgentModelDescriptor } from "./contract.ts";
import type { PiModelCatalogSnapshot } from "./model-catalog.ts";

/**
 * Keep the model picker on the same four labels used by the ACP path. Pi can
 * accept more thinking levels, but exposing levels that the product does not
 * yet describe would make a Pi session behave differently from an ACP one.
 */
const reasoningEffortCopy: Record<
  string,
  { label: string; description: string }
> = {
  low: { label: "低", description: "优先快速响应" },
  medium: { label: "中", description: "兼顾速度与质量" },
  high: { label: "高", description: "更充分的推理与实现检查" },
  xhigh: { label: "极高", description: "最深入的推理与实现检查" },
};

const reasoningEffortValues = ["low", "medium", "high", "xhigh"] as const;

const reasoningEffortsFor = (
  reasoning: boolean,
): AgentReasoningEffortOption[] =>
  reasoning
    ? reasoningEffortValues.map((value) => ({
        id: value,
        value,
        label: reasoningEffortCopy[value].label,
        description: reasoningEffortCopy[value].description,
      }))
    : [];

/** The id sent through the product command boundary and understood by Pi. */
export const piModelOptionId = (
  model: Pick<AgentModelDescriptor, "provider" | "id">,
): string => `${model.provider}/${model.id}`;

const toModelOption = (model: AgentModelDescriptor): AgentModelOption => ({
  id: piModelOptionId(model),
  name: model.name,
  input: [...model.input],
  contextWindowTokens: model.contextWindow,
  reasoningEfforts: reasoningEffortsFor(model.reasoning),
});

export interface PiModelOptionsProjection {
  revision: number;
  /** Models safe to offer to a session picker. */
  availableModels: AgentModelOption[];
  /** Models kept for settings/diagnostics, never silently offered as usable. */
  unavailableModels: AgentModelDescriptor[];
  refreshErrors?: Record<string, string>;
}

/**
 * Project a validated, non-secret Pi catalog into the product model shape.
 * Availability is intentionally split instead of dropped: auth-needed and
 * provider errors must remain explainable in settings, while the composer
 * should never let a known-unusable entry become the active model.
 */
export const projectPiModelCatalog = (
  snapshot: PiModelCatalogSnapshot,
): PiModelOptionsProjection => {
  const availableModels: AgentModelOption[] = [];
  const unavailableModels: AgentModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const model of snapshot.models) {
    const id = piModelOptionId(model);
    if (seen.has(id)) continue;
    seen.add(id);
    if (model.availability === "available") {
      availableModels.push(toModelOption(model));
    } else {
      unavailableModels.push(model);
    }
  }

  return {
    revision: snapshot.revision,
    availableModels,
    unavailableModels,
    ...(snapshot.refreshErrors
      ? { refreshErrors: { ...snapshot.refreshErrors } }
      : {}),
  };
};

/**
 * Preserve an explicitly selected model across a catalog refresh; otherwise
 * use the first available model. This mirrors the ACP store's selection
 * semantics without coupling a Pi snapshot to Zustand.
 */
export const selectPiModelId = (
  models: readonly AgentModelOption[],
  currentModelId?: string,
): string | undefined =>
  (currentModelId && models.some((model) => model.id === currentModelId)
    ? currentModelId
    : models[0]?.id) ?? undefined;
