import { FolderPlusIcon, MessageCircleIcon } from "lucide-react";

import { PressDepthButton } from "@/components/interior/press-depth";

export interface WorkspaceStartScreenProps {
  canUseIndependentTask: boolean;
  error?: string;
  loading: boolean;
  needsWorkspace: boolean;
  onChooseWorkspace: () => void;
  onUseIndependentTask: () => void;
}
export function WorkspaceStartScreen({
  canUseIndependentTask,
  error,
  loading,
  needsWorkspace,
  onChooseWorkspace,
  onUseIndependentTask,
}: WorkspaceStartScreenProps) {
  const title = loading
    ? "正在加载工作区"
    : needsWorkspace
      ? "选择一个工作区以开始"
      : "选择一个任务以继续";
  const description = loading
    ? "正在恢复你的工作区和任务。"
    : needsWorkspace
      ? "工作区让 Melody 能够读取项目文件、使用终端并查看 Git 变更。"
      : "从侧边栏选择已有项目，或选择一个新的工作区开始。";

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div
        className="harness-window-titlebar shrink-0"
        data-tauri-drag-region
      />
      <section className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-16 text-center">
        <div className="w-full max-w-xl">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <FolderPlusIcon className="size-6" />
          </div>
          <h1 className="mt-5 font-semibold text-2xl tracking-tight">
            {title}
          </h1>
          <p className="mx-auto mt-2 max-w-lg text-muted-foreground text-sm leading-6">
            {description}
          </p>
          {error ? (
            <p
              className="mx-auto mt-5 max-w-lg rounded-xl bg-destructive/10 px-4 py-3 text-destructive text-sm"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {!loading ? (
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <PressDepthButton depth={3} onClick={onChooseWorkspace} tilt={4}>
                <FolderPlusIcon data-icon="inline-start" />
                选择工作区
              </PressDepthButton>
              {canUseIndependentTask ? (
                <PressDepthButton
                  depth={3}
                  onClick={onUseIndependentTask}
                  tilt={4}
                  variant="outline"
                >
                  <MessageCircleIcon data-icon="inline-start" />
                  使用独立任务
                </PressDepthButton>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
