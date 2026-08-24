import {
  FileAudioIcon,
  FileCode2Icon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  PresentationIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { strFromU8, unzipSync, type Unzipped } from "fflate";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import {
  readWorkspaceBinaryFile,
  readWorkspaceFile,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import {
  languageFor,
  mimeTypeFor,
  previewKindFor,
  spreadsheetColumn,
  spreadsheetColumnLabel,
  type PreviewKind,
} from "@/features/files/file-preview-utils";
import { MonacoEditor } from "@/features/files/monaco-editor";

const kindLabel: Record<PreviewKind, string> = {
  audio: "音频",
  docx: "Word 文档",
  html: "HTML",
  image: "图片",
  "legacy-office": "旧版 Office",
  markdown: "Markdown",
  pdf: "PDF",
  pptx: "PowerPoint",
  text: "文本",
  video: "视频",
  xlsx: "Excel 工作簿",
};

const iconForKind = (kind: PreviewKind) => {
  if (kind === "image") return FileImageIcon;
  if (kind === "audio") return FileAudioIcon;
  if (kind === "video") return FileVideoIcon;
  if (kind === "xlsx") return FileSpreadsheetIcon;
  if (kind === "pptx") return PresentationIcon;
  if (kind === "pdf" || kind === "docx" || kind === "legacy-office") {
    return FileTextIcon;
  }
  return FileCode2Icon;
};

const xml = (source: string) => {
  const document = new DOMParser().parseFromString(source, "application/xml");
  const error = document.querySelector("parsererror");
  if (error) throw new Error("文档结构无法解析");
  return document;
};

const zipText = (archive: Unzipped, path: string) => {
  const entry = archive[path];
  if (!entry) throw new Error(`文档缺少 ${path}`);
  return strFromU8(entry);
};

const unzipOffice = (
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

const elementsByLocalName = (root: ParentNode, name: string) =>
  Array.from(root.querySelectorAll("*")).filter(
    (element) => element.localName === name,
  );

type WordBlock =
  { kind: "paragraph"; text: string } | { kind: "table"; rows: string[][] };

const parseDocx = (buffer: ArrayBuffer): WordBlock[] => {
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

interface WorkbookSheet {
  name: string;
  rows: string[][];
}

const parseXlsx = (buffer: ArrayBuffer): WorkbookSheet[] => {
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

interface PresentationSlide {
  number: number;
  paragraphs: string[];
}

const parsePptx = (buffer: ArrayBuffer): PresentationSlide[] => {
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

function SourcePreview({ content, path }: { content: string; path: string }) {
  const codeFont = useAppSettingsStore((state) => state.codeFont);
  const codeFontSize = useAppSettingsStore((state) => state.codeFontSize);
  const editorTheme =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "vs-dark"
      : "vs";

  return (
    <Suspense
      fallback={
        <p className="p-4 text-muted-foreground text-xs">正在加载预览…</p>
      }
    >
      <MonacoEditor
        language={languageFor(path)}
        loading="正在加载预览…"
        options={{
          fontFamily: codeFont,
          fontSize: codeFontSize,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          padding: { top: 12 },
          readOnly: true,
          renderLineHighlight: "none",
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          wordWrap: "on",
        }}
        theme={editorTheme}
        value={content}
      />
    </Suspense>
  );
}

function WordPreview({ buffer }: { buffer: ArrayBuffer }) {
  const result = useMemo(() => {
    try {
      return { blocks: parseDocx(buffer) };
    } catch (reason) {
      return {
        error: toUserMessage(reason),
      };
    }
  }, [buffer]);
  if (result.error) return <PreviewError message={result.error} />;

  return (
    <div className="h-full overflow-y-auto bg-muted/35 p-5">
      <article className="mx-auto min-h-full max-w-3xl bg-background px-10 py-12 shadow-sm">
        {result.blocks?.length ? (
          result.blocks.map((block, index) =>
            block.kind === "paragraph" ? (
              <p
                className="mb-3 whitespace-pre-wrap text-sm leading-7"
                key={`${index}-${block.text.slice(0, 20)}`}
              >
                {block.text}
              </p>
            ) : (
              <div className="my-5 overflow-x-auto" key={index}>
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td
                            className="border px-3 py-2 align-top"
                            key={cellIndex}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          )
        ) : (
          <PreviewEmpty label="文档中没有可提取的文本内容" />
        )}
      </article>
    </div>
  );
}

function SpreadsheetPreview({ buffer }: { buffer: ArrayBuffer }) {
  const result = useMemo(() => {
    try {
      return { sheets: parseXlsx(buffer) };
    } catch (reason) {
      return {
        error: toUserMessage(reason),
      };
    }
  }, [buffer]);
  const [activeSheet, setActiveSheet] = useState(0);
  useEffect(() => setActiveSheet(0), [buffer]);
  if (result.error) return <PreviewError message={result.error} />;

  const sheet = result.sheets?.[activeSheet];
  const columnCount = Math.max(
    0,
    ...(sheet?.rows.map((row) => row.length) ?? []),
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/20 px-2">
        {result.sheets?.map((item, index) => (
          <Button
            className="h-7 shrink-0 px-2 text-xs"
            key={`${item.name}-${index}`}
            onClick={() => setActiveSheet(index)}
            size="sm"
            variant={index === activeSheet ? "secondary" : "ghost"}
          >
            {item.name}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {sheet?.rows.length ? (
          <table className="border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="sticky left-0 z-20 min-w-10 border-r border-b px-2 py-1.5" />
                {Array.from({ length: columnCount }, (_, index) => (
                  <th
                    className="min-w-28 border-r border-b px-3 py-1.5 font-medium"
                    key={index}
                  >
                    {spreadsheetColumnLabel(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th className="sticky left-0 bg-muted px-2 py-1.5 font-normal text-muted-foreground">
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: columnCount }, (_, columnIndex) => (
                    <td
                      className="max-w-72 border-t border-l px-3 py-1.5 align-top whitespace-pre-wrap"
                      key={columnIndex}
                    >
                      {row[columnIndex] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <PreviewEmpty label="工作簿中没有可显示的数据" />
        )}
      </div>
    </div>
  );
}

function PresentationPreview({ buffer }: { buffer: ArrayBuffer }) {
  const result = useMemo(() => {
    try {
      return { slides: parsePptx(buffer) };
    } catch (reason) {
      return {
        error: toUserMessage(reason),
      };
    }
  }, [buffer]);
  if (result.error) return <PreviewError message={result.error} />;

  return (
    <div className="h-full overflow-y-auto bg-muted/35 p-5">
      <div className="mx-auto grid max-w-4xl gap-5">
        {result.slides?.length ? (
          result.slides.map((slide) => (
            <article
              className="relative aspect-video overflow-hidden border bg-background p-[7%] shadow-sm"
              key={slide.number}
            >
              <span className="absolute right-3 bottom-2 text-muted-foreground text-xs">
                {slide.number}
              </span>
              <div className="flex h-full flex-col justify-center">
                {slide.paragraphs.map((paragraph, index) => (
                  <p
                    className={cn(
                      "mb-3 text-sm leading-6",
                      index === 0 && "font-semibold text-xl leading-8",
                    )}
                    key={`${index}-${paragraph.slice(0, 20)}`}
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </article>
          ))
        ) : (
          <PreviewEmpty label="演示文稿中没有可提取的幻灯片" />
        )}
      </div>
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <div
      aria-live="assertive"
      className="grid h-full place-items-center p-8 text-center"
      role="alert"
    >
      <div className="max-w-sm">
        <FileTextIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="font-medium text-sm">无法预览此文件</p>
        <p className="mt-1 text-muted-foreground text-xs leading-5">
          {message}
        </p>
      </div>
    </div>
  );
}

function PreviewEmpty({ label }: { label: string }) {
  return (
    <div className="grid h-full min-h-40 place-items-center p-8 text-center text-muted-foreground text-xs">
      {label}
    </div>
  );
}

function BinaryPreview({
  buffer,
  kind,
  path,
}: {
  buffer: ArrayBuffer;
  kind: PreviewKind;
  path: string;
}) {
  const objectUrl = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([buffer], {
          type: mimeTypeFor(path),
        }),
      ),
    [buffer, path],
  );
  useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl]);

  if (kind === "image") {
    return (
      <div className="grid h-full place-items-center overflow-auto bg-[radial-gradient(circle_at_center,var(--color-muted)_1px,transparent_1px)] bg-[size:16px_16px] p-5">
        <img
          alt={path.split("/").at(-1) ?? "图片预览"}
          className="max-h-full max-w-full object-contain shadow-sm"
          src={objectUrl}
        />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        className="size-full border-0 bg-background"
        src={objectUrl}
        title={`${path} PDF 预览`}
      />
    );
  }
  if (kind === "video") {
    return (
      <div className="grid h-full place-items-center bg-black p-4">
        <video
          className="max-h-full max-w-full"
          controls
          preload="metadata"
          src={objectUrl}
        >
          <track kind="captions" />
        </video>
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="grid h-full place-items-center bg-muted/25 p-8">
        <div className="w-full max-w-md text-center">
          <FileAudioIcon className="mx-auto mb-5 size-12 text-muted-foreground" />
          <p className="mb-5 truncate text-sm">{path.split("/").at(-1)}</p>
          <audio
            className="w-full"
            controls
            preload="metadata"
            src={objectUrl}
          />
        </div>
      </div>
    );
  }
  if (kind === "docx") return <WordPreview buffer={buffer} />;
  if (kind === "xlsx") return <SpreadsheetPreview buffer={buffer} />;
  if (kind === "pptx") return <PresentationPreview buffer={buffer} />;
  return null;
}

export function FilePreview({ path, root }: { path: string; root: string }) {
  const kind = previewKindFor(path);
  const binaryKind = !["html", "legacy-office", "markdown", "text"].includes(
    kind,
  );
  const [content, setContent] = useState<string>();
  const [buffer, setBuffer] = useState<ArrayBuffer>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [rendered, setRendered] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const Icon = iconForKind(kind);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setContent(undefined);
    setBuffer(undefined);

    if (kind === "legacy-office") {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    const request = binaryKind
      ? readWorkspaceBinaryFile(root, path).then((value) => {
          if (active) setBuffer(value);
        })
      : readWorkspaceFile(root, path).then((value) => {
          if (active) setContent(value);
        });
    void request
      .catch((reason) => {
        if (active) {
          setError(toUserMessage(reason));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [binaryKind, kind, path, reloadKey, root]);

  return (
    <section className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs" title={path}>
          {path}
        </span>
        <span className="text-muted-foreground text-xs">{kindLabel[kind]}</span>
        {kind === "markdown" || kind === "html" ? (
          <div className="flex items-center rounded-md bg-muted p-0.5">
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => setRendered(true)}
              size="sm"
              variant={rendered ? "secondary" : "ghost"}
            >
              预览
            </Button>
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => setRendered(false)}
              size="sm"
              variant={rendered ? "ghost" : "secondary"}
            >
              源码
            </Button>
          </div>
        ) : null}
        <Button
          aria-label="重新加载文件"
          disabled={loading}
          onClick={() => setReloadKey((value) => value + 1)}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {loading ? (
          <p className="p-4 text-muted-foreground text-xs">正在加载文件…</p>
        ) : error ? (
          <PreviewError message={error} />
        ) : kind === "legacy-office" ? (
          <PreviewError message="旧版二进制 Office 格式暂不支持直接渲染。请将文件另存为 DOCX、XLSX 或 PPTX 后预览。" />
        ) : buffer ? (
          <BinaryPreview buffer={buffer} kind={kind} path={path} />
        ) : kind === "markdown" && rendered ? (
          <div className="h-full overflow-y-auto px-6 py-5">
            <MessageResponse className="mx-auto max-w-3xl text-sm">
              {content ?? ""}
            </MessageResponse>
          </div>
        ) : kind === "html" && rendered ? (
          <iframe
            className="size-full border-0 bg-white"
            sandbox=""
            srcDoc={content}
            title={`${path} HTML 预览`}
          />
        ) : (
          <SourcePreview content={content ?? ""} path={path} />
        )}
      </div>
    </section>
  );
}
