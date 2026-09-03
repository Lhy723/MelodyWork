"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export interface TabItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export type TabsActivation = "automatic" | "manual";
export type TabsVariant = "underline" | "segmented";

export interface UseTabsOptions {
  activation?: TabsActivation;
  defaultValue?: string;
  disabled?: boolean;
  items: TabItem[];
  onValueChange?: (value: string) => void;
  value?: string;
}

export interface UseTabsResult {
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, value: string) => void;
  select: (value: string) => void;
  setTabRef: (value: string, element: HTMLButtonElement | null) => void;
  value?: string;
}

const firstEnabledValue = (items: TabItem[]) =>
  items.find((item) => !item.disabled)?.value;

const moveToEnabledItem = (
  items: TabItem[],
  currentValue: string,
  direction: 1 | -1,
) => {
  const currentIndex = items.findIndex((item) => item.value === currentValue);
  if (currentIndex < 0 || items.length === 0) return undefined;

  for (let offset = 1; offset <= items.length; offset += 1) {
    const nextIndex =
      (currentIndex + direction * offset + items.length) % items.length;
    const item = items[nextIndex];
    if (item && !item.disabled) return item;
  }
  return undefined;
};

/**
 * Shared tab state and keyboard behavior adapted from Interior's Tabs.
 * Selection is controlled or uncontrolled, while arrow navigation can be
 * automatic or explicitly committed with Enter/Space.
 */
export function useTabs({
  activation = "automatic",
  defaultValue,
  disabled = false,
  items,
  onValueChange,
  value: controlledValue,
}: UseTabsOptions): UseTabsResult {
  const [internalValue, setInternalValue] = useState<string | undefined>(
    () => defaultValue ?? firstEnabledValue(items),
  );
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const isControlled = controlledValue !== undefined;
  const requestedValue = isControlled ? controlledValue : internalValue;
  const selectedValue = items.some(
    (item) => item.value === requestedValue && !item.disabled,
  )
    ? requestedValue
    : firstEnabledValue(items);

  useEffect(() => {
    if (isControlled) return;
    const nextValue = items.some(
      (item) => item.value === internalValue && !item.disabled,
    )
      ? internalValue
      : firstEnabledValue(items);
    if (nextValue !== internalValue) {
      setInternalValue(nextValue);
    }
  }, [internalValue, isControlled, items]);

  const select = useCallback(
    (nextValue: string) => {
      if (disabled) return;
      const item = items.find((candidate) => candidate.value === nextValue);
      if (!item || item.disabled) return;
      if (!isControlled) setInternalValue(nextValue);
      onValueChange?.(nextValue);
    },
    [disabled, isControlled, items, onValueChange],
  );

  const setTabRef = useCallback(
    (tabValue: string, element: HTMLButtonElement | null) => {
      if (element) {
        tabRefs.current.set(tabValue, element);
      } else {
        tabRefs.current.delete(tabValue);
      }
    },
    [],
  );

  const focusItem = useCallback(
    (item: TabItem | undefined) => {
      if (!item || disabled) return;
      tabRefs.current.get(item.value)?.focus();
      if (activation === "automatic") {
        select(item.value);
      }
    },
    [activation, disabled, select],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentValue: string) => {
      if (disabled) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        focusItem(moveToEnabledItem(items, currentValue, 1));
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        focusItem(moveToEnabledItem(items, currentValue, -1));
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const enabledItems = items.filter((item) => !item.disabled);
        const target =
          event.key === "Home"
            ? enabledItems[0]
            : enabledItems[enabledItems.length - 1];
        focusItem(target);
        return;
      }
      if (
        activation === "manual" &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        select(currentValue);
      }
    },
    [activation, disabled, focusItem, items, select],
  );

  return { onKeyDown, select, setTabRef, value: selectedValue };
}

type IndicatorRect = {
  height: number;
  left: number;
  top: number;
  width: number;
};

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TabsProps extends UseTabsOptions {
  className?: string;
  label?: string;
  panelClassName?: string;
  renderPanel?: (value: string) => ReactNode;
  variant?: TabsVariant;
}

/**
 * Interior-style tabs with one shared motion indicator and accessible
 * tablist/tabpanel semantics. Melody uses semantic theme tokens rather than
 * hard-coded library colors so the control works in both themes.
 */
export function Tabs({
  activation = "automatic",
  className,
  defaultValue,
  disabled = false,
  items,
  label = "标签页",
  onValueChange,
  panelClassName,
  renderPanel,
  value,
  variant = "segmented",
}: TabsProps) {
  const reduced = useReducedMotion();
  const id = useId().replace(/:/gu, "");
  const tabListId = `tabs-${id}-list`;
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabsValueRef = useRef(new Map<string, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<IndicatorRect>();
  const tabs = useTabs({
    activation,
    defaultValue,
    disabled,
    items,
    onValueChange,
    value,
  });
  const selectedItem = items.find((item) => item.value === tabs.value);
  const selectedTabId = selectedItem
    ? `tabs-${id}-tab-${items.indexOf(selectedItem)}`
    : undefined;
  const panelId = `tabs-${id}-panel`;

  useIsoLayoutEffect(() => {
    const list = tabListRef.current;
    const tab = selectedItem
      ? tabsValueRef.current.get(selectedItem.value)
      : undefined;
    if (!list || !tab) {
      setIndicator(undefined);
      return;
    }

    const measure = () => {
      const listRect = list.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      const next = {
        height: tabRect.height,
        left: tabRect.left - listRect.left,
        top: tabRect.top - listRect.top,
        width: tabRect.width,
      } satisfies IndicatorRect;
      setIndicator((previous) => {
        if (
          previous &&
          previous.height === next.height &&
          previous.left === next.left &&
          previous.top === next.top &&
          previous.width === next.width
        ) {
          return previous;
        }
        return next;
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(tab);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selectedItem, tabs.value]);

  const setTabRef = useCallback(
    (tabValue: string, element: HTMLButtonElement | null) => {
      tabs.setTabRef(tabValue, element);
      if (element) {
        tabsValueRef.current.set(tabValue, element);
      } else {
        tabsValueRef.current.delete(tabValue);
      }
    },
    [tabs],
  );

  const tabListClassName =
    variant === "segmented"
      ? "relative flex min-w-0 gap-0.5 overflow-x-auto rounded-xl bg-muted/60 p-1"
      : "relative flex min-w-0 gap-5 overflow-x-auto border-b border-border/70";
  const tabClassName =
    variant === "segmented"
      ? "relative z-10 min-w-0 flex-1 rounded-lg px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"
      : "relative z-10 min-w-0 px-1 pt-1 pb-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45";
  const indicatorClassName =
    variant === "segmented"
      ? "pointer-events-none absolute rounded-lg bg-background shadow-sm ring-1 ring-border/35"
      : "pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-primary";

  return (
    <div className={cn("min-w-0", className)}>
      <div
        aria-label={label}
        aria-orientation="horizontal"
        className={tabListClassName}
        id={tabListId}
        ref={tabListRef}
        role="tablist"
      >
        {indicator ? (
          <motion.span
            aria-hidden="true"
            className={indicatorClassName}
            initial={false}
            animate={
              variant === "segmented"
                ? {
                    height: indicator.height,
                    left: indicator.left,
                    top: indicator.top,
                    width: indicator.width,
                  }
                : {
                    left: indicator.left,
                    width: indicator.width,
                  }
            }
            transition={
              reduced
                ? { duration: 0 }
                : { type: "spring", stiffness: 460, damping: 34, mass: 0.5 }
            }
          />
        ) : null}
        {items.map((item, index) => {
          const selected = item.value === tabs.value;
          const tabId = `tabs-${id}-tab-${index}`;
          return (
            <button
              aria-controls={renderPanel ? panelId : undefined}
              aria-selected={selected}
              className={cn(
                tabClassName,
                selected
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              disabled={disabled || item.disabled}
              id={tabId}
              key={item.value}
              onClick={() => tabs.select(item.value)}
              onKeyDown={(event) => tabs.onKeyDown(event, item.value)}
              ref={(element) => setTabRef(item.value, element)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span className="block truncate">{item.label}</span>
            </button>
          );
        })}
      </div>

      {renderPanel ? (
        <div
          aria-labelledby={selectedTabId}
          className={cn("min-w-0", panelClassName)}
          id={panelId}
          role="tabpanel"
          tabIndex={0}
        >
          <AnimatePresence initial={false} mode="wait">
            {selectedItem ? (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduced ? 0 : -4 }}
                initial={{ opacity: 0, y: reduced ? 0 : 4 }}
                key={selectedItem.value}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: 0.18, ease: [0.23, 1, 0.32, 1] }
                }
              >
                {renderPanel(selectedItem.value)}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  );
}
