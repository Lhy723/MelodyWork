"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

export type PopoverSide = "top" | "right" | "bottom" | "left";
export type PopoverAlign = "start" | "center" | "end";

type PopoverBoundary =
  RefObject<HTMLElement | null> | HTMLElement | null | undefined;

export interface PopoverProps {
  align?: PopoverAlign;
  arrowSize?: number;
  boundary?: PopoverBoundary;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
  label: string;
  offset?: number;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  padding?: number;
  contentRole?: "dialog" | "listbox";
  side?: PopoverSide;
  trigger: ReactNode;
  triggerAriaHaspopup?: "dialog" | "listbox" | "menu";
  triggerAriaLabel?: string;
  triggerAsChild?: boolean;
  triggerClassName?: string;
}

type PopoverPosition = {
  left: number;
  side: PopoverSide;
  top: number;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

const getBoundaryRect = (boundary: PopoverBoundary) => {
  if (!boundary) return null;
  const element = "current" in boundary ? boundary.current : boundary;
  return element?.getBoundingClientRect() ?? null;
};

const getAlignedStart = (
  anchorStart: number,
  anchorSize: number,
  contentSize: number,
  align: PopoverAlign,
) => {
  if (align === "start") return anchorStart;
  if (align === "end") return anchorStart + anchorSize - contentSize;
  return anchorStart + (anchorSize - contentSize) / 2;
};

const getPositionForSide = ({
  anchor,
  align,
  content,
  offset,
  side,
}: {
  anchor: DOMRect;
  align: PopoverAlign;
  content: DOMRect;
  offset: number;
  side: PopoverSide;
}) => {
  switch (side) {
    case "top":
      return {
        left: getAlignedStart(anchor.left, anchor.width, content.width, align),
        top: anchor.top - content.height - offset,
      };
    case "right":
      return {
        left: anchor.right + offset,
        top: getAlignedStart(anchor.top, anchor.height, content.height, align),
      };
    case "left":
      return {
        left: anchor.left - content.width - offset,
        top: getAlignedStart(anchor.top, anchor.height, content.height, align),
      };
    case "bottom":
    default:
      return {
        left: getAlignedStart(anchor.left, anchor.width, content.width, align),
        top: anchor.bottom + offset,
      };
  }
};

const getAvailableSpace = (anchor: DOMRect, boundary: DOMRect) => ({
  bottom: boundary.bottom - anchor.bottom,
  left: anchor.left - boundary.left,
  right: boundary.right - anchor.right,
  top: anchor.top - boundary.top,
});

const oppositeSide: Record<PopoverSide, PopoverSide> = {
  bottom: "top",
  left: "right",
  right: "left",
  top: "bottom",
};

const getFallbackSide = (
  preferred: PopoverSide,
  anchor: DOMRect,
  content: DOMRect,
  boundary: DOMRect,
) => {
  const available = getAvailableSpace(anchor, boundary);
  const preferredSize =
    preferred === "left" || preferred === "right"
      ? content.width
      : content.height;
  if (available[preferred] >= preferredSize) return preferred;
  const opposite = oppositeSide[preferred];
  const oppositeSize =
    opposite === "left" || opposite === "right"
      ? content.width
      : content.height;
  if (available[opposite] >= oppositeSize) {
    return opposite;
  }

  const candidates = (Object.keys(available) as PopoverSide[]).sort(
    (first, second) => {
      const firstSize =
        first === "left" || first === "right" ? content.width : content.height;
      const secondSize =
        second === "left" || second === "right"
          ? content.width
          : content.height;
      return (
        available[second] / Math.max(1, secondSize) -
        available[first] / Math.max(1, firstSize)
      );
    },
  );
  return candidates[0] ?? preferred;
};

const getViewportBoundary = () =>
  new DOMRect(0, 0, window.innerWidth, window.innerHeight);

const getAnimationOffset = (side: PopoverSide) => {
  switch (side) {
    case "top":
      return { y: 6 };
    case "right":
      return { x: -6 };
    case "left":
      return { x: 6 };
    case "bottom":
    default:
      return { y: -6 };
  }
};

/**
 * A click-driven, collision-aware popover adapted from Interior's Popover.
 *
 * The trigger remains a native button by default. `triggerAsChild` is provided
 * for existing button components that already own their semantics, preventing
 * invalid nested buttons when the popover is used in compact controls.
 */
export function Popover({
  align = "center",
  arrowSize = 8,
  boundary,
  children,
  className,
  defaultOpen = false,
  disabled = false,
  label,
  offset = 8,
  onOpenChange,
  open: controlledOpen,
  padding = 8,
  contentRole = "dialog",
  side = "bottom",
  trigger,
  triggerAriaHaspopup = "dialog",
  triggerAriaLabel,
  triggerAsChild = false,
  triggerClassName,
}: PopoverProps) {
  const generatedId = useId();
  const contentId = `popover-${generatedId.replace(/:/gu, "")}`;
  const anchorRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const reduced = useReducedMotion();
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (disabled && nextOpen) return;
      if (!isControlled) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [disabled, isControlled, onOpenChange],
  );

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;

    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const boundaryRect = getBoundaryRect(boundary) ?? getViewportBoundary();
    const resolvedSide = getFallbackSide(
      side,
      anchorRect,
      contentRect,
      boundaryRect,
    );
    const rawPosition = getPositionForSide({
      align,
      anchor: anchorRect,
      content: contentRect,
      offset,
      side: resolvedSide,
    });
    const maxLeft = boundaryRect.right - contentRect.width - padding;
    const maxTop = boundaryRect.bottom - contentRect.height - padding;
    const nextPosition = {
      left: clamp(rawPosition.left, boundaryRect.left + padding, maxLeft),
      side: resolvedSide,
      top: clamp(rawPosition.top, boundaryRect.top + padding, maxTop),
    } satisfies PopoverPosition;

    setPosition((previous) => {
      if (
        previous &&
        previous.left === nextPosition.left &&
        previous.top === nextPosition.top &&
        previous.side === nextPosition.side
      ) {
        return previous;
      }
      return nextPosition;
    });
  }, [align, boundary, offset, padding, side]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }

    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleViewportChange = () => updatePosition();
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !anchorRef.current?.contains(target) &&
        !contentRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        anchorRef.current?.focus();
      }
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleKeyDown, true);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(handleViewportChange);
    if (resizeObserver) {
      if (anchorRef.current) resizeObserver.observe(anchorRef.current);
      if (contentRef.current) resizeObserver.observe(contentRef.current);
    }

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      resizeObserver?.disconnect();
    };
  }, [isOpen, setOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      contentRef.current?.focus({ preventScroll: true });
      updatePosition();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, updatePosition]);

  const handleTriggerClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    setOpen(!isOpen);
  };

  const triggerElement = isValidElement(trigger)
    ? (trigger as ReactElement<Record<string, unknown>>)
    : null;

  const renderedTrigger =
    triggerAsChild && triggerElement ? (
      cloneElement(triggerElement, {
        "aria-controls": contentId,
        "aria-expanded": isOpen,
        "aria-haspopup": triggerAriaHaspopup,
        "aria-label": triggerAriaLabel ?? triggerElement.props["aria-label"],
        className: cn(
          triggerElement.props.className as string | undefined,
          triggerClassName,
        ),
        "data-state": isOpen ? "open" : "closed",
        disabled: disabled || Boolean(triggerElement.props.disabled),
        onClick: (event: MouseEvent<HTMLElement>) => {
          const originalOnClick = triggerElement.props.onClick as
            ((event: MouseEvent<HTMLElement>) => void) | undefined;
          originalOnClick?.(event);
          if (!event.defaultPrevented) handleTriggerClick(event);
        },
        ref: anchorRef,
      })
    ) : (
      <button
        aria-controls={contentId}
        aria-expanded={isOpen}
        aria-haspopup={triggerAriaHaspopup}
        aria-label={triggerAriaLabel}
        className={cn(
          "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-sm font-medium text-foreground shadow-sm outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
          triggerClassName,
        )}
        data-state={isOpen ? "open" : "closed"}
        disabled={disabled}
        onClick={handleTriggerClick}
        ref={anchorRef as RefObject<HTMLButtonElement>}
        type="button"
      >
        {trigger}
      </button>
    );

  const animationOffset = getAnimationOffset(position?.side ?? side);
  const panelStyle: CSSProperties | undefined = position
    ? { left: position.left, top: position.top }
    : undefined;

  return (
    <>
      {renderedTrigger}
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                  aria-label={label}
                  id={contentId}
                  className={cn(
                    "fixed z-50 max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] origin-center overflow-y-auto rounded-xl border border-border/70 bg-popover p-3 text-sm text-popover-foreground shadow-xl outline-none ring-1 ring-foreground/5",
                    !position && "invisible",
                    className,
                  )}
                  data-side={position?.side ?? side}
                  data-state="open"
                  initial={{
                    opacity: 0,
                    scale: 0.96,
                    ...animationOffset,
                  }}
                  key="popover-content"
                  onMouseDown={(event) => event.stopPropagation()}
                  ref={contentRef}
                  role={contentRole}
                  style={panelStyle}
                  tabIndex={-1}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          damping: 28,
                          stiffness: 420,
                          type: "spring",
                        }
                  }
                >
                  {arrowSize > 0 ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute size-2 rotate-45 border-border/70 bg-popover",
                        (position?.side ?? side) === "bottom" &&
                          "-top-1 border-t border-l",
                        (position?.side ?? side) === "top" &&
                          "-bottom-1 border-r border-b",
                        (position?.side ?? side) === "left" &&
                          "-right-1 border-t border-r",
                        (position?.side ?? side) === "right" &&
                          "-left-1 border-b border-l",
                      )}
                      style={{
                        height: arrowSize,
                        width: arrowSize,
                        ...(position?.side === "left" ||
                        position?.side === "right"
                          ? { top: `calc(50% - ${arrowSize / 2}px)` }
                          : { left: `calc(50% - ${arrowSize / 2}px)` }),
                      }}
                    />
                  ) : null}
                  {children}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
