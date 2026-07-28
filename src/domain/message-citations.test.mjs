import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMessageCitations,
  resolveProjectReference,
} from "./message-citations.ts";

test("extracts and deduplicates Markdown and bare URL citations", () => {
  assert.deepEqual(
    extractMessageCitations(
      "参见 [AI Elements](https://elements.ai-sdk.dev/components/inline-citation)，" +
        "也可访问 https://example.com/report。再次引用 https://example.com/report。",
    ),
    [
      {
        title: "AI Elements",
        url: "https://elements.ai-sdk.dev/components/inline-citation",
      },
      {
        title: "example.com",
        url: "https://example.com/report",
      },
    ],
  );
});

test("ignores images and unsafe or malformed URLs", () => {
  assert.deepEqual(
    extractMessageCitations(
      "![图](https://example.com/image.png) [本地](file:///tmp/a) https://",
    ),
    [],
  );
});

test("honors the citation limit", () => {
  assert.deepEqual(
    extractMessageCitations(
      "https://one.example https://two.example https://three.example",
      2,
    ).map((citation) => citation.url),
    ["https://one.example/", "https://two.example/"],
  );
});

test("resolves project file and folder references from the session cwd", () => {
  assert.deepEqual(
    resolveProjectReference(
      "../package.json",
      "/workspace/project",
      "/workspace/project/src",
    ),
    {
      absolutePath: "/workspace/project/package.json",
      displayPath: "package.json",
      kind: "file",
    },
  );
  assert.deepEqual(
    resolveProjectReference(
      "components/",
      "/workspace/project",
      "/workspace/project/src",
    ),
    {
      absolutePath: "/workspace/project/src/components",
      displayPath: "src/components/",
      kind: "folder",
    },
  );
});

test("does not treat code identifiers or paths outside the project as references", () => {
  assert.equal(
    resolveProjectReference(
      "useState",
      "/workspace/project",
      "/workspace/project/src",
    ),
    undefined,
  );
  assert.equal(
    resolveProjectReference(
      "../../secret.txt",
      "/workspace/project",
      "/workspace/project/src",
    ),
    undefined,
  );
});
