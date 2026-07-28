import assert from "node:assert/strict";
import test from "node:test";

import {
  groupModelsByProvider,
  modelProvider,
} from "./model-provider.ts";

const model = (id, name) => ({
  id,
  name,
  reasoningEfforts: [],
});

test("infers providers from both model ids and display names", () => {
  assert.deepEqual(modelProvider(model("deepseek-v4-flash", "Flash")), {
    id: "deepseek",
    name: "DeepSeek",
  });
  assert.deepEqual(modelProvider(model("custom-1", "Claude Sonnet")), {
    id: "anthropic",
    name: "Anthropic",
  });
});

test("groups models while preserving backend order", () => {
  const groups = groupModelsByProvider([
    model("gpt-5", "GPT-5"),
    model("deepseek-v4", "DeepSeek V4"),
    model("gpt-4o", "GPT-4o"),
  ]);
  assert.deepEqual(
    groups.map((group) => ({
      models: group.models.map((item) => item.id),
      provider: group.provider.name,
    })),
    [
      { models: ["gpt-5", "gpt-4o"], provider: "OpenAI" },
      { models: ["deepseek-v4"], provider: "DeepSeek" },
    ],
  );
});
