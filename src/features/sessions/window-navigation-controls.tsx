import {
  ArrowLeftIcon,
  ArrowRightIcon,
  PanelLeftIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface WindowNavigationControlsProps {
  canGoBack: boolean;
  canGoForward: boolean;
  className?: string;
  collapsed: boolean;
  macSafeArea: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onToggleSidebar: () => void;
}

export function WindowNavigationControls({
  canGoBack,
  canGoForward,
  className,
  collapsed,
  macSafeArea,
  onGoBack,
  onGoForward,
  onToggleSidebar,
}: WindowNavigationControlsProps) {
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 pr-1",
        macSafeArea ? "pl-20" : "pl-1",
        className,
      )}
      data-tauri-drag-region
    >
      <Button
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        className="text-muted-foreground hover:text-[#3a3b3c]"
        onClick={onToggleSidebar}
        size="icon"
        title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        variant="ghost"
      >
        <span
          className={cn(
            "flex size-5 items-center justify-center",
            macSafeArea && "translate-y-0.5",
          )}
        >
          <PanelLeftIcon className="size-5" />
        </span>
      </Button>
      <Button
        aria-label="返回上一个任务"
        className="text-muted-foreground hover:text-[#3a3b3c]"
        disabled={!canGoBack}
        onClick={onGoBack}
        size="icon"
        title="返回"
        variant="ghost"
      >
        <span
          className={cn(
            "flex size-5 items-center justify-center",
            macSafeArea && "translate-y-0.5",
          )}
        >
          <ArrowLeftIcon className="size-5" />
        </span>
      </Button>
      <Button
        aria-label="前往下一个任务"
        className="text-muted-foreground hover:text-[#3a3b3c]"
        disabled={!canGoForward}
        onClick={onGoForward}
        size="icon"
        title="前进"
        variant="ghost"
      >
        <span
          className={cn(
            "flex size-5 items-center justify-center",
            macSafeArea && "translate-y-0.5",
          )}
        >
          <ArrowRightIcon className="size-5" />
        </span>
      </Button>
      <div
        className="h-full min-w-3 flex-1"
        data-tauri-drag-region
      />
    </div>
  );
}
