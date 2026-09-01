import { PenLineIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type CaptureMode = "note" | "task";

export function ResearchCaptureComposer({
  captureMode,
  draft,
  onSubmit,
  setCaptureMode,
  setDraft,
}: {
  captureMode: CaptureMode;
  draft: string;
  onSubmit: () => void;
  setCaptureMode: (mode: CaptureMode) => void;
  setDraft: (draft: string) => void;
}) {
  return (
    <section className="border bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-xs">
        <PenLineIcon className="size-3.5 text-muted-foreground" />
        <button
          aria-pressed={captureMode === "note"}
          className={
            captureMode === "note"
              ? "font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }
          onClick={() => setCaptureMode("note")}
          type="button"
        >
          记录
        </button>
        <button
          aria-pressed={captureMode === "task"}
          className={
            captureMode === "task"
              ? "font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }
          onClick={() => setCaptureMode("task")}
          type="button"
        >
          研究任务
        </button>
        <span className="ml-auto text-muted-foreground text-[10px]">
          ⌘ ↵ 快速保存
        </span>
      </div>
      <Textarea
        aria-label={captureMode === "note" ? "记录研究内容" : "记录研究任务"}
        className="min-h-28 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none focus-visible:ring-0"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder={
          captureMode === "note"
            ? "记录一个研究想法、发现或下一步…"
            : "把下一步拆成一个可执行任务…"
        }
        value={draft}
      />
      <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
        <span className="text-muted-foreground text-[11px]">
          支持 Markdown · 内容保存在当前项目
        </span>
        <Button disabled={!draft.trim()} onClick={onSubmit} size="sm">
          <PlusIcon />
          {captureMode === "note" ? "保存记录" : "添加任务"}
        </Button>
      </div>
    </section>
  );
}
