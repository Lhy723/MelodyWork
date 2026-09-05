import { HoldToConfirm } from "@/components/interior/hold-to-confirm";
import { Modal } from "@/components/interior/modal";
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
      <Modal
        description={`“${pendingDelete ? localizedSessionTitle(pendingDelete.title) : ""}”及其本地对话记录将被永久删除，工作区文件不会受到影响。`}
        footer={
          <>
            <Button
              onClick={() => onPendingDeleteChange(undefined)}
              variant="outline"
            >
              取消
            </Button>
            <HoldToConfirm
              onConfirm={() => {
                if (pendingDelete) {
                  onDeleteSession(pendingDelete);
                  onPendingDeleteChange(undefined);
                }
              }}
              size="default"
              variant="destructive"
            >
              删除
            </HoldToConfirm>
          </>
        }
        onClose={() => onPendingDeleteChange(undefined)}
        open={Boolean(pendingDelete)}
        title="删除任务？"
      />

      <Modal
        description={`“${pendingDeleteProject?.name ?? ""}”及其本地任务记录将被永久删除，工作区文件不会受到影响。`}
        footer={
          <>
            <Button
              disabled={deletingProject}
              onClick={() => {
                onPendingDeleteProjectChange(undefined);
                onDeletingProjectChange(false);
                onProjectDeleteErrorChange(undefined);
              }}
              variant="outline"
            >
              取消
            </Button>
            <HoldToConfirm
              confirmLabel={deletingProject ? "删除中…" : "已删除"}
              disabled={deletingProject}
              onConfirm={deleteProject}
              variant="destructive"
            >
              删除项目
            </HoldToConfirm>
          </>
        }
        onClose={() => {
          onPendingDeleteProjectChange(undefined);
          onDeletingProjectChange(false);
          onProjectDeleteErrorChange(undefined);
        }}
        open={Boolean(pendingDeleteProject)}
        title="删除项目？"
      >
        {projectDeleteError ? (
          <p className="text-destructive text-sm" role="alert">
            {projectDeleteError}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
