import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import {
  readWorkspaceBinaryFile,
  readWorkspaceFile,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import {
  BinaryPreview,
  iconForKind,
  kindLabel,
  PreviewError,
  SourcePreview,
} from "./file-preview-renderers";
import { previewKindFor, type PreviewKind } from "./file-preview-utils";

const textPreviewKinds: PreviewKind[] = [
  "html",
  "legacy-office",
  "markdown",
  "text",
];

export function FilePreview({ path, root }: { path: string; root: string }) {
  const kind = previewKindFor(path);
  const binaryKind = !textPreviewKinds.includes(kind);
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
        if (active) setError(toUserMessage(reason));
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
