"use client";

import {
  motion,
  useMotionTemplate,
  useReducedMotion,
  useSpring,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { cn } from "@/lib/utils";

const CARRIAGE = { stiffness: 520, damping: 34, mass: 0.45 } as const;
const GRAB = {
  type: "spring",
  stiffness: 700,
  damping: 46,
  mass: 0.5,
} as const;
const CROSSFADE = {
  type: "spring",
  stiffness: 260,
  damping: 34,
  mass: 0.8,
} as const;
const INSTANT = { duration: 0 } as const;
const THUMB = 18;
const NONE: readonly (number | SliderDetent)[] = [];

const plain = (value: number) => String(value);

const tidy = (value: number) => Math.round(value * 1e6) / 1e6;

export type SliderDetent = { value: number; label?: string };

export type UseSliderDetentsOptions = {
  disabled?: boolean;
  detents?: readonly (number | SliderDetent)[];
  format?: (value: number) => string;
  haptic?: boolean;
  label?: string;
  labelledBy?: string;
  max?: number;
  min?: number;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
  pull?: number;
  step?: number;
  thumbSize?: number;
  value: number;
};

/**
 * Tracks a numeric slider that snaps to named detents while preserving the
 * native keyboard and pointer affordances of a single accessible slider.
 * `onValueChange` is useful for a local draft; `onValueCommit` fires when a
 * pointer or keyboard interaction ends so callers can persist the selection
 * once instead of once per drag step.
 */
export function useSliderDetents({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  detents = NONE,
  pull,
  thumbSize = THUMB,
  disabled = false,
  haptic = true,
  format = plain,
  label,
  labelledBy,
}: UseSliderDetentsOptions) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const list = useMemo(
    () =>
      detents.map((detent) =>
        typeof detent === "number" ? { value: detent } : detent,
      ),
    [detents],
  );

  const range = max - min;
  const grab = pull ?? range * 0.045;
  const emit = useRef(onValueChange);
  const commitValue = useRef(onValueCommit);
  const emitted = useRef(value);
  const settled = useRef(value);
  const held = useRef(false);
  const keyboardActive = useRef(false);
  emit.current = onValueChange;
  commitValue.current = onValueCommit;
  emitted.current = value;
  if (!held.current && !keyboardActive.current) {
    settled.current = value;
  }

  const activeDetent = useMemo(
    () => list.findIndex((detent) => tidy(detent.value) === tidy(value)),
    [list, value],
  );
  const marked = useRef(activeDetent);

  const commit = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return;
      const settledValue = Math.min(max, Math.max(min, tidy(next)));
      const index = list.findIndex(
        (detent) => tidy(detent.value) === settledValue,
      );
      if (index !== marked.current) {
        marked.current = index;
        if (haptic && index >= 0) navigator.vibrate?.(6);
      }
      settled.current = settledValue;
      if (settledValue !== emitted.current) {
        emitted.current = settledValue;
        emit.current(settledValue);
      }
    },
    [haptic, list, max, min],
  );

  const capture = useCallback(
    (clientX: number) => {
      const element = trackRef.current;
      if (!element || range <= 0) return null;
      const rect = element.getBoundingClientRect();
      const travel = rect.width - thumbSize;
      if (travel <= 0) return null;

      const ratio = (clientX - rect.left - thumbSize / 2) / travel;
      const raw = Math.min(max, Math.max(min, min + ratio * range));

      let nearestIndex = -1;
      let nearestDistance = grab;
      for (let index = 0; index < list.length; index += 1) {
        const detent = list[index];
        if (!detent) continue;
        const distance = Math.abs(raw - detent.value);
        if (distance <= nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      }
      if (nearestIndex >= 0) return list[nearestIndex]?.value ?? null;
      return min + Math.round((raw - min) / step) * step;
    },
    [grab, list, max, min, range, step, thumbSize],
  );

  const finishKeyboard = useCallback(() => {
    if (!keyboardActive.current) return;
    keyboardActive.current = false;
    commitValue.current?.(settled.current);
  }, []);

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    setDragging(false);
    commitValue.current?.(settled.current);
  }, []);

  const toDetent = useCallback(
    (direction: number) => {
      const sorted = list
        .map((detent) => detent.value)
        .slice()
        .sort((a, b) => a - b);
      const forward = sorted.find((detent) => detent > settled.current + 1e-6);
      const backward = [...sorted]
        .reverse()
        .find((detent) => detent < settled.current - 1e-6);
      const target = direction > 0 ? forward : backward;
      commit(target ?? (direction > 0 ? max : min));
    },
    [commit, list, max, min],
  );

  useEffect(() => {
    const blur = () => {
      release();
      finishKeyboard();
    };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [finishKeyboard, release]);

  useEffect(() => {
    if (!disabled) return;
    release();
    finishKeyboard();
  }, [disabled, finishKeyboard, release]);

  useEffect(() => {
    if (!dragging) return;

    const documentElement = document.documentElement;
    const body = document.body;
    const previousDocumentSelection = documentElement.style.userSelect;
    const previousBodySelection = body.style.userSelect;
    const preventSelection = (event: Event) => event.preventDefault();

    documentElement.style.userSelect = "none";
    body.style.userSelect = "none";
    window.addEventListener("selectstart", preventSelection);
    window.addEventListener("dragstart", preventSelection);

    return () => {
      documentElement.style.userSelect = previousDocumentSelection;
      body.style.userSelect = previousBodySelection;
      window.removeEventListener("selectstart", preventSelection);
      window.removeEventListener("dragstart", preventSelection);
    };
  }, [dragging]);

  const detentLabel = list[activeDetent]?.label;
  const formattedValue = format(value);
  const valueText =
    detentLabel && detentLabel !== formattedValue
      ? `${formattedValue}, ${detentLabel}`
      : formattedValue;
  const percent =
    range > 0 ? Math.min(1, Math.max(0, (value - min) / range)) : 0;

  const trackProps = {
    role: "slider" as const,
    tabIndex: disabled ? -1 : 0,
    "aria-orientation": "horizontal" as const,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": value,
    "aria-valuetext": valueText,
    "aria-disabled": disabled || undefined,
    "aria-label": labelledBy ? undefined : label,
    "aria-labelledby": labelledBy,
    style: { touchAction: "none" as const },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      held.current = true;
      keyboardActive.current = false;
      setDragging(true);
      const next = capture(event.clientX);
      if (next !== null) commit(next);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!held.current) return;
      event.preventDefault();
      const next = capture(event.clientX);
      if (next !== null) commit(next);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onBlur: finishKeyboard,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const forward = event.key === "ArrowRight" || event.key === "ArrowUp";
      const back = event.key === "ArrowLeft" || event.key === "ArrowDown";

      if (forward || back) {
        const direction = forward ? 1 : -1;
        keyboardActive.current = true;
        if (event.shiftKey) toDetent(direction);
        else commit(settled.current + direction * step);
      } else if (event.key === "PageUp") {
        keyboardActive.current = true;
        toDetent(1);
      } else if (event.key === "PageDown") {
        keyboardActive.current = true;
        toDetent(-1);
      } else if (event.key === "Home") {
        keyboardActive.current = true;
        commit(min);
      } else if (event.key === "End") {
        keyboardActive.current = true;
        commit(max);
      } else {
        return;
      }
      event.preventDefault();
    },
    onKeyUp: (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        finishKeyboard();
      }
    },
  };

  return {
    activeDetent,
    detents: list,
    dragging,
    percent,
    trackProps,
    trackRef,
    valueText,
  };
}

export type SliderDetentsProps = {
  className?: string;
  disabled?: boolean;
  detents?: readonly (number | SliderDetent)[];
  format?: (value: number) => string;
  haptic?: boolean;
  label?: string;
  max?: number;
  min?: number;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
  pull?: number;
  showHeader?: boolean;
  step?: number;
  value: number;
};

/**
 * Interior's detent slider adapted to MelodyWork's theme tokens. Set
 * `showHeader={false}` when a surrounding control already owns the label and
 * readout, while retaining the same accessible slider semantics.
 */
export function SliderDetents({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  detents = NONE,
  pull,
  label = "Value",
  format = plain,
  disabled = false,
  haptic = true,
  showHeader = true,
  className,
}: SliderDetentsProps) {
  const labelId = useId();
  const reduced = useReducedMotion();
  const {
    trackRef,
    trackProps,
    detents: list,
    activeDetent,
    percent,
    dragging,
  } = useSliderDetents({
    value,
    onValueChange,
    onValueCommit,
    min,
    max,
    step,
    detents,
    pull,
    disabled,
    haptic,
    format,
    labelledBy: labelId,
  });

  const carriage = useSpring(percent * 100, CARRIAGE);
  const offset = useMotionTemplate`${carriage}%`;

  useEffect(() => {
    const target = percent * 100;
    if (reduced) carriage.jump(target);
    else carriage.set(target);
  }, [carriage, percent, reduced]);

  const widest = useMemo(() => {
    const values = [
      format(min),
      format(max),
      ...list.map((detent) =>
        detent.label
          ? `${format(detent.value)} · ${detent.label}`
          : format(detent.value),
      ),
    ];
    return values.reduce(
      (longest, current) =>
        current.length > longest.length ? current : longest,
      "",
    );
  }, [format, list, max, min]);
  const suffix = list[activeDetent]?.label ?? "";
  const lastLabel = useRef(suffix);
  if (suffix) lastLabel.current = suffix;
  const span = max - min;

  return (
    <div
      className={cn("w-full select-none", className)}
      onPointerDownCapture={(event) => event.preventDefault()}
    >
      {showHeader ? (
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] text-muted-foreground" id={labelId}>
            {label}
          </span>
          <span className="grid justify-items-start">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 whitespace-pre font-mono text-[11px] tabular-nums"
            >
              {widest}
            </span>
            <span className="col-start-1 row-start-1 whitespace-pre font-mono text-[11px] tabular-nums text-foreground">
              {format(value)}
              <motion.span
                animate={{ opacity: suffix ? 1 : 0 }}
                aria-hidden="true"
                className="text-muted-foreground"
                initial={false}
                transition={reduced ? INSTANT : CROSSFADE}
              >
                {lastLabel.current ? ` · ${lastLabel.current}` : ""}
              </motion.span>
            </span>
          </span>
        </div>
      ) : (
        <span className="sr-only" id={labelId}>
          {label}
        </span>
      )}

      <div
        ref={trackRef}
        {...trackProps}
        className={cn(
          "relative h-9 w-full rounded-[9px] outline-none focus-visible:bg-ring/5 focus-visible:shadow-[inset_0_0_0_1px_var(--ring)] dark:focus-visible:bg-ring/10",
          disabled
            ? "pointer-events-none opacity-50"
            : dragging
              ? "cursor-grabbing"
              : "cursor-grab",
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-[9px] h-[10px] overflow-hidden rounded-[5px] bg-muted dark:bg-muted/80">
          <div
            className="absolute inset-y-0"
            style={{ left: THUMB / 2, right: THUMB / 2 }}
          >
            <motion.div
              className="absolute inset-y-0 left-0 right-0"
              style={{ x: offset }}
            >
              <div className="absolute inset-y-0 right-full w-[2000px] bg-foreground" />
            </motion.div>
          </div>
        </div>

        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ left: THUMB / 2, right: THUMB / 2 }}
        >
          {list.map((detent) => (
            <span
              aria-hidden="true"
              className="absolute top-[26px] block h-[5px] w-[2px] -translate-x-1/2 bg-foreground/35"
              key={String(detent.value)}
              style={{
                left:
                  span > 0 ? `${((detent.value - min) / span) * 100}%` : "0%",
              }}
            />
          ))}
        </div>

        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ left: THUMB / 2, right: THUMB / 2 }}
        >
          <motion.div
            className="absolute inset-y-0 left-0 right-0"
            style={{ x: offset }}
          >
            <motion.div
              animate={{ scale: dragging ? 1.08 : 1 }}
              className="absolute top-[4px] h-[20px] w-[18px] rounded-[6px] border-2 border-background bg-foreground shadow-sm"
              initial={false}
              style={{ marginLeft: -THUMB / 2 }}
              transition={reduced ? INSTANT : GRAB}
            />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
