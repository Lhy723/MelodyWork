import {
  ArrowLeftIcon,
  FileTextIcon,
  FilesIcon,
  FolderIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { LoadingButton } from "@/components/interior/loading-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MelodyExtension, SkillDetails } from "@/domain/config";
import { useAsyncOperation } from "@/hooks/use-async-operation";
import { deleteMelodySkill, getMelodySkillDetails } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

interface SkillDetailsViewProps {
  cwd: string;
  skill: MelodyExtension;
  onBack: () => void;
  onDeleted: () => Promise<void> | void;
}

export function SkillDetailsView({
  cwd,
  skill,
  onBack,
  onDeleted,
}: SkillDetailsViewProps) {
  const [details, setDetails] = useState<SkillDetails>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { state: loadingState, run: runLoad } = useAsyncOperation();
  const {
    state: deleteState,
    reset: resetDelete,
    run: runDelete,
  } = useAsyncOperation();
  const loading = loadingState.phase === "pending";
  const error = loadingState.error;
  const deleteError = deleteState.error;

  const load = useCallback(() => {
    void runLoad(() => getMelodySkillDetails(cwd, skill), setDetails).catch(
      () => undefined,
    );
  }, [cwd, runLoad, skill]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = () =>
    runDelete(async () => {
      await deleteMelodySkill(cwd, skill);
      setDeleteOpen(false);
      await onDeleted();
    });

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start gap-3">
        <Button
          aria-label="返回技能列表"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SparklesIcon className="size-4 text-muted-foreground" />
            <h3 className="truncate font-semibold text-lg">
              {details?.name ?? skill.name}
            </h3>
            <Badge variant="outline">
              {skill.scope === "user" ? "用户" : "项目"}
            </Badge>
            <Badge variant="secondary">
              {skill.pluginName
                ? `插件 · ${skill.pluginName}`
                : skill.provider === "agents"
                  ? "Agents"
                  : skill.provider === "claude"
                    ? "Claude"
                    : skill.provider === "cursor"
                      ? "Cursor"
                      : "Melody"}
            </Badge>
            {!skill.enabled ? (
              <Badge variant="secondary">
                {skill.compatibilityStatus === "disabled"
                  ? "兼容性已关闭"
                  : "已停用"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            {details?.description ?? "查看技能说明、包含的文件和安装位置。"}
          </p>
        </div>
        <Button
          aria-label="刷新技能详情"
          disabled={loading}
          onClick={() => void load()}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        {skill.deletable ? (
          <Button
            onClick={() => {
              resetDelete();
              setDeleteOpen(true);
            }}
            size="sm"
            variant="destructive"
          >
            <Trash2Icon />
            删除技能
          </Button>
        ) : null}
      </div>

      {error ? (
        <p
          aria-live="assertive"
          className="mt-5 rounded-xl bg-destructive/5 px-4 py-3 text-destructive text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {details ? (
        <>
          {details.license || details.compatibility ? (
            <dl className="mt-6 overflow-hidden rounded-xl border text-sm">
              {[
                ["许可证", details.license],
                ["兼容性", details.compatibility],
              ]
                .filter((entry): entry is [string, string] => Boolean(entry[1]))
                .map(([label, value], index) => (
                  <div
                    className={cn(
                      "grid grid-cols-[6rem_1fr] gap-3 px-4 py-2.5",
                      index > 0 && "border-t",
                    )}
                    key={label}
                  >
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          ) : null}

          <section className="mt-7">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-base">包含的文件</h4>
              <Badge variant="secondary">{details.files.length}</Badge>
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border">
              {details.files.length > 0 ? (
                details.files.map((file, index) => (
                  <div
                    className={cn(
                      "flex min-h-10 items-center gap-2 px-4 py-2 text-sm",
                      index > 0 && "border-t",
                    )}
                    key={file}
                  >
                    <FilesIcon className="size-4 text-muted-foreground" />
                    <code className="min-w-0 flex-1 truncate" title={file}>
                      {file}
                    </code>
                  </div>
                ))
              ) : (
                <p className="px-4 py-3 text-muted-foreground text-sm">
                  未发现技能文件。
                </p>
              )}
            </div>
          </section>

          <section className="mt-7">
            <div className="flex items-center gap-2">
              <FileTextIcon className="size-4 text-muted-foreground" />
              <h4 className="font-semibold text-base">SKILL.md</h4>
            </div>
            <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/30 p-4 font-mono text-xs leading-5">
              {details.content}
            </pre>
          </section>

          <section className="mt-7 overflow-hidden rounded-xl border text-xs">
            <div className="flex items-center gap-2 px-4 py-3">
              <FolderIcon className="size-4 text-muted-foreground" />
              <span className="w-16 text-muted-foreground">技能目录</span>
              <code className="min-w-0 flex-1 truncate" title={details.path}>
                {details.path}
              </code>
            </div>
            <div className="flex items-center gap-2 border-t px-4 py-3">
              <FileTextIcon className="size-4 text-muted-foreground" />
              <span className="w-16 text-muted-foreground">技能定义</span>
              <code
                className="min-w-0 flex-1 truncate"
                title={details.skillPath}
              >
                {details.skillPath}
              </code>
            </div>
          </section>
        </>
      ) : loading ? (
        <p className="mt-8 text-center text-muted-foreground text-sm">
          正在读取技能详情…
        </p>
      ) : null}

      <Dialog onOpenChange={setDeleteOpen} open={skill.deletable && deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除“{skill.name}”？</DialogTitle>
            <DialogDescription>
              这会永久删除该技能目录及其中的所有文件。删除后，Melody
              将不再发现或使用这个技能。
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p
              aria-live="assertive"
              className="rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-xs"
              role="alert"
            >
              {deleteError}
            </p>
          ) : null}
          <DialogFooter showCloseButton>
            <LoadingButton
              errorLabel="重试"
              icon={<Trash2Icon />}
              onAction={remove}
              pendingLabel="正在删除…"
              successLabel="已删除"
              variant="destructive"
            >
              确认删除
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
