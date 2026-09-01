import { strFromU8, unzipSync, type Unzipped } from "fflate";

import { spreadsheetColumn } from "./file-preview-utils";

export const xml = (source: string) => {
  const document = new DOMParser().parseFromString(source, "application/xml");
  const error = document.querySelector("parsererror");
  if (error) throw new Error("文档结构无法解析");
  return document;
};

export const zipText = (archive: Unzipped, path: string) => {
  const entry = archive[path];
  if (!entry) throw new Error(`文档缺少 ${path}`);
  return strFromU8(entry);
};

export const unzipOffice = (
  buffer: ArrayBuffer,
  include: (path: string) => boolean,
) => {
  let expandedBytes = 0;
  return unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (!include(file.name)) return false;
      expandedBytes += file.originalSize;
      if (expandedBytes > 100 * 1024 * 1024) {
        throw new Error("文档解压后的预览内容超过 100 MB");
      }
      return true;
    },
  });
};

export const elementsByLocalName = (root: ParentNode, name: string) =>
  Array.from(root.querySelectorAll("*")).filter(
    (element) => element.localName === name,
  );

type WordBlock =
  { kind: "paragraph"; text: string } | { kind: "table"; rows: string[][] };

export const parseDocx = (buffer: ArrayBuffer): WordBlock[] => {
  const archive = unzipOffice(buffer, (path) => path === "word/document.xml");
  const document = xml(zipText(archive, "word/document.xml"));
  const body = elementsByLocalName(document, "body")[0];
  if (!body) return [];

  const blocks: WordBlock[] = [];
  for (const child of Array.from(body.children)) {
    if (child.localName === "p") {
      const text = elementsByLocalName(child, "t")
        .map((node) => node.textContent ?? "")
        .join("");
      if (text.trim()) blocks.push({ kind: "paragraph", text });
    } else if (child.localName === "tbl") {
      const rows = Array.from(child.children)
        .filter((node) => node.localName === "tr")
        .map((row) =>
          Array.from(row.children)
            .filter((node) => node.localName === "tc")
            .map((cell) =>
              elementsByLocalName(cell, "t")
                .map((node) => node.textContent ?? "")
                .join(""),
            ),
        );
      if (rows.length) blocks.push({ kind: "table", rows });
    }
  }
  return blocks;
};

export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

export const parseXlsx = (buffer: ArrayBuffer): WorkbookSheet[] => {
  const archive = unzipOffice(
    buffer,
    (path) =>
      path === "xl/workbook.xml" ||
      path === "xl/_rels/workbook.xml.rels" ||
      path === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(path),
  );
  const workbook = xml(zipText(archive, "xl/workbook.xml"));
  const relationships = xml(zipText(archive, "xl/_rels/workbook.xml.rels"));
  const relationshipTargets = new Map(
    elementsByLocalName(relationships, "Relationship").map((node) => [
      node.getAttribute("Id") ?? "",
      node.getAttribute("Target") ?? "",
    ]),
  );
  const sharedStrings = archive["xl/sharedStrings.xml"]
    ? elementsByLocalName(
        xml(zipText(archive, "xl/sharedStrings.xml")),
        "si",
      ).map((node) =>
        elementsByLocalName(node, "t")
          .map((text) => text.textContent ?? "")
          .join(""),
      )
    : [];

  return elementsByLocalName(workbook, "sheet").map((sheet, sheetIndex) => {
    const relationshipId =
      sheet.getAttribute("r:id") ??
      sheet.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      ) ??
      "";
    const target =
      relationshipTargets.get(relationshipId) ??
      `worksheets/sheet${sheetIndex + 1}.xml`;
    const normalizedTarget = target.replace(/^\/?xl\//, "");
    const sheetPath = `xl/${normalizedTarget.replace(/^\.\//, "")}`;
    const sheetDocument = xml(zipText(archive, sheetPath));
    const rows = elementsByLocalName(sheetDocument, "row")
      .slice(0, 500)
      .map((row) => {
        const values: string[] = [];
        for (const cell of Array.from(row.children).filter(
          (node) => node.localName === "c",
        )) {
          const column = spreadsheetColumn(cell.getAttribute("r") ?? "A");
          if (column >= 100) continue;
          const valueNode = Array.from(cell.children).find(
            (node) => node.localName === "v",
          );
          const inlineValue = elementsByLocalName(cell, "t")
            .map((node) => node.textContent ?? "")
            .join("");
          const raw = valueNode?.textContent ?? inlineValue;
          values[column] =
            cell.getAttribute("t") === "s"
              ? (sharedStrings[Number(raw)] ?? raw)
              : raw;
        }
        return values;
      });
    return {
      name: sheet.getAttribute("name") ?? `工作表 ${sheetIndex + 1}`,
      rows,
    };
  });
};

export interface PresentationSlide {
  number: number;
  paragraphs: string[];
}

export const parsePptx = (buffer: ArrayBuffer): PresentationSlide[] => {
  const archive = unzipOffice(buffer, (path) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(path),
  );
  return Object.keys(archive)
    .map((path) => ({
      path,
      number: Number(path.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]),
    }))
    .filter((entry) => Number.isFinite(entry.number))
    .sort((left, right) => left.number - right.number)
    .slice(0, 200)
    .map(({ path, number }) => {
      const slide = xml(zipText(archive, path));
      const paragraphs = elementsByLocalName(slide, "p")
        .map((paragraph) =>
          elementsByLocalName(paragraph, "t")
            .map((node) => node.textContent ?? "")
            .join(""),
        )
        .filter(Boolean);
      return { number, paragraphs };
    });
};
