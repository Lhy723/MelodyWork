"use client";

import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

const PATH_TRANSITION = {
  type: "spring",
  stiffness: 460,
  damping: 31,
  mass: 0.7,
} as const;
const INSTANT = { duration: 0 } as const;

export type IconMorphShape = {
  d: readonly string[];
  rotate?: number;
};

export type IconMorphIconProps = {
  /** Selects the first or last frame when passed a boolean, or a frame index. */
  active?: boolean | number;
  className?: string;
  mode?: "fill" | "stroke";
  shapes: readonly IconMorphShape[];
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
};

function frameIndex(active: boolean | number, frameCount: number) {
  if (frameCount <= 1) return 0;
  if (typeof active === "boolean") return active ? frameCount - 1 : 0;
  return Math.min(frameCount - 1, Math.max(0, Math.round(active)));
}

function isCollapsed(path: string) {
  const values = path.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  if (values.length < 4) return false;
  const [x, y] = values;
  return values.every((value, index) => value === (index % 2 === 0 ? x : y));
}

function normalizeShapes(shapes: readonly IconMorphShape[]) {
  const slots = Math.max(1, ...shapes.map((shape) => shape.d.length));
  const fallback = "M 12 12 L 12 12";

  return shapes.map((shape) => ({
    d: Array.from(
      { length: slots },
      (_, index) => shape.d[index] ?? shape.d[shape.d.length - 1] ?? fallback,
    ),
    rotate: shape.rotate ?? 0,
  }));
}

/**
 * A visual-only Icon Morph surface for existing buttons.
 *
 * Interior's full component owns a button. MelodyWork already has buttons
 * with their own variants and event handlers, so this adapter keeps the
 * morphing SVG separate and lets callers retain those semantics.
 */
export function IconMorphIcon({
  active = false,
  className,
  mode = "stroke",
  shapes,
  size = 16,
  strokeWidth = 1.8,
  style,
}: IconMorphIconProps) {
  const reduced = useReducedMotion();
  const frames = useMemo(() => normalizeShapes(shapes), [shapes]);
  const index = frameIndex(active, frames.length);
  const frame = frames[index];
  const pathTransition = reduced ? INSTANT : PATH_TRANSITION;

  if (!frame) return null;

  return (
    <motion.span
      aria-hidden="true"
      animate={{ rotate: frame.rotate }}
      className={cn("inline-grid shrink-0 place-items-center", className)}
      initial={false}
      style={{ height: size, width: size, ...style }}
      transition={pathTransition}
    >
      <svg
        aria-hidden="true"
        className="size-full overflow-visible"
        fill={mode === "fill" ? "currentColor" : "none"}
        viewBox="0 0 24 24"
      >
        {frame.d.map((path, pathIndex) => (
          <motion.path
            animate={{
              d: path,
              opacity: isCollapsed(path) ? 0 : 1,
            }}
            initial={false}
            key={pathIndex}
            stroke={mode === "stroke" ? "currentColor" : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
            transition={pathTransition}
          />
        ))}
      </svg>
    </motion.span>
  );
}

/** Reusable line-based frames used by the app's existing toggle buttons. */
export const ICON_MORPH_SHAPES = {
  chevronRightDown: [
    {
      d: ["M 9 6 L 15 12", "M 15 12 L 9 18"],
    },
    {
      d: ["M 6 9 L 12 15", "M 12 15 L 18 9"],
    },
  ],
  filterClose: [
    {
      d: ["M 4 6 L 20 6", "M 7 12 L 17 12", "M 10 18 L 14 18"],
    },
    {
      d: ["M 6 6 L 18 18", "M 18 6 L 6 18", "M 12 12 L 12 12"],
    },
  ],
  maximizeMinimize: [
    {
      d: [
        "M 9 4 L 4 4",
        "M 4 4 L 4 9",
        "M 15 4 L 20 4",
        "M 20 4 L 20 9",
        "M 9 20 L 4 20",
        "M 4 20 L 4 15",
        "M 15 20 L 20 20",
        "M 20 20 L 20 15",
      ],
    },
    {
      d: [
        "M 5 14 L 10 14",
        "M 10 14 L 10 19",
        "M 14 14 L 14 19",
        "M 14 14 L 19 14",
        "M 5 10 L 10 10",
        "M 10 10 L 10 5",
        "M 14 10 L 14 5",
        "M 14 10 L 19 10",
      ],
    },
  ],
  menuClose: [
    {
      d: ["M 5 6 L 19 6", "M 5 12 L 19 12", "M 5 18 L 19 18"],
    },
    {
      d: ["M 6 6 L 18 18", "M 18 6 L 6 18", "M 12 12 L 12 12"],
    },
  ],
  panelClose: [
    {
      d: [
        "M 4 4 L 20 4",
        "M 20 4 L 20 20",
        "M 20 20 L 4 20",
        "M 4 20 L 4 4",
        "M 15 4 L 15 20",
      ],
    },
    {
      d: [
        "M 6 6 L 18 18",
        "M 18 6 L 6 18",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
      ],
    },
  ],
  searchClose: [
    {
      d: [
        "M 12 4 L 16 6",
        "M 16 6 L 18 10",
        "M 18 10 L 16 14",
        "M 16 14 L 12 16",
        "M 12 16 L 8 14",
        "M 8 14 L 6 10",
        "M 6 10 L 8 6",
        "M 8 6 L 12 4",
        "M 16 14 L 20 18",
      ],
    },
    {
      d: [
        "M 6 6 L 18 18",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 12 12 L 12 12",
        "M 18 6 L 6 18",
      ],
    },
  ],
  sendStop: [
    {
      d: ["M 12 19 L 12 5", "M 7 10 L 12 5", "M 12 5 L 17 10", "M 12 5 L 12 5"],
    },
    {
      d: ["M 7 7 L 17 7", "M 17 7 L 17 17", "M 17 17 L 7 17", "M 7 17 L 7 7"],
    },
  ],
} as const;
