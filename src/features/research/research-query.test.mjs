import assert from "node:assert/strict";
import test from "node:test";

import { buildResearchQueryPlan } from "./research-query.ts";

test("creates an inspectable query draft from a natural-language prompt", () => {
  const plan = buildResearchQueryPlan(
    "How does multimodal RAG improve reproducible research?",
  );

  assert.equal(plan.original, "How does multimodal RAG improve reproducible research");
  assert.ok(plan.terms.includes("multimodal"));
  assert.ok(plan.terms.includes("RAG"));
  assert.ok(!plan.query.toLocaleLowerCase().includes("how"));
  assert.deepEqual(plan.removedTerms, ["How", "does"]);
  assert.equal(plan.strategy, "local-keyword-normalization");
});

test("keeps Chinese phrases readable instead of inventing a translation", () => {
  const plan = buildResearchQueryPlan(
    "大语言模型在科研发现中的应用效果如何？有哪些可复现的证据？",
  );

  assert.equal(plan.terms.length, 2);
  assert.match(plan.query, /大语言模型/);
  assert.match(plan.query, /可复现/);
});

test("returns an empty plan for whitespace-only input", () => {
  assert.deepEqual(buildResearchQueryPlan("  "), {
    original: "",
    query: "",
    terms: [],
  });
});
