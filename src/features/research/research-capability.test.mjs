import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_MCP,
  RESEARCH_SKILLS,
  buildResearchEvidenceMatrix,
  formatResearchBibtex,
  useResearchCapabilityStore,
} from "./research-capability-store.ts";

test("Research capability registry exposes the built-in workflow", () => {
  assert.equal(RESEARCH_SKILLS.length, 6);
  assert.ok(RESEARCH_SKILLS.every((skill) => skill.guidance.length > 10));
  assert.equal(RESEARCH_MCP.id, "melody-research");
  assert.match(RESEARCH_MCP.relativeCommand, /research-mcp-server\.mjs$/);
});

test("Research capability state can enable and disable skills", () => {
  const store = useResearchCapabilityStore.getState();
  store.reset();
  assert.equal(store.enabledSkillIds.length, 6);
  store.setSkillEnabled("paper-review", false);
  assert.equal(
    useResearchCapabilityStore.getState().enabledSkillIds.includes("paper-review"),
    false,
  );
  store.setSkillEnabled("paper-review", true);
  assert.equal(
    useResearchCapabilityStore.getState().enabledSkillIds.includes("paper-review"),
    true,
  );
  store.reset();
});

test("Research tools produce conservative BibTeX and traceable matrix rows", () => {
  const bibtex = formatResearchBibtex({
    authors: ["Ada Lovelace", "Grace Hopper"],
    doi: "10.1234/example",
    title: "A Reproducible Study",
    year: 2026,
  });
  assert.match(bibtex, /@article\{10-1234-example/);
  assert.match(bibtex, /author = \{Ada Lovelace and Grace Hopper\}/);
  const matrix = buildResearchEvidenceMatrix([
    {
      authors: ["Ada Lovelace"],
      doi: "10.1234/example",
      id: "doi:10.1234/example",
      title: "A Reproducible Study",
      url: "https://doi.org/10.1234/example",
      year: 2026,
    },
  ]);
  assert.equal(matrix[0].id, "doi:10.1234/example");
  assert.match(matrix[0].identity, /10\.1234\/example/);
  assert.equal(matrix[0].design, "待从摘要或全文提取");
});

