import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ModalProps {
  children?: React.ReactNode;
  className?: string;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  container?: HTMLElement | null;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  lockScroll?: boolean;
  maxHeight?: number | string;
  maxWidth?: number | string;
  onClose: () => void;
  open: boolean;
  showClose?: boolean;
  title: React.ReactNode;
}

const toCssLength = (value: number | string | undefined) =>
  typeof value === "number" ? `${value}px` : value;

/**
 * Interior-inspired modal surface for ordinary business dialogs.
 *
 * Radix still owns the difficult accessibility pieces (focus trapping,
 * announcement semantics and scroll locking); this adapter centralises the
 * visual treatment and the controlled close behavior used by MelodyWork.
 */
export function Modal({
  children,
  className,
  closeLabel = "关闭",
  closeOnBackdrop = true,
  closeOnEscape = true,
  container,
  description,
  footer,
  initialFocusRef,
  lockScroll = true,
  maxHeight,
  maxWidth,
  onClose,
  open,
  showClose = true,
  title,
}: ModalProps) {
  return (
    <DialogPrimitive.Root
      modal={lockScroll}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      open={open}
    >
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Overlay className="motion-dialog-overlay fixed inset-0 isolate z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs" />
        <DialogPrimitive.Content
          className={cn(
            "motion-dialog-content fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-none",
            !maxHeight && "max-h-[calc(100vh-2rem)]",
            className,
          )}
          onEscapeKeyDown={(event) => {
            if (!closeOnEscape) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!closeOnBackdrop) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            if (initialFocusRef?.current) {
              event.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          onPointerDownOutside={(event) => {
            if (!closeOnBackdrop) event.preventDefault();
          }}
          style={{
            maxHeight: toCssLength(maxHeight),
            maxWidth: toCssLength(maxWidth),
          }}
        >
          <header className="relative shrink-0 space-y-1.5 px-6 pt-6 pb-4">
            <DialogPrimitive.Title className="font-heading text-base font-semibold leading-tight">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-muted-foreground text-sm leading-relaxed">
                {description}
              </DialogPrimitive.Description>
            ) : null}
            {showClose ? (
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
            ) : null}
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
