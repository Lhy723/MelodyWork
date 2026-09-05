"use client";

import { cn } from "@/lib/utils";
import { DownloadIcon, Maximize2Icon, XIcon } from "lucide-react";
import { createPortal } from "react-dom";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/interior/copy-button";
import { Tooltip, TooltipGroup } from "@/components/interior/tooltip-group";

type StreamdownTableProps = ComponentProps<"table"> & {
  node?: unknown;
};

const actionButtonClassName =
  "cursor-pointer rounded-lg p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

function tableCellText(cell: HTMLTableCellElement) {
  return (cell.textContent ?? "").replace(/\s+/gu, " ").trim();
}

function escapeMarkdownCell(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function tableToMarkdown(table: HTMLTableElement | null) {
  if (!table) return "";

  const header = table.tHead?.rows[0];
  const headers = header
    ? Array.from(header.cells, tableCellText)
    : Array.from(table.rows[0]?.cells ?? [], tableCellText);
  const bodyRows = Array.from(table.tBodies).flatMap((body) =>
    Array.from(body.rows, (row) => Array.from(row.cells, tableCellText)),
  );
  const width = Math.max(headers.length, ...bodyRows.map((row) => row.length));

  if (width === 0) return "";

  const normalizedHeaders = Array.from({ length: width }, (_, index) =>
    escapeMarkdownCell(headers[index] ?? ""),
  );
  const separator = Array.from({ length: width }, () => "---");
  const normalizedRows = bodyRows.map((row) =>
    Array.from({ length: width }, (_, index) =>
      escapeMarkdownCell(row[index] ?? ""),
    ),
  );

  return [
    `| ${normalizedHeaders.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...normalizedRows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function downloadMarkdownTable(table: HTMLTableElement | null) {
  const markdown = tableToMarkdown(table);
  if (!markdown) return;

  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "table.md";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function StreamdownTableActions({
  onCloseFullscreen,
  onDownload,
  onOpenFullscreen,
  value,
}: {
  onCloseFullscreen?: () => void;
  onDownload: () => void;
  onOpenFullscreen?: () => void;
  value: () => string;
}) {
  const fullscreen = Boolean(onCloseFullscreen);
  const tooltipSide = fullscreen ? "bottom" : "top";

  return (
    <TooltipGroup
      className="flex items-center justify-end gap-1"
      closeDelay={120}
      openDelay={200}
      skipDelay={400}
    >
      <Tooltip label="复制表格" side={tooltipSide}>
        <CopyButton
          aria-label="复制表格"
          copiedLabel="已复制表格"
          errorLabel="复制失败"
          label="复制表格"
          value={value}
        />
      </Tooltip>
      <Tooltip label="下载表格" side={tooltipSide}>
        <button
          aria-label="下载表格"
          className={actionButtonClassName}
          onClick={onDownload}
          type="button"
        >
          <DownloadIcon aria-hidden="true" className="size-4" />
        </button>
      </Tooltip>
      {fullscreen ? (
        <Tooltip label="关闭全屏表格" side={tooltipSide}>
          <button
            aria-label="关闭全屏表格"
            className={actionButtonClassName}
            onClick={onCloseFullscreen}
            type="button"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip label="全屏查看表格" side={tooltipSide}>
          <button
            aria-label="全屏查看表格"
            className={actionButtonClassName}
            onClick={onOpenFullscreen}
            type="button"
          >
            <Maximize2Icon aria-hidden="true" className="size-4" />
          </button>
        </Tooltip>
      )}
    </TooltipGroup>
  );
}

export function StreamdownTable({
  children,
  className,
  node: _node,
  ...props
}: StreamdownTableProps) {
  void _node;
  const tableRef = useRef<HTMLTableElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);

  const value = () => tableToMarkdown(tableRef.current);
  const onDownload = () => downloadMarkdownTable(tableRef.current);

  const table = (
    <table
      {...props}
      ref={tableRef}
      className={cn("w-full divide-y divide-border", className)}
      data-streamdown="table"
    >
      {children}
    </table>
  );

  return (
    <>
      <div
        className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
        data-streamdown="table-wrapper"
      >
        <StreamdownTableActions
          onDownload={onDownload}
          onOpenFullscreen={() => setFullscreen(true)}
          value={value}
        />
        <div className="border-collapse overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">
          {table}
        </div>
      </div>

      {fullscreen
        ? createPortal(
            <div
              aria-label="全屏查看表格"
              aria-modal="true"
              className="fixed inset-0 z-50 flex flex-col bg-background"
              onClick={() => setFullscreen(false)}
              role="dialog"
            >
              <div
                className="flex h-full flex-col"
                onClick={(event) => event.stopPropagation()}
                role="presentation"
              >
                <div className="flex items-center justify-end gap-1 p-4">
                  <StreamdownTableActions
                    onCloseFullscreen={() => setFullscreen(false)}
                    onDownload={onDownload}
                    value={value}
                  />
                </div>
                <div className="flex-1 overflow-auto p-4 pt-0">
                  <table
                    className="w-full border-collapse border border-border"
                    data-streamdown="table"
                  >
                    {children}
                  </table>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
