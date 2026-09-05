"use client";

import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

const EASE = [0.23, 1, 0.32, 1] as const;
const DURATION = 0.6;

const HIDDEN = { opacity: 0, y: 10, filter: "blur(8px)" } as const;
const SHOWN = { opacity: 1, y: 0, filter: "blur(0px)" } as const;
const INSTANT = { duration: 0 } as const;
// Keep a rolling offset between stream commits so chunk boundaries do not
// restart the reveal sequence or make every chunk look like one animation.
const STREAMING_PHASE_WINDOW = 4;
const STREAMING_STAGGER = 0.08;
const CJK = /[\u2e80-\u9fff]/u;
const MARKDOWN_SYNTAX =
  /(?:^|\n)\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s|```|~~~)|(?:`[^`\n]+`|\*\*|__|~~|\[[^\]]+\]\([^)]+\))/u;

export type TextRevealSplit = "word" | "character";

export type TextRevealUnit = {
  key: string;
  text: string;
  index: number;
};

export type TextRevealGroup = {
  key: string;
  units: TextRevealUnit[];
};

type StreamingTextRevealUnit = {
  key: string;
  kind: "space" | "text";
  start: number;
  text: string;
};

type AnimatedStreamingTextRevealUnit = StreamingTextRevealUnit & {
  animationDelay: number | null;
};

/**
 * Completed Markdown should be rendered by Streamdown because it has its own
 * block and inline structure. During an active stream, callers may use these
 * units as a temporary raw-text surface so every appended character can keep
 * the reveal motion; the formatted renderer can take over once the turn ends.
 */
export const isTextRevealCompatible = (text: string) =>
  !MARKDOWN_SYNTAX.test(text);

const buildStreamingUnits = (
  text: string,
  by: TextRevealSplit,
  splitAt = 0,
  existingAnimationDelays?: ReadonlyMap<string, number>,
  keyPrefix = "",
): StreamingTextRevealUnit[] => {
  if (!text) {
    return [];
  }

  if (by === "character") {
    const units: StreamingTextRevealUnit[] = [];
    let offset = 0;

    for (const character of Array.from(text)) {
      const start = offset;
      offset += character.length;
      units.push({
        key: `${keyPrefix}c${start}`,
        kind: /\s/u.test(character) ? "space" : "text",
        start,
        text: character,
      });
    }

    return units;
  }

  const units: StreamingTextRevealUnit[] = [];
  const parts = text.match(/\S+|\s+/gu) ?? [];
  const existingWordBoundaries = new Set<number>();
  for (const key of existingAnimationDelays?.keys() ?? []) {
    const match = /(?:^|-)w(\d+)$/u.exec(key);
    if (match) {
      existingWordBoundaries.add(Number(match[1]));
    }
  }
  let offset = 0;

  for (const part of parts) {
    const start = offset;
    offset += part.length;
    if (!/^\s+$/u.test(part)) {
      // A streamed Latin word is often split in the middle (`hel` → `hell`
      // → `hello`). Keep every prior split boundary so React does not reuse
      // the original `w0` node for newly appended characters and silently
      // skip their animation.
      const boundaries = new Set<number>([start, offset]);
      if (splitAt > start && splitAt < offset) {
        boundaries.add(splitAt);
      }
      for (const boundary of existingWordBoundaries) {
        if (boundary > start && boundary < offset) {
          boundaries.add(boundary);
        }
      }
      const sortedBoundaries = [...boundaries].sort(
        (left, right) => left - right,
      );
      for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
        const segmentStart = sortedBoundaries[index];
        const segmentEnd = sortedBoundaries[index + 1];
        units.push({
          key: `${keyPrefix}w${segmentStart}`,
          kind: "text",
          start: segmentStart,
          text: text.slice(segmentStart, segmentEnd),
        });
      }
      continue;
    }
    units.push({
      key: `${keyPrefix}w${start}`,
      kind: /^\s+$/u.test(part) ? "space" : "text",
      start,
      text: part,
    });
  }

  return units;
};

export type UseTextRevealOptions = {
  text: string;
  by?: TextRevealSplit;
  stagger?: number;
  maxDuration?: number;
  startOnView?: boolean;
  play?: boolean;
  once?: boolean;
  amount?: number;
};

export function useTextReveal<T extends HTMLElement = HTMLSpanElement>({
  text,
  by = "word",
  stagger = 0.055,
  maxDuration = 1.2,
  startOnView = true,
  play = true,
  once = true,
  amount = 0.35,
}: UseTextRevealOptions) {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { once, amount });
  const reduced = useReducedMotion();

  const { groups, step, count } = useMemo(() => {
    const words = text.trim().length ? text.trim().split(/\s+/) : [];

    let index = 0;
    const built: TextRevealGroup[] = words.map((word, wordIndex) => ({
      key: `w${wordIndex}`,
      units:
        by === "character"
          ? Array.from(word).map((character, characterIndex) => ({
              key: `w${wordIndex}c${characterIndex}`,
              text: character,
              index: index++,
            }))
          : [
              {
                key: `w${wordIndex}`,
                text: word,
                index: index++,
              },
            ],
    }));

    const span = Math.max(0, maxDuration - DURATION);

    return {
      groups: built,
      count: index,
      step: index > 1 ? Math.min(stagger, span / (index - 1)) : 0,
    };
  }, [by, maxDuration, stagger, text]);

  const started = play && (!startOnView || inView);

  return {
    ref,
    groups,
    step,
    count,
    started,
    reduced: Boolean(reduced),
    duration: count > 1 ? (count - 1) * step + DURATION : DURATION,
  };
}

export type TextRevealProps = UseTextRevealOptions & {
  className?: string;
};

/**
 * Reveals short, static UI copy in reading order without hiding the full
 * sentence from assistive technology. Chinese copy should use `by="character"`
 * because it usually does not contain whitespace between words.
 */
export function TextReveal({
  text,
  by = "word",
  stagger = 0.055,
  maxDuration = 1.2,
  startOnView = true,
  play = true,
  once = true,
  amount = 0.35,
  className,
}: TextRevealProps) {
  const { ref, groups, step, started, reduced } =
    useTextReveal<HTMLSpanElement>({
      amount,
      by,
      maxDuration,
      once,
      play,
      startOnView,
      stagger,
      text,
    });

  return (
    <span
      ref={ref}
      className={cn("text-current", className)}
      data-slot="text-reveal"
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {groups.map((group, groupIndex) => (
          <Fragment key={group.key}>
            {groupIndex > 0 ? " " : null}
            <span
              className={cn(
                "align-baseline",
                (by === "word" ||
                  !CJK.test(group.units.map((unit) => unit.text).join(""))) &&
                  "inline-block whitespace-nowrap",
              )}
            >
              {group.units.map((unit) => (
                <motion.span
                  className="inline-block align-baseline"
                  initial={reduced ? false : HIDDEN}
                  animate={started ? SHOWN : HIDDEN}
                  key={unit.key}
                  transition={
                    reduced
                      ? INSTANT
                      : {
                          delay: started ? unit.index * step : 0,
                          duration: DURATION,
                          ease: EASE,
                        }
                  }
                >
                  {unit.text}
                </motion.span>
              ))}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}

export type UseStreamingTextRevealOptions = {
  text: string;
  by?: TextRevealSplit;
  stagger?: number;
  maxDuration?: number;
  startOnView?: boolean;
  play?: boolean;
  once?: boolean;
  amount?: number;
  streaming?: boolean;
  animateOnMount?: boolean;
};

export function useStreamingTextReveal<
  T extends HTMLElement = HTMLSpanElement,
>({
  text,
  by = "word",
  stagger = STREAMING_STAGGER,
  maxDuration = 1.2,
  startOnView = false,
  play = true,
  once = true,
  amount = 0.35,
  streaming = true,
  animateOnMount = streaming,
}: UseStreamingTextRevealOptions) {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { once, amount });
  const reduced = useReducedMotion();
  const previousTextRef = useRef<string | undefined>(undefined);
  const previousStreamingRef = useRef(false);
  const animationPhaseRef = useRef(0);
  const animationDelaysRef = useRef(new Map<string, number>());
  const keyRevisionRef = useRef(0);
  const keyRevisionTextRef = useRef<string | undefined>(undefined);
  const previousText = previousTextRef.current;
  const previousStreaming = previousStreamingRef.current;
  const hasPreviousText = previousText !== undefined;
  const isAppend = hasPreviousText && text.startsWith(previousText);
  if (
    hasPreviousText &&
    !isAppend &&
    text !== previousText &&
    keyRevisionTextRef.current !== text
  ) {
    keyRevisionRef.current += 1;
    keyRevisionTextRef.current = text;
  }
  const keyPrefix =
    keyRevisionRef.current > 0 ? `r${keyRevisionRef.current}-` : "";
  const animationPhase = isAppend ? animationPhaseRef.current : 0;
  const revealStart = isAppend ? previousText.length : 0;
  // Text can continue to grow during a render where ACP has already settled
  // the current message (for example while a tool event is being projected).
  // An append is the reliable signal here: if the text starts with the last
  // committed text, animate the newly inserted units even when the stream
  // flags briefly read false.
  const shouldAnimate = hasPreviousText
    ? isAppend || previousStreaming || streaming
    : animateOnMount;
  const phaseStagger = Math.min(
    Math.max(0, stagger),
    Math.max(0, maxDuration - DURATION) / (STREAMING_PHASE_WINDOW - 1),
  );

  const { units, newUnitCount, animationDelays } = useMemo(() => {
    const committedAnimationDelays = animationDelaysRef.current;
    const built = buildStreamingUnits(
      text,
      by,
      isAppend ? revealStart : 0,
      committedAnimationDelays,
      keyPrefix,
    );
    const nextAnimationDelays = new Map<string, number>();
    if (play && (!hasPreviousText || isAppend)) {
      for (const unit of built) {
        const delay = committedAnimationDelays.get(unit.key);
        if (delay !== undefined) {
          nextAnimationDelays.set(unit.key, delay);
        }
      }
    }

    let animatedIndex = 0;
    const animatedUnits: AnimatedStreamingTextRevealUnit[] = built.map(
      (unit) => {
        if (unit.kind === "space") {
          return { ...unit, animationDelay: null };
        }

        let animationDelay = nextAnimationDelays.get(unit.key) ?? null;
        const isNew =
          play &&
          shouldAnimate &&
          animationDelay === null &&
          (!hasPreviousText || !isAppend || unit.start >= revealStart);
        if (isNew) {
          animationDelay =
            ((animationPhase + animatedIndex++) % STREAMING_PHASE_WINDOW) *
            phaseStagger;
          nextAnimationDelays.set(unit.key, animationDelay);
        }

        return { ...unit, animationDelay };
      },
    );

    return {
      animationDelays: nextAnimationDelays,
      units: animatedUnits,
      newUnitCount: animatedIndex,
    };
  }, [
    by,
    hasPreviousText,
    isAppend,
    animationPhase,
    phaseStagger,
    keyPrefix,
    play,
    revealStart,
    shouldAnimate,
    text,
  ]);

  useLayoutEffect(() => {
    animationDelaysRef.current = animationDelays;
    animationPhaseRef.current = isAppend
      ? (animationPhaseRef.current + newUnitCount) % STREAMING_PHASE_WINDOW
      : newUnitCount % STREAMING_PHASE_WINDOW;
    previousTextRef.current = text;
    previousStreamingRef.current = streaming;
  }, [animationDelays, isAppend, newUnitCount, streaming, text]);

  const started = play && (!startOnView || inView);

  return {
    ref,
    units,
    started,
    reduced: Boolean(reduced),
  };
}

export type StreamingTextRevealProps = UseStreamingTextRevealOptions & {
  className?: string;
};

/**
 * Incrementally reveals appended stream text with TextReveal's visual motion.
 * Existing units stay visible and only units added since the previous commit
 * animate, so frequent stream updates never replay the whole response.
 */
export function StreamingTextReveal({
  text,
  by = "word",
  stagger = STREAMING_STAGGER,
  maxDuration = 1.2,
  startOnView = false,
  play = true,
  once = true,
  amount = 0.35,
  streaming = true,
  animateOnMount = streaming,
  className,
}: StreamingTextRevealProps) {
  const { ref, units, started, reduced } = useStreamingTextReveal({
    amount,
    animateOnMount,
    by,
    maxDuration,
    once,
    play,
    startOnView,
    stagger,
    streaming,
    text,
  });

  return (
    <span
      ref={ref}
      aria-busy={streaming}
      className={cn("whitespace-pre-wrap text-current", className)}
      data-slot="streaming-text-reveal"
    >
      <span aria-live={streaming ? undefined : "polite"} className="sr-only">
        {streaming ? "" : text}
      </span>
      <span aria-hidden="true">
        {units.map((unit) => {
          if (unit.kind === "space") {
            return <Fragment key={unit.key}>{unit.text}</Fragment>;
          }

          const isAnimated = unit.animationDelay !== null;
          const revealStyle = isAnimated
            ? ({
                "--motion-text-reveal-delay": `${(unit.animationDelay ?? 0) * 1000}ms`,
                animationPlayState: started ? "running" : "paused",
              } as CSSProperties)
            : undefined;

          if (reduced || !isAnimated) {
            return (
              <span className="inline-block align-baseline" key={unit.key}>
                {unit.text}
              </span>
            );
          }

          return (
            <span
              className="text-reveal-streaming-unit inline-block align-baseline"
              data-reveal-started={started}
              key={unit.key}
              style={revealStyle}
            >
              {unit.text}
            </span>
          );
        })}
      </span>
    </span>
  );
}
