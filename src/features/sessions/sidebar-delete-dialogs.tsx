import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import {
  type ProjectDeleteResult,
  type ProjectRecord,
  type SessionRecord,
} from "@/domain/workspace";
import { localizedSessionTitle } from "@/lib/localize";

interface SidebarDeleteDialogsProps {
  pendingDelete?: SessionRecord;
  pendingDeleteProject?: ProjectRecord;
  deletingProject: boolean;
  projectDeleteError?: string;
  onPendingDeleteChange: (session?: SessionRecord) => void;
  onPendingDeleteProjectChange: (project?: ProjectRecord) => void;
  onDeletingProjectChange: (deleting: boolean) => void;
  onProjectDeleteErrorChange: (error?: string) => void;
  onDeleteSession: (session: SessionRecord) => void;
  onDeleteProject: (project: ProjectRecord) => Promise<ProjectDeleteResult>;
}

export function SidebarDeleteDialogs({
  pendingDelete,
  pendingDeleteProject,
  deletingProject,
  projectDeleteError,
  onPendingDeleteChange,
  onPendingDeleteProjectChange,
  onDeletingProjectChange,
  onProjectDeleteErrorChange,
  onDeleteSession,
  onDeleteProject,
}: SidebarDeleteDialogsProps) {
  const deleteProject = async () => {
    if (!pendingDeleteProject || deletingProject) {
      return;
    }
    const project = pendingDeleteProject;
    onDeletingProjectChange(true);
    onProjectDeleteErrorChange(undefined);
    try {
      const result = await onDeleteProject(project);
      if (!result.deleted) {
        const message = result.error ?? "删除项目失败，请重试。";
        onProjectDeleteErrorChange(message);
        throw new Error(message);
      }
      onPendingDeleteProjectChange(undefined);
    } catch (reason) {
      if (reason instanceof Error && reason.message) {
        onProjectDeleteErrorChange(reason.message);
      } else {
        onProjectDeleteErrorChange("删除项目失败，请重试。");
      }
      throw reason;
    } finally {
      onDeletingProjectChange(false);
    }
  };

  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            onPendingDeleteChange(undefined);
          }
        }}
        open={Boolean(pendingDelete)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除任务？</DialogTitle>
            <DialogDescription>
              “{pendingDelete ? localizedSessionTitle(pendingDelete.title) : ""}
              ”及其本地对话记录将被永久删除，工作区文件不会受到影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (pendingDelete) {
                  onDeleteSession(pendingDelete);
                  onPendingDeleteChange(undefined);
                }
              }}
              variant="destructive"
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            onPendingDeleteProjectChange(undefined);
            onDeletingProjectChange(false);
            onProjectDeleteErrorChange(undefined);
          }
        }}
        open={Boolean(pendingDeleteProject)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除项目？</DialogTitle>
            <DialogDescription>
              “{pendingDeleteProject?.name ?? ""}
              ”及其本地任务记录将被永久删除，工作区文件不会受到影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <LoadingButton
              errorLabel="重试"
              onAction={deleteProject}
              pendingLabel="删除中…"
              successLabel="已删除"
              variant="destructive"
            >
              删除项目
            </LoadingButton>
          </DialogFooter>
          {projectDeleteError ? (
            <p className="text-destructive text-sm" role="alert">
              {projectDeleteError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
