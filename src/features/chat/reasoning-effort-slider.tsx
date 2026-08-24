import {
  ChevronDownIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentReasoningEffortOption } from "@/domain/acp";
import { cn } from "@/lib/utils";

interface ReasoningEffortSliderProps {
  disabled: boolean;
  loading: boolean;
  onValueChange: (value: string) => void;
  options: AgentReasoningEffortOption[];
  value?: string;
}

const flickerPixels = Array.from({ length: 34 }, (_, index) => ({
  delay: `${-((index * 0.23) % 2.7).toFixed(2)}s`,
  duration: `${(1.45 + ((index * 17) % 11) * 0.13).toFixed(2)}s`,
  left: `${3 + ((index * 29) % 94)}%`,
  top: `${10 + ((index * 37) % 78)}%`,
}));

export function ReasoningEffortSlider({
  disabled,
  loading,
  onValueChange,
  options,
  value,
}: ReasoningEffortSliderProps) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const lastIndex = Math.max(0, options.length - 1);
  const selectedProgress =
    lastIndex === 0 ? 100 : (selectedIndex / lastIndex) * 100;
  const [draftProgress, setDraftProgress] = useState(selectedProgress);
  const draftProgressRef = useRef(selectedProgress);

  useEffect(() => {
    setDraftProgress(selectedProgress);
    draftProgressRef.current = selectedProgress;
  }, [selectedProgress]);

  const draftIndex =
    lastIndex === 0 ? 0 : Math.round((draftProgress / 100) * lastIndex);
  const selectedOption = options[draftIndex] ?? options[0];
  const committedOption = options[selectedIndex] ?? options[0];
  const isMaximum = options.length > 1 && draftProgress >= 100;
  const fillWidth = `calc(${draftProgress}% + ${(26 * (1 - draftProgress / 100)).toFixed(2)}px)`;
  const helpText = useMemo(
    () =>
      selectedOption?.description ??
      "在响应速度与推理深度之间调整。不同模型提供的档位可能不同。",
    [selectedOption],
  );

  const updateDraft = (nextProgress: number) => {
    const clampedProgress = Math.min(100, Math.max(0, nextProgress));
    draftProgressRef.current = clampedProgress;
    setDraftProgress(clampedProgress);
  };

  const commitDraft = () => {
    const nextIndex =
      lastIndex === 0
        ? 0
        : Math.round((draftProgressRef.current / 100) * lastIndex);
    const nextOption = options[nextIndex];
    if (nextOption && nextOption.value !== value) {
      onValueChange(nextOption.value);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    updateDraft(Number(event.currentTarget.value));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (lastIndex === 0) {
      return;
    }

    const currentIndex = Math.round(
      (draftProgressRef.current / 100) * lastIndex,
    );
    let nextIndex: number | undefined;

    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextIndex = Math.min(lastIndex, currentIndex + 1);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex !== undefined) {
      event.preventDefault();
      updateDraft((nextIndex / lastIndex) * 100);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <PromptInputButton
          aria-label={`思考强度：${committedOption?.label ?? "未选择"}`}
          className="motion-view-enter max-w-40"
          disabled={disabled}
        >
          {loading ? <LoaderCircleIcon className="animate-spin" /> : null}
          <span className="truncate">
            {committedOption?.label ?? "思考强度"}
          </span>
          <ChevronDownIcon className="size-3.5" />
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 rounded-xl p-3"
        side="top"
        sideOffset={8}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm text-muted-foreground">
            <span>思考强度 </span>
            <span className="font-medium text-violet-500">
              {selectedOption?.label}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="查看思考强度说明"
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                <CircleHelpIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64" side="top" sideOffset={6}>
              {helpText}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mt-2.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>更快</span>
          <span>更聪明</span>
        </div>

        <div
          className={cn(
            "reasoning-effort-track mt-1.5",
            isMaximum && "is-maximum",
          )}
        >
          <div
            aria-hidden="true"
            className="reasoning-effort-fill"
            style={{ width: fillWidth }}
          />
          <div
            aria-hidden="true"
            className="reasoning-effort-grid"
            style={{ width: fillWidth }}
          />
          <div
            aria-hidden="true"
            className="reasoning-effort-pixels"
            style={{ width: fillWidth }}
          >
            {flickerPixels.map((pixel) => (
              <span
                className="reasoning-effort-pixel"
                key={`${pixel.left}-${pixel.top}`}
                style={{
                  animationDelay: pixel.delay,
                  animationDuration: pixel.duration,
                  left: pixel.left,
                  top: pixel.top,
                }}
              />
            ))}
          </div>
          <input
            aria-label="思考强度"
            aria-valuetext={selectedOption?.label}
            className="reasoning-effort-range"
            disabled={disabled}
            max={100}
            min={0}
            onBlur={commitDraft}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={commitDraft}
            onPointerCancel={commitDraft}
            onPointerUp={commitDraft}
            step={1}
            type="range"
            value={draftProgress}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
