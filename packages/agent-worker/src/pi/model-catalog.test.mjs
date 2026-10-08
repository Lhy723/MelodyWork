import assert from "node:assert/strict";
import test from "node:test";

import { mapPiModelCatalog } from "./model-catalog.ts";

test("maps Pi models without exposing credentials and preserves availability states", () => {
  const models = [
    {
      provider: "openai",
      id: "gpt-5",
      name: " GPT-5 ",
      api: "openai-responses",
      input: ["text", "image", "image"],
      reasoning: true,
      contextWindow: 256000,
      maxTokens: 32768,
      secret: "must-not-leak",
    },
    {
      provider: "local",
      id: "qwen",
      api: "openai-completions",
      input: [],
      contextWindow: 0,
      maxTokens: -1,
    },
    {
      provider: "openai",
      id: "gpt-5",
      api: "openai-responses",
    },
    { provider: "broken", id: "", api: "openai-completions" },
  ];
  const result = mapPiModelCatalog(
    models,
    [models[0]],
    new Map([
      ["openai", { status: "configured", source: "OAuth" }],
      ["local", { status: "missing" }],
    ]),
  );

  assert.deepEqual(result, [
    {
      provider: "openai",
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-responses",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 256000,
      maxTokens: 32768,
      availability: "available",
    },
    {
      provider: "local",
      id: "qwen",
      name: "qwen",
      api: "openai-completions",
      input: ["text"],
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384,
      availability: "auth-needed",
    },
  ]);
  assert.equal("secret" in result[0], false);
});

test("marks a configured provider's filtered model as unavailable", () => {
  const result = mapPiModelCatalog(
    [
      {
        provider: "provider",
        id: "filtered",
        api: "openai-completions",
      },
    ],
    [],
    new Map([["provider", { status: "configured", source: "API key" }]]),
  );
  assert.equal(result[0].availability, "unavailable");
  assert.equal(result[0].authSource, "API key");
});
