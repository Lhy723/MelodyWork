"use client";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

export interface ContextCost {
  amount: number;
  currency: string;
}

interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  cost?: ContextCost;
}

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);
  if (!context) {
    throw new Error("Context components must be used within Context");
  }
  return context;
};

const compactTokens = (tokens: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(tokens);

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({
  usedTokens,
  maxTokens,
  cost,
  ...props
}: ContextProps) => {
  const contextValue = useMemo(
    () => ({ cost, maxTokens, usedTokens }),
    [cost, maxTokens, usedTokens],
  );

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard closeDelay={0} openDelay={100} {...props} />
    </ContextContext.Provider>
  );
};

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = Math.min(1, Math.max(0, usedTokens / maxTokens));
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-label="模型上下文用量"
      height="20"
      role="img"
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const usedPercent = Math.min(1, Math.max(0, usedTokens / maxTokens));
  const renderedPercent = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(usedPercent);

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <ContextIcon />
          <span className="font-medium text-muted-foreground">
            {renderedPercent}
          </span>
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({
  className,
  ...props
}: ContextContentProps) => (
  <HoverCardContent
    className={cn("min-w-64 divide-y overflow-hidden p-0", className)}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const usedPercent = Math.min(1, Math.max(0, usedTokens / maxTokens));
  const displayPercent = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(usedPercent);

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span>上下文窗口</span>
            <span className="font-mono text-muted-foreground">
              {compactTokens(usedTokens)} / {compactTokens(maxTokens)}
            </span>
          </div>
          <Progress value={usedPercent * PERCENT_MAX} />
          <p className="text-muted-foreground text-xs">
            {displayPercent} used
          </p>
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({
  children,
  className,
  ...props
}: ContextContentBodyProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const remainingTokens = Math.max(0, maxTokens - usedTokens);

  return (
    <div
      className={cn("w-full space-y-2 p-3 text-xs", className)}
      {...props}
    >
      {children ?? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">已使用</span>
            <span>{usedTokens.toLocaleString("en-US")}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">剩余</span>
            <span>{remainingTokens.toLocaleString("en-US")}</span>
          </div>
        </>
      )}
    </div>
  );
};

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { cost } = useContextValue();
  if (!children && !cost) {
    return null;
  }

  const formattedCost = cost
    ? new Intl.NumberFormat("en-US", {
        currency: cost.currency,
        style: "currency",
      }).format(cost.amount)
    : undefined;

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">会话费用</span>
          <span>{formattedCost}</span>
        </>
      )}
    </div>
  );
};
