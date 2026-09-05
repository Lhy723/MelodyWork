"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Popover } from "@/components/interior/popover";
import { cn } from "@/lib/utils";

export type DropdownItem = {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export type UseDropdownOptions = {
  items: DropdownItem[];
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
};

const firstEnabled = (items: DropdownItem[]) =>
  items.findIndex((item) => !item.disabled);

const enabledIndices = (items: DropdownItem[]) =>
  items.reduce<number[]>((indices, item, index) => {
    if (!item.disabled) indices.push(index);
    return indices;
  }, []);

/**
 * State and keyboard behavior for Interior's dropdown pattern. The hook is
 * exported so custom triggers can share the same selection semantics as the
 * ready-made Dropdown component.
 */
export function useDropdown({
  items,
  value: controlledValue,
  defaultValue,
  disabled = false,
  onChange,
}: UseDropdownOptions) {
  const [uncontrolledValue, setUncontrolledValue] = useState(
    defaultValue ?? "",
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = useRef("");
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef(items);
  const changeRef = useRef(onChange);
  itemsRef.current = items;
  changeRef.current = onChange;

  const value = controlledValue ?? uncontrolledValue;
  const selectedIndex = items.findIndex((item) => item.value === value);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;
  const order = enabledIndices(items);

  const setMenuOpen = useCallback(
    (next: boolean) => {
      if (disabled && next) return;
      setOpen(next);
      if (next) {
        const selected = itemsRef.current.findIndex(
          (item) => item.value === (controlledValue ?? uncontrolledValue),
        );
        setActiveIndex(
          selected >= 0 && !itemsRef.current[selected]?.disabled
            ? selected
            : firstEnabled(itemsRef.current),
        );
      } else {
        setActiveIndex(-1);
        query.current = "";
      }
    },
    [controlledValue, disabled, uncontrolledValue],
  );

  const select = useCallback(
    (index: number) => {
      const item = itemsRef.current[index];
      if (!item || item.disabled) return;
      if (controlledValue === undefined) setUncontrolledValue(item.value);
      setMenuOpen(false);
      changeRef.current?.(item.value);
    },
    [controlledValue, setMenuOpen],
  );

  const move = useCallback(
    (direction: 1 | -1) => {
      if (order.length === 0) return;
      const current = order.indexOf(activeIndex);
      const next =
        current < 0
          ? direction === 1
            ? order[0]
            : order[order.length - 1]
          : order[(current + direction + order.length) % order.length];
      setActiveIndex(next);
    },
    [activeIndex, order],
  );

  const edge = useCallback(
    (which: "first" | "last") => {
      if (order.length === 0) return;
      setActiveIndex(which === "first" ? order[0] : order[order.length - 1]);
    },
    [order],
  );

  const typeahead = useCallback(
    (character: string) => {
      query.current += character.toLocaleLowerCase();
      if (queryTimer.current !== null) clearTimeout(queryTimer.current);
      queryTimer.current = setTimeout(() => {
        query.current = "";
      }, 600);

      const start = Math.max(0, order.indexOf(activeIndex) + 1);
      for (let offset = 0; offset < order.length; offset += 1) {
        const index = order[(start + offset) % order.length];
        if (
          itemsRef.current[index]?.label
            .toLocaleLowerCase()
            .startsWith(query.current)
        ) {
          setActiveIndex(index);
          return;
        }
      }
    },
    [activeIndex, order],
  );

  useEffect(
    () => () => {
      if (queryTimer.current !== null) clearTimeout(queryTimer.current);
    },
    [],
  );

  return {
    activeIndex,
    edge,
    move,
    open,
    select,
    selectedIndex,
    selectedItem,
    setActiveIndex,
    setOpen: setMenuOpen,
    typeahead,
    value,
  };
}

export type DropdownProps = {
  items: DropdownItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
};

export function Dropdown({
  items,
  value,
  defaultValue,
  onChange,
  label = "Select option",
  placeholder = "Select…",
  disabled = false,
  emptyLabel = "No options",
  className,
  triggerClassName,
  menuClassName,
}: DropdownProps) {
  const uid = useId().replace(/:/gu, "");
  const reduced = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const {
    activeIndex,
    edge,
    move,
    open,
    select,
    selectedItem,
    setActiveIndex,
    setOpen,
    typeahead,
  } = useDropdown({
    defaultValue,
    disabled,
    items,
    onChange,
    value,
  });

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const active =
        activeIndex >= 0 ? itemRefs.current[activeIndex] : undefined;
      active?.focus({ preventScroll: true });
      active?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        edge(event.key === "Home" ? "first" : "last");
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (activeIndex >= 0) select(activeIndex);
        return;
      }
      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        typeahead(event.key);
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeIndex, edge, move, open, select, setOpen, typeahead]);

  const handleTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    triggerRef.current = event.currentTarget;
    if (
      event.key !== "Enter" &&
      event.key !== " " &&
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp"
    ) {
      return;
    }
    event.preventDefault();
    if (!open) {
      setOpen(true);
      if (event.key === "ArrowUp") edge("last");
    }
  };

  return (
    <div className={cn("inline-flex min-w-0", className)}>
      <Popover
        align="start"
        arrowSize={0}
        className={cn("min-w-[11rem] overflow-y-auto p-1.5", menuClassName)}
        contentRole="listbox"
        disabled={disabled}
        label={label}
        offset={6}
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        trigger={
          <button
            className="flex min-w-0 items-center gap-1.5"
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
            }}
            onKeyDown={handleTriggerKeyDown}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {selectedItem?.label ?? placeholder}
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground transition-transform data-[state=open]:rotate-180"
            />
          </button>
        }
        triggerAriaLabel={label}
        triggerAriaHaspopup="listbox"
        triggerAsChild
        triggerClassName={cn(
          "h-8 w-full min-w-0 justify-between gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-sm font-medium text-foreground shadow-sm outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
          "[&[data-state=open]_svg]:rotate-180",
          triggerClassName,
        )}
      >
        <div
          aria-label={label}
          className="relative outline-none"
          id={`${uid}-listbox`}
          onMouseDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          {items.length === 0 ? (
            <div className="px-2.5 py-2 text-muted-foreground text-xs">
              {emptyLabel}
            </div>
          ) : (
            items.map((item, index) => {
              const active = activeIndex === index;
              const selected = selectedItem?.value === item.value;
              return (
                <button
                  aria-selected={selected}
                  className={cn(
                    "group relative flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors",
                    "text-popover-foreground hover:bg-accent/70 focus-visible:bg-accent/70",
                    selected && "font-medium",
                    item.disabled &&
                      "pointer-events-none text-muted-foreground/50",
                  )}
                  disabled={item.disabled}
                  key={item.value}
                  onClick={() => select(index)}
                  onPointerMove={() => {
                    if (!item.disabled) {
                      // Pointer movement and keyboard movement intentionally
                      // share the same active highlight.
                      setActiveIndex(index);
                    }
                  }}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  role="option"
                  type="button"
                >
                  {active ? (
                    <motion.span
                      aria-hidden="true"
                      className="absolute inset-0 rounded-lg bg-accent/70"
                      layoutId={`${uid}-active`}
                      transition={
                        reduced
                          ? { duration: 0 }
                          : {
                              damping: 28,
                              stiffness: 420,
                              type: "spring",
                            }
                      }
                    />
                  ) : null}
                  {item.icon ? (
                    <span className="relative z-10 grid size-4 shrink-0 place-items-center text-muted-foreground">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="relative z-10 min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="mt-0.5 block truncate text-muted-foreground text-[11px]">
                        {item.hint}
                      </span>
                    ) : null}
                  </span>
                  {selected ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="relative z-10 size-3.5 shrink-0 text-primary"
                    />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </Popover>
    </div>
  );
}
