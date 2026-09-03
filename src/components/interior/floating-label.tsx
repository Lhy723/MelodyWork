"use client";

import { motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  ComponentPropsWithoutRef,
  FocusEvent,
  ReactNode,
  Ref,
} from "react";

import { cn } from "@/lib/utils";

const INSTANT = { duration: 0 } as const;
const LIFT = {
  type: "spring",
  stiffness: 760,
  damping: 46,
  mass: 0.5,
} as const;
const RAISE = -32;
const SLIDE = -12;
const SHRINK = 0.92;

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export type UseFloatingLabelOptions = {
  defaultValue?: string;
  disabled?: boolean;
  value?: string;
};

export type UseFloatingLabelReturn = {
  fieldProps: {
    onBlur: () => void;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onFocus: () => void;
  };
  filled: boolean;
  focused: boolean;
  instant: boolean;
  length: number;
  raised: boolean;
  ref: React.RefObject<HTMLInputElement | null>;
};

type Fill = { instant: boolean; length: number };

export function useFloatingLabel({
  defaultValue,
  disabled = false,
  value,
}: UseFloatingLabelOptions = {}): UseFloatingLabelReturn {
  const ref = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(false);
  const [focused, setFocused] = useState(false);
  const [fill, setFill] = useState<Fill>({
    instant: true,
    length: (value ?? defaultValue ?? "").length,
  });

  const settle = useCallback((next: number, instant: boolean) => {
    setFill((previous) =>
      previous.length === next && previous.instant === instant
        ? previous
        : { instant, length: next },
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    const next =
      value !== undefined ? value.length : (element?.value.length ?? 0);
    settle(next, !mounted.current);
    mounted.current = true;
  }, [settle, value]);

  useEffect(() => {
    setFill((previous) =>
      previous.instant ? { ...previous, instant: false } : previous,
    );
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element || value !== undefined) return;

    const read = () => settle(element.value.length, false);
    element.addEventListener("input", read);
    element.addEventListener("change", read);
    return () => {
      element.removeEventListener("input", read);
      element.removeEventListener("change", read);
    };
  }, [settle, value]);

  useEffect(() => {
    if (disabled) setFocused(false);
  }, [disabled]);

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      settle(event.currentTarget.value.length, false),
    [settle],
  );

  return {
    fieldProps: { onBlur, onChange, onFocus },
    filled: fill.length > 0,
    focused,
    instant: fill.instant && !focused,
    length: fill.length,
    raised: focused || fill.length > 0,
    ref,
  };
}

export type FloatingLabelInputProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "onBlur" | "onChange" | "onFocus" | "placeholder" | "type" | "value"
> & {
  className?: string;
  defaultValue?: string;
  hint?: string;
  inputRef?: Ref<HTMLInputElement>;
  invalid?: boolean;
  label: ReactNode;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  type?: "email" | "password" | "search" | "tel" | "text" | "url";
  value?: string;
};

export function FloatingLabelInput({
  className,
  defaultValue,
  disabled = false,
  hint,
  id,
  inputRef,
  invalid = false,
  label,
  onBlur,
  onChange,
  onFocus,
  readOnly = false,
  required = false,
  type = "text",
  value,
  ...inputProps
}: FloatingLabelInputProps) {
  const auto = useId();
  const fieldId = id ?? `${auto}-field`;
  const hintId = `${auto}-hint`;
  const reduced = useReducedMotion();
  const { fieldProps, focused, instant, length, raised, ref } =
    useFloatingLabel({ defaultValue, disabled, value });
  const move = reduced || instant ? INSTANT : LIFT;

  const attach = useCallback(
    (node: HTMLInputElement | null) => {
      ref.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef, ref],
  );

  return (
    <div className={cn("w-full", className)}>
      <div className="relative pt-[20px]">
        <div
          className={cn(
            "relative h-10 rounded-[10px] border-2 transition-[background-color,border-color,box-shadow] duration-150",
            invalid
              ? "border-red-500 bg-white dark:border-red-400 dark:bg-[#252522]"
              : focused
                ? "border-[#4568FF] bg-white dark:border-[#93B0FF] dark:bg-[#252522]"
                : "border-stone-200 bg-stone-100/70 shadow-[inset_0_1px_2px_rgba(28,25,23,0.07)] dark:border-white/[0.08] dark:bg-[#1D1D1A] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]",
            disabled && "opacity-55",
          )}
        >
          <input
            {...inputProps}
            ref={attach}
            aria-describedby={hint ? hintId : undefined}
            aria-invalid={invalid || undefined}
            aria-required={required || undefined}
            autoComplete={inputProps.autoComplete}
            defaultValue={defaultValue}
            disabled={disabled}
            id={fieldId}
            name={inputProps.name}
            readOnly={readOnly}
            required={required}
            type={type}
            value={value}
            onBlur={(event) => {
              fieldProps.onBlur();
              onBlur?.(event);
            }}
            onChange={(event) => {
              fieldProps.onChange(event);
              onChange?.(event.currentTarget.value, event);
            }}
            onFocus={(event) => {
              fieldProps.onFocus();
              onFocus?.(event);
            }}
            className="absolute inset-0 h-full w-full rounded-[9px] bg-transparent px-3 py-0 text-[13px] leading-[20px] text-stone-700 outline-none focus-visible:outline-none disabled:cursor-not-allowed dark:text-stone-200"
          />
        </div>

        <motion.label
          animate={{
            scale: raised ? SHRINK : 1,
            x: raised ? SLIDE : 0,
            y: raised ? RAISE : 0,
          }}
          className={cn(
            "absolute left-3 top-[32px] block cursor-text select-none text-[13px] leading-[16px]",
            invalid
              ? "text-red-600 dark:text-red-400"
              : raised
                ? "text-stone-600 dark:text-stone-300"
                : "text-stone-400 dark:text-stone-500",
          )}
          htmlFor={fieldId}
          initial={false}
          style={{ originX: 0, originY: 0, willChange: "transform" }}
          transition={move}
        >
          {label}
          {required ? (
            <span
              aria-hidden
              className="ml-0.5 text-stone-400 dark:text-stone-500"
            >
              *
            </span>
          ) : null}
        </motion.label>
      </div>

      <div className="mt-1.5 flex h-[16px] items-start gap-3">
        <p
          aria-hidden={!hint}
          className={cn(
            "min-w-0 flex-1 truncate text-[11.5px] leading-[16px]",
            invalid
              ? "text-red-600 dark:text-red-400"
              : "text-stone-500 dark:text-stone-400",
          )}
        >
          {hint}
        </p>

        {inputProps.maxLength !== undefined ? (
          <span
            aria-hidden
            className="grid shrink-0 justify-items-end font-mono text-[10.5px] leading-[16px] tabular-nums text-stone-400 dark:text-stone-500"
          >
            <span className="invisible col-start-1 row-start-1">
              {inputProps.maxLength} / {inputProps.maxLength}
            </span>
            <span className="col-start-1 row-start-1">
              {length} / {inputProps.maxLength}
            </span>
          </span>
        ) : null}

        {hint ? (
          <span className="sr-only" id={hintId}>
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}
