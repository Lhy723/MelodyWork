import { ImportIcon } from "lucide-react";
import { useRef, useState } from "react";

import { FloatingLabelInput } from "@/components/interior/floating-label";
import { useGlobalLiveActivity } from "@/components/interior/live-activity";
import { LoadingButton } from "@/components/interior/loading-button";
import { Modal } from "@/components/interior/modal";
import { Button } from "@/components/ui/button";
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
  const liveActivity = useGlobalLiveActivity();
  const [candidate, setCandidate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const runImport = async (nextCandidate = candidate) => {
    const normalized = nextCandidate.trim();
    if (!normalized) return;
    setLoading(true);
    setError(undefined);
    liveActivity.start({
      detail: "正在查询 Crossref、OpenAlex 或 arXiv…",
      title: "导入论文",
    });
    try {
      const paper = await importResearchPaper(normalized);
      onImported(paper);
      setCandidate("");
      setOpen(false);
      liveActivity.succeed({
        detail: `已导入《${paper.title}》。`,
        title: "论文导入完成",
      });
    } catch (reason) {
      const message = toUserMessage(reason);
      setError(message);
      liveActivity.fail(
        { detail: message, title: "论文导入失败" },
        {
          label: "重试",
          onClick: () => {
            void runImport(normalized).catch(() => undefined);
          },
        },
      );
      throw reason;
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal
      description="支持 arXiv 链接、doi.org 链接或 DOI。元信息来自真实学术索引，不会生成缺失字段。"
      footer={
        <>
          <Button onClick={() => setOpen(false)} variant="outline">
            取消
          </Button>
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
        </>
      }
      onClose={() => setOpen(false)}
      open={open}
      title="导入论文"
    >
      <div className="grid gap-4">
        <FloatingLabelInput
          autoFocus
          hint="支持 arXiv、doi.org 链接或 DOI"
          label="论文地址或 DOI"
          onChange={(value) => setCandidate(value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && candidate.trim() && !loading) {
              event.preventDefault();
              importButtonRef.current?.click();
            }
          }}
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
      </div>
    </Modal>
  );
}
