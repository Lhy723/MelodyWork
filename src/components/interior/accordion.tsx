"use client";

import {
  motion,
  useIsomorphicLayoutEffect,
  useReducedMotion,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";

const DISCLOSE = {
  type: "spring",
  stiffness: 480,
  damping: 40,
  mass: 0.6,
} as const;

const CHEVRON = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;

const INSTANT = { duration: 0 } as const;

const useIsomorphicEffect =
  typeof window === "undefined" ? useEffect : useIsomorphicLayoutEffect;

type Inertable = HTMLElement & { inert?: boolean };

export type AccordionItem = {
  id: string;
  title: ReactNode;
  content: ReactNode;
  meta?: ReactNode;
};

export type AccordionType = "single" | "multiple";

export type UseAccordionOptions = {
  items: readonly AccordionItem[];
  type?: AccordionType;
  defaultOpen?: readonly string[];
  open?: readonly string[];
  onOpenChange?: (open: string[]) => void;
  collapsible?: boolean;
};

export type UseAccordionResult = {
  open: string[];
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  headerProps: (id: string) => AccordionHeaderProps;
  panelProps: (id: string) => AccordionPanelProps;
};

type AccordionHeaderProps = {
  id: string;
  ref: (node: HTMLButtonElement | null) => void;
  type: "button";
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  "aria-expanded": boolean;
  "aria-controls": string;
};

type AccordionPanelProps = {
  id: string;
  role: "region";
  "aria-labelledby": string;
  "aria-hidden": true | undefined;
};

const clampHeadingLevel = (level: number) =>
  Math.min(6, Math.max(1, Math.round(level)));

/**
 * Shared accordion state and keyboard behavior adapted from Interior's
 * Accordion. Opening a row keeps the parent in control when `open` is
 * provided, while the default mode owns its state internally.
 */
export function useAccordion({
  items,
  type = "single",
  defaultOpen = [],
  open: controlled,
  onOpenChange,
  collapsible = true,
}: UseAccordionOptions): UseAccordionResult {
  const base = useId();
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  const [uncontrolled, setUncontrolled] = useState<string[]>(() => {
    const valid = new Set(itemIds);
    const initial = defaultOpen.filter((id) => valid.has(id));
    return type === "single" ? initial.slice(0, 1) : initial;
  });
  const isControlled = controlled !== undefined;
  const open = isControlled ? controlled.slice() : uncontrolled;
  const headers = useRef(new Map<string, HTMLButtonElement>());

  const setHeaderRef = useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) {
        headers.current.set(id, node);
      } else {
        headers.current.delete(id);
      }
    },
    [],
  );

  const commit = useCallback(
    (next: string[]) => {
      if (!isControlled) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const isOpen = useCallback((id: string) => open.includes(id), [open]);

  const toggle = useCallback(
    (id: string) => {
      if (!itemIds.includes(id)) return;
      const active = open.includes(id);
      if (active && !collapsible && type === "single") return;

      if (type === "single") {
        commit(active ? [] : [id]);
      } else {
        commit(active ? open.filter((value) => value !== id) : [...open, id]);
      }
    },
    [collapsible, commit, itemIds, open, type],
  );

  const focusItem = useCallback((id: string | undefined) => {
    if (id) headers.current.get(id)?.focus();
  }, []);

  const moveFocus = useCallback(
    (id: string, delta: number) => {
      const index = itemIds.indexOf(id);
      if (index < 0 || itemIds.length === 0) return;
      const nextIndex = (index + delta + itemIds.length) % itemIds.length;
      focusItem(itemIds[nextIndex]);
    },
    [focusItem, itemIds],
  );

  const headerProps = useCallback(
    (id: string): AccordionHeaderProps => ({
      id: `${base}-header-${id}`,
      ref: (node) => setHeaderRef(id, node),
      type: "button",
      onClick: () => toggle(id),
      onKeyDown: (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(id, 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(id, -1);
        } else if (event.key === "Home") {
          event.preventDefault();
          focusItem(itemIds[0]);
        } else if (event.key === "End") {
          event.preventDefault();
          focusItem(itemIds[itemIds.length - 1]);
        }
      },
      "aria-expanded": open.includes(id),
      "aria-controls": `${base}-panel-${id}`,
    }),
    [base, focusItem, itemIds, moveFocus, open, setHeaderRef, toggle],
  );

  const panelProps = useCallback(
    (id: string): AccordionPanelProps => ({
      id: `${base}-panel-${id}`,
      role: "region",
      "aria-labelledby": `${base}-header-${id}`,
      "aria-hidden": open.includes(id) ? undefined : true,
    }),
    [base, open],
  );

  return { open, isOpen, toggle, headerProps, panelProps };
}

type AutoHeightResult = {
  ref: RefObject<HTMLDivElement | null>;
  height: number;
  ready: boolean;
};

function useAutoHeight(open: boolean): AutoHeightResult {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [ready, setReady] = useState(false);

  useIsomorphicEffect(() => {
    const element = ref.current;
    if (!element) return;

    const read = () => {
      const next = element.getBoundingClientRect().height;
      setHeight((previous) =>
        Math.abs(previous - next) < 0.5 ? previous : next,
      );
    };

    read();
    setReady(true);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  return { ref, height, ready };
}

export type AccordionProps = {
  items: readonly AccordionItem[];
  type?: AccordionType;
  defaultOpen?: readonly string[];
  open?: readonly string[];
  onOpenChange?: (open: string[]) => void;
  collapsible?: boolean;
  maxPanelHeight?: number;
  headingLevel?: number;
  className?: string;
};

/**
 * Interior-style accordion with measured auto-height panels, keyboard
 * navigation, inert closed content, and reduced-motion-aware transitions.
 */
export function Accordion({
  items,
  type = "single",
  defaultOpen = [],
  open: controlled,
  onOpenChange,
  collapsible = true,
  maxPanelHeight = 280,
  headingLevel = 3,
  className,
}: AccordionProps) {
  const reduced = useReducedMotion();
  const { isOpen, headerProps, panelProps } = useAccordion({
    items,
    type,
    defaultOpen,
    open: controlled,
    onOpenChange,
    collapsible,
  });
  const safeMaxPanelHeight = Math.max(1, maxPanelHeight);
  const safeHeadingLevel = clampHeadingLevel(headingLevel);

  return (
    <div
      className={cn(
        "divide-y divide-border overflow-hidden rounded-xl border bg-card",
        className,
      )}
    >
      {items.map((item) => (
        <AccordionRow
          key={item.id}
          item={item}
          open={isOpen(item.id)}
          reduced={Boolean(reduced)}
          maxPanelHeight={safeMaxPanelHeight}
          headingLevel={safeHeadingLevel}
          header={headerProps(item.id)}
          panel={panelProps(item.id)}
        />
      ))}
    </div>
  );
}

function AccordionRow({
  item,
  open,
  reduced,
  maxPanelHeight,
  headingLevel,
  header,
  panel,
}: {
  item: AccordionItem;
  open: boolean;
  reduced: boolean;
  maxPanelHeight: number;
  headingLevel: number;
  header: AccordionHeaderProps;
  panel: AccordionPanelProps;
}) {
  const { ref, height, ready } = useAutoHeight(open);

  useEffect(() => {
    const element = ref.current as Inertable | null;
    if (!element) return;
    element.inert = !open;
    return () => {
      element.inert = false;
    };
  }, [open, ref]);

  return (
    <div data-accordion-item={item.id}>
      <div role="heading" aria-level={headingLevel}>
        <button
          {...header}
          className="group/accordion-trigger flex w-full items-start gap-4 px-5 py-4 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-primary/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        >
          <span className="min-w-0 flex-1">{item.title}</span>
          {item.meta ? (
            <span className="shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums">
              {item.meta}
            </span>
          ) : null}
          <motion.svg
            width="14"
            height="14"
            viewBox="0 0 256 256"
            fill="none"
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-muted-foreground"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduced ? INSTANT : CHEVRON}
          >
            <path
              d="M208 96l-80 80-80-80"
              stroke="currentColor"
              strokeWidth="16"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </motion.svg>
        </button>
      </div>
      <motion.div
        initial={false}
        animate={ready ? { height: open ? height : 0 } : {}}
        transition={reduced ? INSTANT : DISCLOSE}
        style={{
          overflow: "hidden",
          height: ready ? undefined : open ? "auto" : 0,
        }}
      >
        <div
          {...panel}
          ref={ref}
          className="border-t bg-muted/20"
          style={{
            maxHeight: maxPanelHeight,
            overflowY: "auto",
            overscrollBehavior: "contain",
            scrollbarGutter: "stable",
          }}
        >
          <motion.div
            initial={false}
            animate={{ opacity: open ? 1 : 0 }}
            transition={
              reduced
                ? INSTANT
                : open
                  ? { duration: 0.18, ease: [0.23, 1, 0.32, 1] }
                  : { duration: 0.14, ease: [0.4, 0, 1, 1] }
            }
            className="px-5 pb-4 pt-4 text-muted-foreground text-xs"
          >
            {item.content}
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}
