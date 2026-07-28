import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionModeIdFromUpdate,
  sessionModeState,
} from "./session-mode.ts";

test("parses ACP session mode state from session open responses", () => {
  assert.deepEqual(
    sessionModeState({
      modes: {
        currentModeId: "plan",
        availableModes: [
          {
            id: "default",
            name: "Agent",
            description: "Use tools.",
          },
          { id: "plan", name: "Plan" },
        ],
      },
    }),
    {
      selectedSessionModeId: "plan",
      availableSessionModes: [
        {
          id: "default",
          name: "Agent",
          description: "Use tools.",
        },
        { id: "plan", name: "Plan", description: undefined },
      ],
    },
  );
});

test("reads authoritative current_mode_update notifications", () => {
  assert.equal(
    sessionModeIdFromUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "ask",
    }),
    "ask",
  );
  assert.equal(
    sessionModeIdFromUpdate({
      sessionUpdate: "agent_message_chunk",
      currentModeId: "plan",
    }),
    undefined,
  );
});
