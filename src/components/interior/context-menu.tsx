"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

const EASE = [0.23, 1, 0.32, 1] as const;
const EXIT = [0.4, 0, 1, 1] as const;

const ITEM_HEIGHT = 32;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 5;
const MENU_BORDER = 1;

export type ContextMenuItem =
  | { id: string; type: "separator" }
  | {
      id: string;
      type?: "item";
      label: string;
      shortcut?: string;
      icon?: ReactNode;
      disabled?: boolean;
      onSelect?: (id: string) => void;
    };

export type ContextMenuPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  transformOrigin: string;
};

export type UseContextMenuOptions = {
  items: ContextMenuItem[];
  onSelect?: (id: string) => void;
  width?: number;
  margin?: number;
  holdDuration?: number;
  moveTolerance?: number;
  disabled?: boolean;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

const measure = (items: ContextMenuItem[]) =>
  items.reduce(
    (height, item) =>
      height + (item.type === "separator" ? SEPARATOR_HEIGHT : ITEM_HEIGHT),
    MENU_PADDING * 2 + MENU_BORDER * 2,
  );

/**
 * Adds pointer, keyboard and touch-long-press behavior to a context-menu
 * surface. The owning element keeps its normal click behavior; this hook only
 * handles opening the menu and routing menu-item selection.
 */
export function useContextMenu({
  items,
  onSelect,
  width = 224,
  margin = 8,
  holdDuration = 460,
  moveTolerance = 8,
  disabled = false,
}: UseContextMenuOptions) {
  const [placement, setPlacement] = useState<ContextMenuPlacement | null>(null);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);

  const triggerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const opened = useRef(false);
  const activeRef = useRef(-1);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFrom = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const pressed = useRef(-1);
  const query = useRef("");
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  activeRef.current = active;

  const list = useRef(items);
  list.current = items;
  const emit = useRef(onSelect);
  emit.current = onSelect;

  const height = useMemo(() => measure(items), [items]);
  const steps = useMemo(
    () =>
      items.reduce<number[]>((accumulator, item, index) => {
        if (item.type !== "separator" && !item.disabled) {
          accumulator.push(index);
        }
        return accumulator;
      }, []),
    [items],
  );
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const clearHold = useCallback(() => {
    if (hold.current !== null) clearTimeout(hold.current);
    hold.current = null;
    holdFrom.current = null;
  }, []);

  const close = useCallback(
    (restoreFocus = false) => {
      clearHold();
      if (!opened.current) {
        setOpen(false);
        setPlacement(null);
        setActive(-1);
        return;
      }
      opened.current = false;
      setOpen(false);
      setActive(-1);
      if (restoreFocus) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    },
    [clearHold],
  );

  const openAt = useCallback(
    (x: number, y: number, source: "pointer" | "keyboard" = "pointer") => {
      if (disabled || list.current.length === 0) return;

      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const menuWidth = Math.min(
        width,
        Math.max(160, viewportWidth - margin * 2),
      );
      const maxHeight = Math.max(
        ITEM_HEIGHT + MENU_PADDING * 2,
        viewportHeight - margin * 2,
      );
      const menuHeight = Math.min(height, maxHeight);
      const left = clamp(
        x + menuWidth + margin <= viewportWidth ? x : x - menuWidth,
        margin,
        viewportWidth - menuWidth - margin,
      );
      const top = clamp(
        y + menuHeight + margin <= viewportHeight ? y : y - menuHeight,
        margin,
        viewportHeight - menuHeight - margin,
      );

      opened.current = true;
      pressed.current = -1;
      setPlacement({
        left,
        top,
        width: menuWidth,
        maxHeight,
        transformOrigin: `${clamp(x - left, 0, menuWidth)}px ${clamp(
          y - top,
          0,
          menuHeight,
        )}px`,
      });
      setActive(source === "keyboard" ? (stepsRef.current[0] ?? -1) : -1);
      setOpen(true);
    },
    [disabled, height, margin, width],
  );

  const choose = useCallback(
    (index: number) => {
      const item = list.current[index];
      if (!item || item.type === "separator" || item.disabled) return;
      close(true);
      item.onSelect?.(item.id);
      emit.current?.(item.id);
    },
    [close],
  );

  const step = useCallback((direction: 1 | -1) => {
    const order = stepsRef.current;
    if (order.length === 0) return;
    const current = order.indexOf(activeRef.current);
    setActive(
      current === -1
        ? direction === 1
          ? order[0]
          : order[order.length - 1]
        : order[(current + direction + order.length) % order.length],
    );
  }, []);

  const edge = useCallback((which: "first" | "last") => {
    const order = stepsRef.current;
    if (order.length === 0) return;
    setActive(which === "first" ? order[0] : order[order.length - 1]);
  }, []);

  const typeahead = useCallback((character: string) => {
    query.current += character.toLocaleLowerCase();
    if (queryTimer.current !== null) clearTimeout(queryTimer.current);
    queryTimer.current = setTimeout(() => {
      query.current = "";
    }, 600);

    const order = stepsRef.current;
    const start = order.indexOf(activeRef.current) + 1;
    for (let offset = 0; offset < order.length; offset += 1) {
      const index = order[(start + offset) % order.length];
      const item = list.current[index];
      if (
        item.type !== "separator" &&
        item.label.toLocaleLowerCase().startsWith(query.current)
      ) {
        setActive(index);
        return;
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const node =
      activeRef.current >= 0
        ? itemRefs.current[activeRef.current]
        : menuRef.current;
    node?.focus({ preventScroll: true });
    if (activeRef.current >= 0) {
      node?.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  useEffect(() => {
    if (!open) return;

    const inside = (target: EventTarget | null) =>
      menuRef.current?.contains(target as Node) ?? false;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (inside(event.target)) return;
      if (
        event.button === 2 &&
        triggerRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      close(false);
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) close(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const closeForViewportChange = () => close(false);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("blur", closeForViewportChange);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("blur", closeForViewportChange);
    };
  }, [close, open]);

  useEffect(
    () => () => {
      clearHold();
      if (queryTimer.current !== null) clearTimeout(queryTimer.current);
    },
    [clearHold],
  );

  const triggerProps = {
    tabIndex: disabled ? -1 : 0,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    style: {
      touchAction: "manipulation",
      WebkitTouchCallout: "none",
    } as CSSProperties,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      clearHold();
      triggerRef.current = event.currentTarget as HTMLDivElement;
      openAt(event.clientX, event.clientY, "pointer");
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (disabled || opened.current) return;
      const wantsMenu =
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10") ||
        (event.key === "Enter" && event.target === event.currentTarget);
      if (!wantsMenu) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openAt(Math.round(rect.left + 14), Math.round(rect.top + 14), "keyboard");
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (disabled || event.pointerType === "mouse" || opened.current) return;
      const x = event.clientX;
      const y = event.clientY;
      triggerRef.current = event.currentTarget as HTMLDivElement;
      holdFrom.current = { x, y };
      hold.current = setTimeout(() => {
        hold.current = null;
        swallowClick.current = true;
        navigator.vibrate?.(10);
        openAt(x, y, "pointer");
      }, holdDuration);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const from = holdFrom.current;
      if (hold.current === null || !from) return;
      if (
        Math.hypot(event.clientX - from.x, event.clientY - from.y) >
        moveTolerance
      ) {
        clearHold();
      }
    },
    onPointerUp: clearHold,
    onPointerCancel: clearHold,
    onPointerLeave: clearHold,
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  const menuProps = {
    role: "menu" as const,
    tabIndex: -1,
    "aria-orientation": "vertical" as const,
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        step(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        edge(event.key === "Home" ? "first" : "last");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        close(true);
        return;
      }
      if (
        event.key.length === 1 &&
        event.key !== " " &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        typeahead(event.key);
      }
    },
  };

  const getItemProps = (index: number) => ({
    ref: (node: HTMLButtonElement | null) => {
      itemRefs.current[index] = node;
    },
    role: "menuitem" as const,
    tabIndex: -1,
    onPointerMove: () => {
      const item = list.current[index];
      if (
        activeRef.current === index ||
        item.type === "separator" ||
        item.disabled
      ) {
        return;
      }
      setActive(index);
    },
    onPointerDown: () => {
      pressed.current = index;
    },
    onClick: (event: ReactMouseEvent) => {
      if (event.detail !== 0 && pressed.current !== index) return;
      pressed.current = -1;
      choose(index);
    },
  });

  return {
    isOpen: open,
    active,
    placement,
    openAt,
    close,
    triggerRef,
    triggerProps,
    menuRef,
    menuProps,
    getItemProps,
  };
}

export type ContextMenuProps = {
  items: ContextMenuItem[];
  children: ReactNode;
  onSelect?: (id: string) => void;
  label?: string;
  width?: number;
  disabled?: boolean;
  className?: string;
};

export function ContextMenu({
  items,
  children,
  onSelect,
  label = "Context menu",
  width = 224,
  disabled = false,
  className,
}: ContextMenuProps) {
  const uid = useId();
  const reduced = useReducedMotion();
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => setHost(document.body), []);

  const {
    isOpen,
    active,
    placement,
    close,
    triggerRef,
    triggerProps,
    menuRef,
    menuProps,
    getItemProps,
  } = useContextMenu({ items, onSelect, width, disabled });

  const hasIcons = items.some((item) => item.type !== "separator" && item.icon);
  const menuId = `${uid}-menu`;

  return (
    <>
      <div
        ref={triggerRef}
        {...triggerProps}
        aria-controls={isOpen ? menuId : undefined}
        aria-describedby={`${uid}-hint`}
        className={cn(
          "block outline-none focus-visible:rounded-lg focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40",
          className,
        )}
      >
        {children}
        <span className="sr-only" id={`${uid}-hint`}>
          右键或按 Shift 加 F10 打开操作菜单
        </span>
      </div>
      {host
        ? createPortal(
            <AnimatePresence initial={false}>
              {placement ? (
                <motion.div
                  key={menuId}
                  ref={menuRef}
                  id={menuId}
                  {...menuProps}
                  aria-label={label}
                  animate={
                    isOpen
                      ? { opacity: 1, scale: 1 }
                      : { opacity: 0, scale: 0.98 }
                  }
                  className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-xl outline-none ring-1 ring-foreground/5"
                  initial={{ opacity: 0, scale: 0.96 }}
                  onAnimationComplete={() => {
                    if (!isOpen) {
                      close(false);
                    }
                  }}
                  style={{
                    left: placement.left,
                    maxHeight: placement.maxHeight,
                    position: "fixed",
                    top: placement.top,
                    transformOrigin: placement.transformOrigin,
                    width: placement.width,
                  }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : isOpen
                        ? { duration: 0.2, ease: EASE }
                        : { duration: 0.14, ease: EXIT }
                  }
                >
                  {items.map((item, index) =>
                    item.type === "separator" ? (
                      <div className="px-1 py-1" key={item.id}>
                        <hr className="h-px border-0 bg-border/70" />
                      </div>
                    ) : (
                      <button
                        key={item.id}
                        {...getItemProps(index)}
                        aria-disabled={item.disabled || undefined}
                        className={cn(
                          "group flex h-8 w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none transition-colors",
                          item.disabled
                            ? "text-muted-foreground/50"
                            : "text-popover-foreground",
                          active === index &&
                            !item.disabled &&
                            "bg-accent text-accent-foreground",
                        )}
                        disabled={item.disabled}
                        type="button"
                      >
                        {hasIcons ? (
                          <span
                            aria-hidden="true"
                            className="grid size-4 shrink-0 place-items-center text-muted-foreground group-hover:text-accent-foreground"
                          >
                            {item.icon}
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {item.shortcut ? (
                          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                            {item.shortcut}
                          </span>
                        ) : null}
                      </button>
                    ),
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            host,
          )
        : null}
    </>
  );
}
