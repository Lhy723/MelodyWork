import assert from "node:assert/strict";
import test from "node:test";

import {
  piModelOptionId,
  projectPiModelCatalog,
  selectPiModelId,
} from "./pi-model-options.ts";

const model = (overrides = {}) => ({
  provider: "melody-demo-abc123",
  id: "demo-model",
  name: "Demo Model",
  api: "openai-completions",
  input: ["text"],
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 16384,
  availability: "available",
  ...overrides,
});

test("projects available Pi models to canonical product options", () => {
  const projection = projectPiModelCatalog({
    revision: 9,
    models: [model()],
  });

  assert.equal(piModelOptionId(model()), "melody-demo-abc123/demo-model");
  assert.deepEqual(projection.availableModels, [
    {
      id: "melody-demo-abc123/demo-model",
      name: "Demo Model",
      input: ["text"],
      contextWindowTokens: 128000,
      reasoningEfforts: [
        {
          id: "low",
          value: "low",
          label: "低",
          description: "优先快速响应",
        },
        {
          id: "medium",
          value: "medium",
          label: "中",
          description: "兼顾速度与质量",
        },
        {
          id: "high",
          value: "high",
          label: "高",
          description: "更充分的推理与实现检查",
        },
        {
          id: "xhigh",
          value: "xhigh",
          label: "极高",
          description: "最深入的推理与实现检查",
        },
      ],
    },
  ]);
  assert.deepEqual(projection.unavailableModels, []);
});

test("keeps auth and provider failures out of selectable models", () => {
  const authNeeded = model({
    provider: "anthropic",
    id: "claude",
    name: "Claude",
    availability: "auth-needed",
  });
  const unavailable = model({
    provider: "broken",
    id: "model",
    name: "Broken",
    reasoning: false,
    availability: "unavailable",
  });
  const projection = projectPiModelCatalog({
    revision: 4,
    models: [model(), authNeeded, unavailable],
    refreshErrors: { "auth:anthropic": "需要登录" },
  });

  assert.deepEqual(
    projection.availableModels.map((entry) => entry.id),
    ["melody-demo-abc123/demo-model"],
  );
  assert.deepEqual(
    projection.unavailableModels.map((entry) => [entry.id, entry.availability]),
    [
      ["claude", "auth-needed"],
      ["model", "unavailable"],
    ],
  );
  assert.deepEqual(projection.refreshErrors, { "auth:anthropic": "需要登录" });
  assert.deepEqual(
    projectPiModelCatalog({ revision: 5, models: [unavailable] })
      .availableModels,
    [],
  );
});

test("does not expose reasoning controls for non-reasoning models", () => {
  const projection = projectPiModelCatalog({
    revision: 1,
    models: [model({ reasoning: false })],
  });
  assert.deepEqual(projection.availableModels[0]?.reasoningEfforts, []);
});

test("preserves a selected model across refresh and falls back when removed", () => {
  const models = projectPiModelCatalog({
    revision: 1,
    models: [model(), model({ provider: "xai", id: "grok", name: "Grok" })],
  }).availableModels;

  assert.equal(selectPiModelId(models, "xai/grok"), "xai/grok");
  assert.equal(
    selectPiModelId(models, "missing/model"),
    "melody-demo-abc123/demo-model",
  );
  assert.equal(selectPiModelId([], "missing/model"), undefined);
});
