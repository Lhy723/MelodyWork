import assert from "node:assert/strict";
import test from "node:test";

import {
  isUserQuestionMethod,
  parseUserQuestionRequest,
  questionRequestKey,
} from "./user-question.ts";

test("parses the direct ask_user_question ACP request", () => {
  const request = parseUserQuestionRequest({
    jsonrpc: "2.0",
    id: 41,
    method: "x.ai/ask_user_question",
    params: {
      sessionId: "session-1",
      toolCallId: "call-1",
      mode: "plan",
      questions: [
        {
          question: "Which database should we use?",
          multiSelect: false,
          options: [
            { label: "SQLite", description: "Local and simple", id: "sqlite" },
          ],
        },
      ],
    },
  });

  assert.deepEqual(request, {
    requestId: 41,
    sessionId: "session-1",
    toolCallId: "call-1",
    mode: "plan",
    outcome: "pending",
    questions: [
      {
        question: "Which database should we use?",
        multiSelect: false,
        options: [
          {
            label: "SQLite",
            description: "Local and simple",
            id: "sqlite",
            preview: undefined,
          },
        ],
        id: undefined,
      },
    ],
  });
  assert.equal(questionRequestKey(request), "session-1:41");
});

test("parses Melody's wrapped question request and fallback session", () => {
  assert.equal(isUserQuestionMethod("_x.ai/ask_user_question"), true);
  const request = parseUserQuestionRequest(
    {
      id: "wrapped-1",
      method: "_x.ai/ask_user_question",
      params: {
        method: "x.ai/ask_user_question",
        params: {
          tool_call_id: "call-2",
          mode: "default",
          questions: [
            {
              question: "Anything else?",
              options: [],
              multi_select: true,
            },
          ],
        },
      },
    },
    "session-fallback",
  );

  assert.equal(request?.sessionId, "session-fallback");
  assert.equal(request?.toolCallId, "call-2");
  assert.equal(request?.questions[0]?.multiSelect, true);
  assert.equal(isUserQuestionMethod("session/update"), false);
});

test("ignores malformed or empty question requests", () => {
  assert.equal(
    parseUserQuestionRequest({
      id: 1,
      method: "x.ai/ask_user_question",
      params: { sessionId: "s", questions: [{ options: [] }] },
    }),
    undefined,
  );
  assert.equal(
    parseUserQuestionRequest({
      method: "x.ai/ask_user_question",
      params: { sessionId: "s", questions: [{ question: "?" }] },
    }),
    undefined,
  );
});
