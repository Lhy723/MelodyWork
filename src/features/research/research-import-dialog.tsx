import { ImportIcon } from "lucide-react";
import { useRef, useState } from "react";

import { LoadingButton } from "@/components/interior/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toUserMessage } from "@/domain/app-error";
import type { ResearchPaper } from "@/domain/research";

import { importResearchPaper } from "./research-api";

export function ImportPaperDialog({
  onImported,
  open,
  setOpen,
}: {
  onImported: (paper: ResearchPaper) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [candidate, setCandidate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const runImport = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const paper = await importResearchPaper(candidate);
      onImported(paper);
      setCandidate("");
      setOpen(false);
    } catch (reason) {
      setError(toUserMessage(reason));
      throw reason;
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入论文</DialogTitle>
          <DialogDescription>
            支持 arXiv 链接、doi.org 链接或
            DOI。元信息来自真实学术索引，不会生成缺失字段。
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="论文地址或 DOI"
          onChange={(event) => setCandidate(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && candidate.trim() && !loading) {
              event.preventDefault();
              importButtonRef.current?.click();
            }
          }}
          placeholder="https://arxiv.org/abs/... 或 10.xxxx/..."
          value={candidate}
        />
        {error ? (
          <p
            aria-live="assertive"
            className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter showCloseButton>
          <LoadingButton
            disabled={!candidate.trim()}
            errorLabel="重试"
            icon={<ImportIcon />}
            onAction={runImport}
            pendingLabel="正在查询学术索引…"
            ref={importButtonRef}
            successLabel="已导入"
          >
            导入
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
