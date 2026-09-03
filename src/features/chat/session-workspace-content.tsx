import {
  DownloadIcon,
  GitCompareArrowsIcon,
  PanelRightIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import {
  IconMorphIcon,
  ICON_MORPH_SHAPES,
} from "@/components/interior/icon-morph";
import { LoadingButton } from "@/components/interior/loading-button";
import { Button } from "@/components/ui/button";
import { Presence } from "@/components/ui/presence";
import { localizedSessionTitle } from "@/lib/localize";
import { cn } from "@/lib/utils";
import {
  DEFAULT_WORKSPACE_PANEL_WIDTH,
  sessionStatusLabel,
} from "./agent-workspace-utils";
import { AgentTimeline } from "./agent-timeline";
import { SessionStatsLine } from "./session-stats-line";
import { SubagentTray } from "./subagent-tray";
import { TrajectoryView } from "./trajectory-view";
import { WorkspacePanelLayer } from "./workspace-panel-layer";
import type { AgentWorkspaceViewProps } from "./agent-workspace-view-types";

export function SessionWorkspaceContent(props: AgentWorkspaceViewProps) {
  const {
    activeProject,
    activeSession,
    activeWorkspaceTabId,
    acpPhase,
    appUpdate,
    appUpdateProgress,
    availableModels,
    chatDockRef,
    chatDockSpace,
    chatStatus,
    contextUsage,
    conversationView,
    cwd,
    git,
    handleSessionTabKeyDown,
    installAppUpdate,
    installingUpdate,
    isMacOS,
    onCloseWorkspaceTab,
    onNewWorkspaceToolTab,
    onOpenFilePreview,
    onOpenGit,
    onOpenProjectReference,
    onOpenSubagent,
    onSubmitPrompt,
    onToggleSessionInfo,
    onToggleWorkspacePanel,
    renderComposer,
    resolvePermission,
    resolvePlan,
    resolveQuestion,
    selectedModelId,
    sessionInfoLayoutOpen,
    sessionInfoOpen,
    sessionInfoSurfaceOpen,
    sessionIsActive,
    setActiveWorkspaceTabId,
    setConversationView,
    sidebarCollapsed,
    status,
    subagents,
    timeline,
    updateWorkspacePanelWidth,
    visibleError,
    visibleSubagents,
    workspacePanelOpen,
    workspacePanelResize,
    workspacePanelWidth,
    workspacePanelWidthRef,
    workspaceTabs,
    beginWorkspacePanelResize,
  } = props;

  return (
    <>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "harness-session-header sidebar-aware-header flex shrink-0 flex-col items-stretch pr-6",
            sidebarCollapsed ? (isMacOS ? "pl-52" : "pl-32") : "pl-6",
          )}
          data-tauri-drag-region
        >
          <div className="harness-session-title-row" data-tauri-drag-region>
            <div
              className="flex min-w-0 items-center gap-2"
              data-tauri-drag-region
            >
              <h1
                className="min-w-0 truncate font-semibold text-base"
                data-tauri-drag-region
              >
                {activeSession
                  ? localizedSessionTitle(activeSession.title)
                  : "正在打开工作区…"}
              </h1>
              <div className="harness-session-status" data-tauri-drag-region>
                <span
                  aria-hidden="true"
                  className="motion-status-dot size-1.5 rounded-full bg-current"
                  data-active={sessionIsActive ? "true" : undefined}
                  data-tauri-drag-region
                />
                {sessionStatusLabel(status.phase, acpPhase)}
              </div>
            </div>
            <div className="harness-session-actions">
              <Button
                aria-label={
                  git.loading ? "正在检查更改" : `${git.changes.length} 项更改`
                }
                className="gap-1 px-2"
                onClick={onOpenGit}
                size="sm"
                title={
                  git.loading ? "正在检查更改" : `${git.changes.length} 项更改`
                }
                variant="outline"
              >
                <GitCompareArrowsIcon data-icon="inline-start" />
                <span className="min-w-2 text-center tabular-nums">
                  {git.loading ? "…" : git.changes.length}
                </span>
              </Button>
              {appUpdate?.available ? (
                <div
                  className="motion-view-enter flex items-center gap-2"
                  title={
                    installingUpdate
                      ? appUpdateProgress?.phase === "installing"
                        ? "正在安装并重启…"
                        : "正在下载更新…"
                      : undefined
                  }
                >
                  <LoadingButton
                    disabled={installingUpdate}
                    errorLabel="重试"
                    icon={<DownloadIcon />}
                    onAction={installAppUpdate}
                    pendingLabel={
                      appUpdateProgress?.phase === "installing"
                        ? "正在安装并重启…"
                        : "正在下载更新…"
                    }
                    successLabel="更新完成"
                    variant="outline"
                  >
                    {`更新到 ${appUpdate.version}`}
                  </LoadingButton>
                </div>
              ) : null}
              <Button
                aria-label={sessionInfoOpen ? "收起会话信息" : "展开会话信息"}
                aria-pressed={sessionInfoOpen}
                onClick={onToggleSessionInfo}
                size="icon"
                title={sessionInfoOpen ? "收起会话信息" : "展开会话信息"}
                variant={sessionInfoOpen ? "secondary" : "ghost"}
              >
                <IconMorphIcon
                  active={sessionInfoOpen}
                  shapes={ICON_MORPH_SHAPES.filterClose}
                  size={16}
                  strokeWidth={1.8}
                />
              </Button>
              <Button
                aria-label={
                  workspacePanelOpen ? "收起右侧边栏" : "展开右侧边栏"
                }
                aria-pressed={workspacePanelOpen}
                onClick={onToggleWorkspacePanel}
                size="icon"
                title={workspacePanelOpen ? "收起右侧边栏" : "展开右侧边栏"}
                variant={workspacePanelOpen ? "secondary" : "ghost"}
              >
                <PanelRightIcon />
              </Button>
            </div>
          </div>
        </header>
        <div className="harness-session-surface">
          <nav
            aria-label="会话视图"
            aria-orientation="horizontal"
            className={cn(
              "harness-session-tabs sidebar-aware-tabs",
              sidebarCollapsed
                ? isMacOS
                  ? "pl-[216px]"
                  : "pl-[136px]"
                : "pl-8",
            )}
            role="tablist"
          >
            <button
              aria-controls="session-view-panel"
              aria-selected={conversationView === "chat"}
              className={cn(
                "harness-session-tab",
                conversationView === "chat" && "is-active",
              )}
              id="session-view-tab-chat"
              onClick={() => setConversationView("chat")}
              onKeyDown={handleSessionTabKeyDown}
              role="tab"
              tabIndex={conversationView === "chat" ? 0 : -1}
              type="button"
            >
              对话
            </button>
            <button
              aria-controls="session-view-panel"
              aria-selected={conversationView === "trajectory"}
              className={cn(
                "harness-session-tab",
                conversationView === "trajectory" && "is-active",
              )}
              id="session-view-tab-trajectory"
              onClick={() => setConversationView("trajectory")}
              onKeyDown={handleSessionTabKeyDown}
              role="tab"
              tabIndex={conversationView === "trajectory" ? 0 : -1}
              type="button"
            >
              轨迹
            </button>
          </nav>
          <Presence present={Boolean(visibleError)}>
            {(motionState) => (
              <div
                aria-live="polite"
                className="motion-banner border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
                data-motion-state={motionState}
                role="alert"
              >
                {visibleError}
              </div>
            )}
          </Presence>

          <div
            className="harness-chat-layout"
            data-session-info-layout-open={sessionInfoLayoutOpen}
            style={
              {
                "--harness-chat-dock-space": `${chatDockSpace}px`,
              } as CSSProperties
            }
          >
            <div
              aria-labelledby={`session-view-tab-${conversationView}`}
              className="relative flex min-w-0 flex-1 flex-col"
              id="session-view-panel"
              role="tabpanel"
            >
              {conversationView === "chat" ? (
                <AgentTimeline
                  cwd={cwd}
                  entries={timeline}
                  onPermission={resolvePermission}
                  onQuestion={resolveQuestion}
                  onPlanDecision={resolvePlan}
                  onOpenFile={onOpenFilePreview}
                  onOpenProjectReference={onOpenProjectReference}
                  projectRoot={activeProject?.path ?? cwd}
                  turnRunning={
                    chatStatus === "submitted" || chatStatus === "streaming"
                  }
                />
              ) : (
                <TrajectoryView
                  entries={timeline}
                  running={
                    chatStatus === "submitted" || chatStatus === "streaming"
                  }
                />
              )}
            </div>
            <aside
              aria-hidden={!sessionInfoOpen}
              aria-label="会话信息"
              className="harness-session-info-panel"
              data-layout-open={sessionInfoLayoutOpen}
              inert={!sessionInfoOpen}
            >
              <div
                className="harness-session-info-surface"
                data-open={sessionInfoSurfaceOpen}
              >
                <div className="harness-session-info-header">
                  <span>会话信息</span>
                </div>
                <div className="harness-session-info-body harness-session-info-body--ledger">
                  <section className="harness-session-info-section">
                    <SubagentTray
                      className="!mx-0 !max-w-none !justify-start !px-0 !pb-0"
                      onOpenSubagent={onOpenSubagent}
                      subagents={visibleSubagents}
                    />
                  </section>
                  <section className="harness-session-info-section">
                    <SessionStatsLine
                      contextUsage={contextUsage}
                      entries={timeline}
                      modelName={
                        availableModels.find(
                          (model) => model.id === selectedModelId,
                        )?.name
                      }
                    />
                  </section>
                </div>
              </div>
            </aside>
            <div className="harness-chat-bottom-dock" ref={chatDockRef}>
              {renderComposer(onSubmitPrompt)}
            </div>
          </div>
        </div>
      </div>
      <WorkspacePanelLayer
        activeTabId={activeWorkspaceTabId}
        changes={git.changes}
        cwd={cwd}
        error={git.error}
        loading={git.loading}
        onActivateTab={setActiveWorkspaceTabId}
        onCloseTab={onCloseWorkspaceTab}
        onNewTab={onNewWorkspaceToolTab}
        onOpenFile={onOpenFilePreview}
        onOpenProjectReference={onOpenProjectReference}
        onRefreshGit={() => git.refresh()}
        onResetWidth={() =>
          updateWorkspacePanelWidth(DEFAULT_WORKSPACE_PANEL_WIDTH)
        }
        onResizeBy={(delta) =>
          updateWorkspacePanelWidth(workspacePanelWidthRef.current + delta)
        }
        onResizeStart={beginWorkspacePanelResize}
        open={workspacePanelOpen}
        panelWidth={workspacePanelWidth}
        root={activeProject?.path ?? cwd}
        resizing={workspacePanelResize}
        subagents={subagents}
        tabs={workspaceTabs}
      />
    </>
  );
}
