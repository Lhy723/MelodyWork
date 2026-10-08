import assert from "node:assert/strict";
import test from "node:test";

import { parsePiModelCatalogEvent } from "./model-catalog.ts";

const event = (overrides = {}) => ({
  protocolVersion: 1,
  eventId: "epoch:8",
  requestId: "models-1",
  replay: false,
  event: {
    type: "runtime.models",
    revision: 3,
    models: [
      {
        provider: "xai",
        id: "grok-4.5",
        name: "Grok 4.5",
        api: "openai-responses",
        input: ["text", "image", "text"],
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 16000,
        availability: "auth-needed",
      },
    ],
    ...overrides,
  },
});

test("parses a versioned model snapshot and keeps only safe fields", () => {
  const snapshot = parsePiModelCatalogEvent(event(), "models-1");
  assert.deepEqual(snapshot, {
    revision: 3,
    models: [
      {
        provider: "xai",
        id: "grok-4.5",
        name: "Grok 4.5",
        api: "openai-responses",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 16000,
        availability: "auth-needed",
      },
    ],
  });
});

test("ignores unrelated request events and rejects malformed catalogs", () => {
  assert.equal(parsePiModelCatalogEvent(event(), "models-other"), undefined);
  assert.throws(
    () =>
      parsePiModelCatalogEvent(
        event({
          models: [
            {
              ...event().event.models[0],
              provider: "",
            },
          ],
        }),
        "models-1",
      ),
    /provider.*非空/u,
  );
  assert.throws(
    () =>
      parsePiModelCatalogEvent(
        event({ models: [event().event.models[0], event().event.models[0]] }),
        "models-1",
      ),
    /重复模型/u,
  );
});

test("requires protocol and correlation metadata", () => {
  assert.throws(
    () =>
      parsePiModelCatalogEvent({ ...event(), protocolVersion: 2 }, "models-1"),
    /协议版本/u,
  );
  assert.throws(
    () => parsePiModelCatalogEvent({ ...event(), eventId: "" }, "models-1"),
    /eventId.*非空/u,
  );
});
