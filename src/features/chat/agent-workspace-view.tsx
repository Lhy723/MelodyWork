import { AnimatePresence } from "motion/react";

import { MotionPage } from "@/components/motion/page-transition";
import { AppSidebar } from "@/features/sessions/app-sidebar";
import { WindowNavigationControls } from "@/features/sessions/window-navigation-controls";
import { ResearchMainWorkspace } from "@/features/research/research-main-workspace";
import { SettingsWorkspace } from "@/features/settings/settings-workspace";
import { cn } from "@/lib/utils";
import { DEFAULT_SIDEBAR_WIDTH } from "./agent-workspace-utils";
import { NewTaskWorkspace } from "./new-task-workspace";
import { SessionWorkspaceContent } from "./session-workspace-content";
import { WorkspaceStartScreen } from "./workspace-start-screen";
import type { AgentWorkspaceViewProps } from "./agent-workspace-view-types";

export function AgentWorkspaceView(props: AgentWorkspaceViewProps) {
  const {
    activeProject,
    activeSession,
    canGoBack,
    canGoForward,
    cwd,
    defaultIndependentChat,
    goThroughSessionHistory,
    independentProject,
    isMacOS,
    nativeVibrancyEnabled,
    newTaskOpen,
    newTaskProject,
    needsWorkspace,
    onAddProject,
    onArchiveProject,
    onChooseWorkspace,
    onCloseResearchDetail,
    onCloseSettings,
    onCreateTaskFromPrompt,
    onDeleteProject,
    onDeleteSession,
    onModeChange,
    onNewTaskCancel,
    onOpenGit,
    onOpenResearchPaper,
    onOpenResearchSection,
    onOpenResearchTrackingTopic,
    onOpenSettings,
    onRestoreProject,
    onSelectProject,
    onSelectSession,
    onToggleSidebar,
    onUseIndependentTask,
    openResearchAskPaper,
    primaryViewKey,
    projects,
    researchDetail,
    researchMainOpen,
    researchSection,
    runningSessions,
    sessionsByProject,
    setNewTaskOpen,
    setNewTaskProjectId,
    setResearchMainOpen,
    setWorkspacePanelOpen,
    settingsOpen,
    settingsPage,
    sidebarCollapsed,
    sidebarResize,
    sidebarWidth,
    sidebarWidthRef,
    updateSidebarWidth,
    workspaceError,
    workspaceLoading,
    workspaceMode,
    beginSidebarResize,
  } = props;

  return (
    <main
      className={cn(
        "relative flex h-svh min-h-0 overflow-hidden text-foreground",
        nativeVibrancyEnabled ? "bg-transparent" : "bg-background",
      )}
    >
      {!settingsOpen ? (
        <WindowNavigationControls
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          className="absolute top-0 left-0 z-50"
          collapsed={sidebarCollapsed}
          macSafeArea={isMacOS}
          onGoBack={() => goThroughSessionHistory(-1)}
          onGoForward={() => goThroughSessionHistory(1)}
          onToggleSidebar={onToggleSidebar}
        />
      ) : null}
      <div
        aria-hidden={sidebarCollapsed || settingsOpen}
        className="sidebar-shell"
        data-collapsed={sidebarCollapsed || settingsOpen}
        data-resizing={Boolean(sidebarResize)}
        inert={sidebarCollapsed || settingsOpen}
        style={{
          width: sidebarCollapsed || settingsOpen ? 0 : sidebarWidth,
        }}
      >
        <AppSidebar
          activeProject={activeProject}
          activeResearchSection={researchSection}
          activeSessionId={settingsOpen ? undefined : activeSession?.id}
          loading={workspaceLoading}
          onArchiveProject={(project) => void onArchiveProject(project)}
          onDeleteProject={onDeleteProject}
          onDeleteSession={(session) => void onDeleteSession(session)}
          onModeChange={onModeChange}
          onNewSession={(project) => {
            onCloseSettings();
            setResearchMainOpen(false);
            setWorkspacePanelOpen(false);
            const initialProject =
              project ??
              (defaultIndependentChat
                ? (independentProject ?? activeProject)
                : activeProject);
            setNewTaskProjectId(initialProject?.id);
            setNewTaskOpen(true);
          }}
          onOpenExtensions={() => onOpenSettings("skills")}
          onOpenGit={onOpenGit}
          onOpenSettings={() => onOpenSettings()}
          onResetWidth={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          onResizeBy={(delta) =>
            updateSidebarWidth(sidebarWidthRef.current + delta)
          }
          onResizeStart={beginSidebarResize}
          onRestoreProject={(project) => void onRestoreProject(project)}
          onSelectProject={(project) => {
            onCloseSettings();
            setNewTaskOpen(false);
            void onSelectProject(project);
          }}
          onSelectSession={(session) => {
            onCloseSettings();
            setNewTaskOpen(false);
            onSelectSession(session);
          }}
          onSelectResearchSection={onOpenResearchSection}
          projects={projects}
          runningSessions={runningSessions}
          settingsActive={settingsOpen}
          sessionsByProject={sessionsByProject}
          sidebarWidth={sidebarWidth}
          workspaceMode={workspaceMode}
        />
      </div>
      <section
        className="workspace-stage relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
        data-settings-open={settingsOpen ? "true" : "false"}
      >
        <AnimatePresence initial={false} mode="wait">
          {settingsOpen ? (
            <MotionPage
              className="absolute inset-0 flex min-h-0 flex-col"
              key="settings"
            >
              <SettingsWorkspace
                cwd={cwd}
                initialPage={settingsPage}
                macSafeArea={isMacOS}
                onClose={onCloseSettings}
                projectId={activeProject?.id ?? "preview-project"}
                projectName={activeProject?.name}
              />
            </MotionPage>
          ) : (
            <MotionPage
              className="absolute inset-0 flex min-h-0"
              key={`workspace:${primaryViewKey}`}
            >
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                {newTaskOpen ? (
                  <NewTaskWorkspace
                    mode={workspaceMode}
                    onAddProject={() => {
                      void onAddProject().then((project) => {
                        if (project) {
                          setNewTaskProjectId(project.id);
                        }
                      });
                    }}
                    onCancel={onNewTaskCancel}
                    onSelectProject={(project) =>
                      setNewTaskProjectId(project.id)
                    }
                    projects={projects}
                    selectedProject={newTaskProject}
                  >
                    {props.renderComposer(onCreateTaskFromPrompt)}
                  </NewTaskWorkspace>
                ) : !activeSession ? (
                  <WorkspaceStartScreen
                    canUseIndependentTask={Boolean(independentProject)}
                    error={workspaceError}
                    loading={workspaceLoading}
                    needsWorkspace={needsWorkspace}
                    onChooseWorkspace={onChooseWorkspace}
                    onUseIndependentTask={onUseIndependentTask}
                  />
                ) : workspaceMode === "research" &&
                  researchMainOpen &&
                  researchSection !== "skills" ? (
                  <ResearchMainWorkspace
                    cwd={cwd}
                    detail={researchDetail}
                    kind={researchSection}
                    onAskPaper={openResearchAskPaper}
                    onCloseDetail={onCloseResearchDetail}
                    onNavigate={onOpenResearchSection}
                    onOpenPaper={onOpenResearchPaper}
                    onOpenTrackingTopic={onOpenResearchTrackingTopic}
                    projectId={activeProject?.id}
                    projectName={activeProject?.name ?? "未选择项目"}
                    root={activeProject?.path ?? cwd}
                  />
                ) : (
                  <SessionWorkspaceContent {...props} />
                )}
              </div>
            </MotionPage>
          )}
        </AnimatePresence>
      </section>
    </main>
  );
}
