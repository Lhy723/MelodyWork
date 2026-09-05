import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/domain/app-error";
import {
  readWorkspaceBinaryFile,
  readWorkspaceFile,
} from "@/lib/melody-bridge";

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
  const requestId = useRef(0);
  const Icon = iconForKind(kind);

  const loadPreview = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(undefined);
    setContent(undefined);
    setBuffer(undefined);

    if (kind === "legacy-office") {
      setLoading(false);
      return;
    }

    try {
      if (binaryKind) {
        const nextBuffer = await readWorkspaceBinaryFile(root, path);
        if (requestId.current === currentRequest) setBuffer(nextBuffer);
      } else {
        const nextContent = await readWorkspaceFile(root, path);
        if (requestId.current === currentRequest) setContent(nextContent);
      }
    } catch (reason) {
      if (requestId.current === currentRequest) {
        setError(toUserMessage(reason));
      }
      throw reason;
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [binaryKind, kind, path, root]);

  useEffect(() => {
    void loadPreview().catch(() => undefined);
    return () => {
      requestId.current += 1;
    };
  }, [loadPreview]);

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
        <LoadingButton
          aria-label="重新加载文件"
          disabled={loading}
          errorLabel="重试"
          icon={<RefreshCwIcon />}
          iconOnly
          onAction={loadPreview}
          pendingLabel="加载中…"
          size="xs"
          successLabel="已加载"
          variant="ghost"
        >
          重新加载文件
        </LoadingButton>
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
