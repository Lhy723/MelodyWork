"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

const EASE = [0.23, 1, 0.32, 1] as const;
const LEAVE = [0.4, 0, 1, 1] as const;
const CARET = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;
const OPEN_HEIGHT = { duration: 0.28, ease: EASE } as const;
const OPEN_OPACITY = { duration: 0.18, ease: EASE } as const;
const CLOSE_HEIGHT = { duration: 0.2, ease: LEAVE } as const;
const CLOSE_OPACITY = { duration: 0.14, ease: LEAVE } as const;
const STILL = { duration: 0 } as const;

export type TreeNode = {
  id: string;
  label: string;
  icon?: ReactNode;
  meta?: ReactNode;
  children?: TreeNode[];
  selectable?: boolean;
  disabled?: boolean;
};

export type TreeRow = {
  node: TreeNode;
  level: number;
  parentId: string | null;
  posinset: number;
  setsize: number;
  branch: boolean;
  open: boolean;
};

function flatten(
  nodes: TreeNode[],
  openSet: ReadonlySet<string>,
  level = 1,
  parentId: string | null = null,
  out: TreeRow[] = [],
): TreeRow[] {
  nodes.forEach((node, index) => {
    const children = node.children ?? [];
    const branch = children.length > 0;
    const open = branch && openSet.has(node.id);
    out.push({
      node,
      level,
      parentId,
      posinset: index + 1,
      setsize: nodes.length,
      branch,
      open,
    });
    if (open) flatten(children, openSet, level + 1, node.id, out);
  });
  return out;
}

export type UseTreeViewOptions = {
  nodes: TreeNode[];
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  selected?: string | null;
  defaultSelected?: string | null;
  onSelectedChange?: (selected: string) => void;
};

export function useTreeView({
  nodes,
  expanded,
  defaultExpanded = [],
  onExpandedChange,
  selected,
  defaultSelected = null,
  onSelectedChange,
}: UseTreeViewOptions) {
  const [internalOpen, setInternalOpen] = useState<string[]>(defaultExpanded);
  const openControlled = expanded !== undefined;
  const openList = openControlled ? expanded : internalOpen;
  const openSet = useMemo(() => new Set(openList), [openList]);

  const [internalSelection, setInternalSelection] = useState<string | null>(
    defaultSelected,
  );
  const selectionControlled = selected !== undefined;
  const selectedId = selectionControlled ? selected : internalSelection;

  const emitOpen = useRef(onExpandedChange);
  emitOpen.current = onExpandedChange;
  const emitSelection = useRef(onSelectedChange);
  emitSelection.current = onSelectedChange;

  const rows = useMemo(() => flatten(nodes, openSet), [nodes, openSet]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const tabStop =
    focusId !== null && rows.some((row) => row.node.id === focusId)
      ? focusId
      : (rows.find((row) => row.node.id === selectedId)?.node.id ??
        rows[0]?.node.id ??
        null);

  const refs = useRef(new Map<string, HTMLElement>());
  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) refs.current.set(id, element);
    else refs.current.delete(id);
  }, []);

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    refs.current.get(id)?.focus();
  }, []);

  const setOpen = useCallback(
    (next: string[]) => {
      if (!openControlled) setInternalOpen(next);
      emitOpen.current?.(next);
    },
    [openControlled],
  );

  const toggle = useCallback(
    (id: string) => {
      const row = rows.find((candidate) => candidate.node.id === id);
      if (!row?.branch || row.node.disabled) return;
      const next = openList.includes(id)
        ? openList.filter((value) => value !== id)
        : [...openList, id];
      setOpen(next);
    },
    [openList, rows, setOpen],
  );

  const select = useCallback(
    (id: string) => {
      const row = rows.find((candidate) => candidate.node.id === id);
      if (!row || row.node.disabled || row.node.selectable === false) return;
      if (!selectionControlled) setInternalSelection(id);
      emitSelection.current?.(id);
    },
    [rows, selectionControlled],
  );

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLElement>, row: TreeRow) => {
      const at = rows.findIndex(
        (candidate) => candidate.node.id === row.node.id,
      );
      const go = (index: number) => {
        const target = rows[index];
        if (target) focusRow(target.node.id);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          go(at + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          go(at - 1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (row.branch && !row.open) toggle(row.node.id);
          else if (row.open) go(at + 1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (row.open) toggle(row.node.id);
          else if (row.parentId) focusRow(row.parentId);
          return;
        case "Home":
          event.preventDefault();
          go(0);
          return;
        case "End":
          event.preventDefault();
          go(rows.length - 1);
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          select(row.node.id);
          if (row.branch) toggle(row.node.id);
          return;
        default:
          break;
      }

      if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return;
      const letter = event.key.toLocaleLowerCase();
      if (letter === " ") return;
      for (let step = 1; step <= rows.length; step += 1) {
        const candidate = rows[(at + step) % rows.length];
        if (candidate?.node.label.toLocaleLowerCase().startsWith(letter)) {
          event.preventDefault();
          focusRow(candidate.node.id);
          return;
        }
      }
    },
    [focusRow, rows, select, toggle],
  );

  return {
    rows,
    openSet,
    selectedId,
    tabStop,
    register,
    focusRow,
    setFocusId,
    toggle,
    select,
    handleKey,
  };
}

function Caret({ open }: { open: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-hidden="true"
      animate={{ rotate: open ? 90 : 0 }}
      className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      initial={false}
      transition={reduced ? STILL : CARET}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        height="10"
        viewBox="0 0 12 12"
        width="10"
      >
        <path
          d="M4.5 2.5 8 6l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
        />
      </svg>
    </motion.span>
  );
}

export type TreeViewProps = {
  nodes: TreeNode[];
  label: string;
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  selected?: string | null;
  defaultSelected?: string | null;
  onSelectedChange?: (selected: string) => void;
  /** Customize the content rendered after the disclosure caret. */
  renderNode?: (node: TreeNode, row: TreeRow) => ReactNode;
  /** Override the selected row treatment when embedding the tree in another surface. */
  selectedClassName?: string;
  className?: string;
};

/**
 * Interior-style disclosure tree with roving focus, keyboard navigation,
 * controlled selection/expansion, and reduced-motion-aware transitions.
 * `icon`, `meta`, custom row rendering, and non-selectable branches keep the
 * primitive useful for file, resource, and navigation trees.
 */
export function TreeView({
  nodes,
  label,
  expanded,
  defaultExpanded,
  onExpandedChange,
  selected,
  defaultSelected,
  onSelectedChange,
  renderNode,
  selectedClassName,
  className,
}: TreeViewProps) {
  const tree = useTreeView({
    nodes,
    expanded,
    defaultExpanded,
    onExpandedChange,
    selected,
    defaultSelected,
    onSelectedChange,
  });
  const reduced = useReducedMotion();
  const hintId = useId();

  const renderNodes = (list: TreeNode[], level: number) =>
    list.map((node) => {
      const row = tree.rows.find((candidate) => candidate.node.id === node.id);
      if (!row) return null;

      const isSelected = tree.selectedId === node.id;
      const isDisabled = node.disabled === true;

      return (
        <li key={node.id} role="none">
          <div
            aria-describedby={hintId}
            aria-disabled={isDisabled || undefined}
            aria-expanded={row.branch ? row.open : undefined}
            aria-level={level}
            aria-label={node.label}
            aria-posinset={row.posinset}
            aria-selected={isSelected}
            aria-setsize={row.setsize}
            className={cn(
              "group flex min-h-8 cursor-default select-none items-center gap-1.5 rounded-lg px-2 text-left text-xs outline-none transition-[background-color,color,box-shadow] duration-150",
              "focus-visible:bg-primary/8 focus-visible:ring-1 focus-visible:ring-ring",
              isSelected
                ? (selectedClassName ?? "bg-muted text-foreground")
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              isDisabled &&
                "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
            onClick={() => {
              if (isDisabled) return;
              tree.select(node.id);
              tree.focusRow(node.id);
              if (row.branch) tree.toggle(node.id);
            }}
            onFocus={() => tree.setFocusId(node.id)}
            onKeyDown={(event) => tree.handleKey(event, row)}
            ref={(element) => tree.register(node.id, element)}
            role="treeitem"
            tabIndex={tree.tabStop === node.id ? 0 : -1}
          >
            {row.branch ? (
              <Caret open={row.open} />
            ) : (
              <span aria-hidden="true" className="size-4 shrink-0" />
            )}
            {renderNode ? (
              renderNode(node, row)
            ) : (
              <>
                {node.icon ? (
                  <span
                    aria-hidden="true"
                    className="flex size-4 shrink-0 items-center justify-center"
                  >
                    {node.icon}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    isSelected && "font-medium",
                  )}
                >
                  {node.label}
                </span>
                {node.meta ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {node.meta}
                  </span>
                ) : null}
              </>
            )}
          </div>

          {row.branch ? (
            <AnimatePresence initial={false}>
              {row.open ? (
                <motion.ul
                  animate={{ height: "auto", opacity: 1 }}
                  className="overflow-hidden"
                  exit={
                    reduced
                      ? { opacity: 0, transition: STILL }
                      : {
                          height: 0,
                          opacity: 0,
                          transition: {
                            height: CLOSE_HEIGHT,
                            opacity: CLOSE_OPACITY,
                          },
                        }
                  }
                  initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  key="group"
                  role="group"
                  transition={
                    reduced
                      ? STILL
                      : { height: OPEN_HEIGHT, opacity: OPEN_OPACITY }
                  }
                >
                  <div className="ml-[15px] border-l border-border/70 pl-1.5">
                    {renderNodes(node.children ?? [], level + 1)}
                  </div>
                </motion.ul>
              ) : null}
            </AnimatePresence>
          ) : null}
        </li>
      );
    });

  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-border/70 bg-card p-1 shadow-sm",
        className,
      )}
    >
      <ul aria-label={label} className="space-y-0.5" role="tree">
        {renderNodes(nodes, 1)}
      </ul>
      <span className="sr-only" id={hintId}>
        使用方向键移动；右方向键展开目录，左方向键收起目录或返回父级；Home 和
        End 跳转到首尾，输入字母可跳转到对应名称。
      </span>
    </div>
  );
}
