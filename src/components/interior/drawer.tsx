"use client";

import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
} from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DrawerSide = "left" | "right";

export interface DrawerProps {
  children?: ReactNode;
  className?: string;
  closeLabel?: string;
  description?: ReactNode;
  dismissOnScrimClick?: boolean;
  dismissRatio?: number;
  footer?: ReactNode;
  container?: HTMLElement | null;
  modal?: boolean;
  onExitComplete?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  side?: DrawerSide;
  title: ReactNode;
  width?: number | string;
}

const DRAWER_SPRING = {
  type: "spring",
  stiffness: 380,
  damping: 36,
  mass: 0.82,
} as const;
const INSTANT = { duration: 0 } as const;

const toCssLength = (value: number | string) =>
  typeof value === "number" ? `${value}px` : value;

/**
 * Interior-inspired side panel for focused editing workflows.
 *
 * Radix owns the dialog semantics, focus management, Escape handling and
 * scroll locking. Motion adds the side entrance and a header-only swipe to
 * dismiss so fields inside the panel remain easy to interact with.
 */
export function Drawer({
  children,
  className,
  closeLabel = "关闭",
  container,
  description,
  dismissOnScrimClick = true,
  dismissRatio = 0.38,
  footer,
  modal = true,
  onExitComplete,
  onOpenChange,
  open,
  side = "right",
  title,
  width = 560,
}: DrawerProps) {
  const reducedMotion = useReducedMotion();
  const dragControls = useDragControls();
  const panelRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  const closedOffset = side === "right" ? "100%" : "-100%";

  useEffect(() => {
    if (open) {
      setPresent(true);
    } else if (present) {
      setPresent(false);
    }
  }, [open, present]);

  const startHeaderDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("button, a, input, textarea, select, [role='button']")
      ) {
        return;
      }
      dragControls.start(event);
    },
    [dragControls],
  );

  const finishDrag = useCallback(
    (
      _event: MouseEvent | TouchEvent | PointerEvent,
      info: { offset: { x: number }; velocity: { x: number } },
    ) => {
      const widthInPixels =
        panelRef.current?.getBoundingClientRect().width ?? 560;
      const distance = info.offset.x;
      const velocity = info.velocity.x;
      const dismissDirection = side === "right" ? distance > 0 : distance < 0;
      const velocityDirection = side === "right" ? velocity > 0 : velocity < 0;
      const farEnough = Math.abs(distance) >= widthInPixels * dismissRatio;
      const fastEnough = Math.abs(velocity) >= 900;

      if (
        (dismissDirection && farEnough) ||
        (velocityDirection && fastEnough)
      ) {
        onOpenChange(false);
      }
    },
    [dismissRatio, onOpenChange, side],
  );

  return (
    <DialogPrimitive.Root modal={modal} onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal container={container ?? undefined} forceMount>
        <AnimatePresence
          onExitComplete={() => {
            if (!open) onExitComplete?.();
          }}
        >
          {present ? (
            <DialogPrimitive.Overlay asChild forceMount key="overlay">
              <motion.div
                animate={{ opacity: 1 }}
                className="motion-drawer-overlay fixed inset-0 isolate z-50 bg-black/24 supports-backdrop-filter:backdrop-blur-xs"
                exit={{ opacity: 0 }}
                initial={{ opacity: 0 }}
                transition={reducedMotion ? INSTANT : { duration: 0.2 }}
              />
            </DialogPrimitive.Overlay>
          ) : null}

          {present ? (
            <DialogPrimitive.Content
              asChild
              forceMount
              key="content"
              onInteractOutside={(event) => {
                if (!dismissOnScrimClick) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (!dismissOnScrimClick) event.preventDefault();
              }}
            >
              <motion.div
                animate={{ x: 0 }}
                className={cn(
                  "motion-drawer-content fixed inset-y-0 z-50 flex h-[100dvh] max-w-[calc(100vw-2rem)] flex-col overflow-hidden border-border/70 bg-popover text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-none",
                  side === "right"
                    ? "right-0 rounded-l-2xl border-y border-l"
                    : "left-0 rounded-r-2xl border-y border-r",
                  className,
                )}
                data-side={side}
                drag={reducedMotion ? false : "x"}
                dragControls={dragControls}
                dragElastic={0.08}
                dragListener={false}
                dragMomentum={false}
                exit={{ x: closedOffset }}
                initial={{ x: closedOffset }}
                onDragEnd={finishDrag}
                ref={panelRef}
                style={{
                  width: `min(${toCssLength(width)}, calc(100vw - 2rem))`,
                }}
                transition={reducedMotion ? INSTANT : DRAWER_SPRING}
              >
                <header
                  className="relative flex shrink-0 cursor-grab items-start justify-between gap-4 px-6 pt-6 pb-4 active:cursor-grabbing"
                  onPointerDown={startHeaderDrag}
                >
                  <div className="min-w-0 space-y-1.5 pr-8">
                    <DialogPrimitive.Title className="font-heading text-base font-semibold leading-tight">
                      {title}
                    </DialogPrimitive.Title>
                    {description ? (
                      <DialogPrimitive.Description className="text-muted-foreground text-sm leading-relaxed">
                        {description}
                      </DialogPrimitive.Description>
                    ) : null}
                  </div>
                  <DialogPrimitive.Close asChild>
                    <Button
                      aria-label={closeLabel}
                      className="absolute top-4 right-4"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon />
                      <span className="sr-only">{closeLabel}</span>
                    </Button>
                  </DialogPrimitive.Close>
                </header>

                {children ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                    {children}
                  </div>
                ) : null}

                {footer ? (
                  <footer className="flex shrink-0 flex-col-reverse gap-2 border-border/70 border-t bg-muted/20 px-6 py-4 sm:flex-row sm:justify-end">
                    {footer}
                  </footer>
                ) : null}
              </motion.div>
            </DialogPrimitive.Content>
          ) : null}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
