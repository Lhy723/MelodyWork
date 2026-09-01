import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { AppUpdateStatus } from "@/lib/melody-bridge";
import { checkAppUpdate } from "@/lib/melody-bridge";
import type { UpdateChannel } from "@/stores/app-settings-store";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
  SESSION_INFO_MOTION_MS,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  WORKSPACE_PANEL_WIDTH_STORAGE_KEY,
  maxWorkspacePanelWidth,
} from "./agent-workspace-utils";

type ResizeState = { startWidth: number; startX: number };

type WorkspaceLayoutOptions = {
  autoCheckForUpdates: boolean;
  updateChannel: UpdateChannel;
  setAppUpdate: Dispatch<SetStateAction<AppUpdateStatus | undefined>>;
  setInstallingUpdate?: Dispatch<SetStateAction<boolean>>;
  chatDockRef: RefObject<HTMLDivElement | null>;
  setChatDockSpace: Dispatch<SetStateAction<number>>;
  sessionInfoOpen: boolean;
  setSessionInfoOpen: Dispatch<SetStateAction<boolean>>;
  setSessionInfoLayoutOpen: Dispatch<SetStateAction<boolean>>;
  setSessionInfoSurfaceOpen: Dispatch<SetStateAction<boolean>>;
  sessionInfoCloseTimerRef: { current: number | undefined };
  sessionInfoOpenFrameRef: { current: number | undefined };
  sidebarResize?: ResizeState;
  setSidebarResize: Dispatch<SetStateAction<ResizeState | undefined>>;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  sidebarWidthRef: { current: number };
  workspacePanelResize?: ResizeState;
  setWorkspacePanelResize: Dispatch<SetStateAction<ResizeState | undefined>>;
  setWorkspacePanelOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspacePanelWidth: Dispatch<SetStateAction<number>>;
  workspacePanelWidthRef: { current: number };
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
};

export function useAgentWorkspaceLayout({
  autoCheckForUpdates,
  updateChannel,
  setAppUpdate,
  chatDockRef,
  setChatDockSpace,
  sessionInfoOpen,
  setSessionInfoOpen,
  setSessionInfoLayoutOpen,
  setSessionInfoSurfaceOpen,
  sessionInfoCloseTimerRef,
  sessionInfoOpenFrameRef,
  sidebarResize,
  setSidebarResize,
  setSidebarWidth,
  sidebarWidthRef,
  workspacePanelResize,
  setWorkspacePanelResize,
  setWorkspacePanelOpen,
  setWorkspacePanelWidth,
  workspacePanelWidthRef,
  setSidebarCollapsed,
}: WorkspaceLayoutOptions) {
  const setSidebarVisibility = useCallback(
    (collapsed: boolean) => {
      setSidebarCollapsed(collapsed);
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(collapsed),
      );
    },
    [setSidebarCollapsed],
  );

  const toggleSessionInfo = useCallback(() => {
    if (sessionInfoCloseTimerRef.current !== undefined) {
      window.clearTimeout(sessionInfoCloseTimerRef.current);
      sessionInfoCloseTimerRef.current = undefined;
    }
    if (sessionInfoOpenFrameRef.current !== undefined) {
      window.cancelAnimationFrame(sessionInfoOpenFrameRef.current);
      sessionInfoOpenFrameRef.current = undefined;
    }

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (sessionInfoOpen) {
      setSessionInfoOpen(false);
      setSessionInfoSurfaceOpen(false);
      if (reduceMotion) {
        setSessionInfoLayoutOpen(false);
      } else {
        sessionInfoCloseTimerRef.current = window.setTimeout(() => {
          setSessionInfoLayoutOpen(false);
          sessionInfoCloseTimerRef.current = undefined;
        }, SESSION_INFO_MOTION_MS);
      }
      return;
    }

    setSessionInfoLayoutOpen(true);
    setSessionInfoOpen(true);
    setSessionInfoSurfaceOpen(false);
    if (reduceMotion) {
      setSessionInfoSurfaceOpen(true);
      return;
    }
    sessionInfoOpenFrameRef.current = window.requestAnimationFrame(() => {
      sessionInfoOpenFrameRef.current = window.requestAnimationFrame(() => {
        setSessionInfoSurfaceOpen(true);
        sessionInfoOpenFrameRef.current = undefined;
      });
    });
  }, [
    sessionInfoCloseTimerRef,
    sessionInfoOpen,
    sessionInfoOpenFrameRef,
    setSessionInfoLayoutOpen,
    setSessionInfoOpen,
    setSessionInfoSurfaceOpen,
  ]);

  useEffect(() => {
    return () => {
      if (sessionInfoCloseTimerRef.current !== undefined) {
        window.clearTimeout(sessionInfoCloseTimerRef.current);
      }
      if (sessionInfoOpenFrameRef.current !== undefined) {
        window.cancelAnimationFrame(sessionInfoOpenFrameRef.current);
      }
    };
  }, [sessionInfoCloseTimerRef, sessionInfoOpenFrameRef]);

  useEffect(() => {
    if (!autoCheckForUpdates) {
      setAppUpdate(undefined);
      return;
    }
    setAppUpdate(undefined);
    let active = true;
    void checkAppUpdate(updateChannel)
      .then((update) => {
        if (active) {
          setAppUpdate(update);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [autoCheckForUpdates, setAppUpdate, updateChannel]);

  useEffect(() => {
    const dock = chatDockRef.current;
    if (!dock || typeof ResizeObserver === "undefined") {
      return;
    }
    const updateDockSpace = () => {
      setChatDockSpace(Math.ceil(dock.getBoundingClientRect().height) + 16);
    };
    const observer = new ResizeObserver(updateDockSpace);
    observer.observe(dock);
    updateDockSpace();
    return () => observer.disconnect();
  }, [chatDockRef, setChatDockSpace]);

  useEffect(() => {
    if (!sidebarResize) {
      return;
    }
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    const handlePointerMove = (event: PointerEvent) => {
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(
          MIN_SIDEBAR_WIDTH,
          sidebarResize.startWidth + event.clientX - sidebarResize.startX,
        ),
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };
    const handlePointerUp = () => {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(Math.round(sidebarWidthRef.current)),
      );
      setSidebarResize(undefined);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [sidebarResize, setSidebarResize, setSidebarWidth, sidebarWidthRef]);

  useEffect(() => {
    if (!workspacePanelResize) {
      return;
    }
    const previousCursor = document.documentElement.style.cursor;
    const previousUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    const handlePointerMove = (event: PointerEvent) => {
      const nextWidth = Math.min(
        maxWorkspacePanelWidth(),
        Math.max(
          MIN_WORKSPACE_PANEL_WIDTH,
          workspacePanelResize.startWidth +
            workspacePanelResize.startX -
            event.clientX,
        ),
      );
      workspacePanelWidthRef.current = nextWidth;
      setWorkspacePanelWidth(nextWidth);
    };
    const handlePointerUp = () => {
      window.localStorage.setItem(
        WORKSPACE_PANEL_WIDTH_STORAGE_KEY,
        String(Math.round(workspacePanelWidthRef.current)),
      );
      setWorkspacePanelResize(undefined);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
    return () => {
      document.documentElement.style.cursor = previousCursor;
      document.documentElement.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [
    setWorkspacePanelResize,
    setWorkspacePanelWidth,
    workspacePanelResize,
    workspacePanelWidthRef,
  ]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 720px)");
    const collapseForSmallViewport = () => {
      if (mediaQuery.matches) {
        setSidebarVisibility(true);
        setSessionInfoOpen(false);
        setSessionInfoLayoutOpen(false);
        setSessionInfoSurfaceOpen(false);
        setWorkspacePanelOpen(false);
        setWorkspacePanelResize(undefined);
      }
    };
    collapseForSmallViewport();
    mediaQuery.addEventListener("change", collapseForSmallViewport);
    return () =>
      mediaQuery.removeEventListener("change", collapseForSmallViewport);
  }, [
    setSessionInfoLayoutOpen,
    setSessionInfoOpen,
    setSessionInfoSurfaceOpen,
    setSidebarVisibility,
    setWorkspacePanelResize,
    setWorkspacePanelOpen,
  ]);

  return { setSidebarVisibility, toggleSessionInfo };
}
