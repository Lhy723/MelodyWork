import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectRecord } from "@/domain/workspace";

interface NewTaskWorkspaceProps {
  children: ReactNode;
  mode: "work" | "research";
  onAddProject: () => void;
  onCancel: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  projects: ProjectRecord[];
  selectedProject?: ProjectRecord;
}

export function NewTaskWorkspace({
  children,
  mode,
  onAddProject,
  onCancel,
  onSelectProject,
  projects,
  selectedProject,
}: NewTaskWorkspaceProps) {
  const researchMode = mode === "research";

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header
        className="harness-window-titlebar flex shrink-0 items-center border-b px-5"
        data-tauri-drag-region
      >
        <SquarePenIcon className="size-3.5 text-muted-foreground" />
        <span className="ml-2 font-medium text-sm">
          {researchMode ? "新建研究任务" : "新建任务"}
        </span>
        <div
          aria-hidden="true"
          className="min-w-3 flex-1"
          data-tauri-drag-region
        />
        <Button
          className="ml-auto"
          onClick={onCancel}
          size="sm"
          variant="ghost"
        >
          取消
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pt-[12vh]">
        <div className="w-full max-w-5xl">
          <div className="mb-7 px-6 text-center">
            <h1 className="font-semibold text-2xl">
              {researchMode ? "今天想研究什么？" : "今天要完成什么？"}
            </h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {researchMode
                ? "选择 Melody Research 可以访问的工作目录，然后描述研究任务。"
                : "选择 Melody 可以访问的工作目录，然后描述任务。"}
            </p>
          </div>
          <div className="mx-auto mb-3 w-full max-w-3xl px-4 sm:px-6">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="w-full min-w-0 justify-start"
                  variant="outline"
                >
                  <FolderIcon className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedProject?.name ?? "选择工作目录"}
                  </span>
                  <ChevronDownIcon className="shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[min(34rem,80vw)]"
              >
                <DropdownMenuLabel>工作目录</DropdownMenuLabel>
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => onSelectProject(project)}
                  >
                    <FolderIcon />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    {selectedProject?.id === project.id ? <CheckIcon /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onAddProject}>
                  <FolderPlusIcon />
                  添加项目目录…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {children}
          <p className="mt-1 px-6 text-center text-muted-foreground text-xs">
            {researchMode ? "新研究任务" : "新任务"}
            会在所选目录中运行；提交消息前不会创建会话。
          </p>
        </div>
      </div>
    </div>
  );
}
