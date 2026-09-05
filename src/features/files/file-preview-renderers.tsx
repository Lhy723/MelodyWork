import {
  FileAudioIcon,
  FileCode2Icon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  PresentationIcon,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import { cn } from "@/lib/utils";
import { useAppSettingsStore } from "@/stores/app-settings-store";

import {
  languageFor,
  mimeTypeFor,
  spreadsheetColumnLabel,
  type PreviewKind,
} from "./file-preview-utils";
import {
  parseDocx,
  parsePptx,
  parseXlsx,
  type PresentationSlide,
} from "./file-preview-formatters";
import { MonacoEditor } from "./monaco-editor";

export const kindLabel: Record<PreviewKind, string> = {
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

export const iconForKind = (kind: PreviewKind) => {
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

export function SourcePreview({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
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

export function PreviewError({ message }: { message: string }) {
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

export function PreviewEmpty({ label }: { label: string }) {
  return (
    <div className="grid h-full min-h-40 place-items-center p-8 text-center text-muted-foreground text-xs">
      {label}
    </div>
  );
}

export function WordPreview({ buffer }: { buffer: ArrayBuffer }) {
  const result = useMemo(() => {
    try {
      return { blocks: parseDocx(buffer) };
    } catch (reason) {
      return { error: toUserMessage(reason) };
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

export function SpreadsheetPreview({ buffer }: { buffer: ArrayBuffer }) {
  const result = useMemo(() => {
    try {
      return { sheets: parseXlsx(buffer) };
    } catch (reason) {
      return { error: toUserMessage(reason) };
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

export function PresentationPreview({ buffer }: { buffer: ArrayBuffer }) {
  const result = useMemo(() => {
    try {
      return { slides: parsePptx(buffer) };
    } catch (reason) {
      return { error: toUserMessage(reason) };
    }
  }, [buffer]);
  if (result.error) return <PreviewError message={result.error} />;

  return (
    <div className="h-full overflow-y-auto bg-muted/35 p-5">
      <div className="mx-auto grid max-w-4xl gap-5">
        {result.slides?.length ? (
          result.slides.map((slide: PresentationSlide) => (
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

export function BinaryPreview({
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
