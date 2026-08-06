import test from "node:test";
import assert from "node:assert/strict";

import {
  languageFor,
  mimeTypeFor,
  previewKindFor,
  spreadsheetColumn,
  spreadsheetColumnLabel,
} from "./file-preview-utils.ts";

test("routes supported preview file types", () => {
  const cases = {
    "photo.PNG": "image",
    "recording.m4a": "audio",
    "movie.webm": "video",
    "paper.pdf": "pdf",
    "notes.md": "markdown",
    "page.htm": "html",
    "report.docx": "docx",
    "data.xlsx": "xlsx",
    "slides.pptx": "pptx",
    "legacy.doc": "legacy-office",
    "src/main.rs": "text",
  };

  for (const [path, expected] of Object.entries(cases)) {
    assert.equal(previewKindFor(path), expected, path);
  }
});

test("maps source languages and media MIME types", () => {
  assert.equal(languageFor("src/main.tsx"), "typescript");
  assert.equal(languageFor("README"), "plaintext");
  assert.equal(mimeTypeFor("figure.svg"), "image/svg+xml");
  assert.equal(mimeTypeFor("unknown.bin"), "application/octet-stream");
});

test("converts spreadsheet references and labels", () => {
  assert.equal(spreadsheetColumn("A1"), 0);
  assert.equal(spreadsheetColumn("Z99"), 25);
  assert.equal(spreadsheetColumn("AA10"), 26);
  assert.equal(spreadsheetColumnLabel(0), "A");
  assert.equal(spreadsheetColumnLabel(25), "Z");
  assert.equal(spreadsheetColumnLabel(26), "AA");
  assert.equal(spreadsheetColumnLabel(701), "ZZ");
  assert.equal(spreadsheetColumnLabel(702), "AAA");
});
