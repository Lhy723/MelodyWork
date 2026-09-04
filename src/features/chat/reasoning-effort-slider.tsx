import {
  ChevronDownIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Popover } from "@/components/interior/popover";
import { SliderDetents } from "@/components/interior/slider-detents";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentReasoningEffortOption } from "@/domain/acp";

interface ReasoningEffortSliderProps {
  disabled: boolean;
  loading: boolean;
  onValueChange: (value: string) => void;
  options: AgentReasoningEffortOption[];
  value?: string;
}

const reasoningEffortOrder: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
};

const orderReasoningOptions = (options: AgentReasoningEffortOption[]) =>
  options
    .map((option, index) => ({ index, option }))
    .sort((left, right) => {
      const leftOrder =
        reasoningEffortOrder[left.option.value] ?? Number.MAX_SAFE_INTEGER;
      const rightOrder =
        reasoningEffortOrder[right.option.value] ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ option }) => option);

export function ReasoningEffortSlider({
  disabled,
  loading,
  onValueChange,
  options,
  value,
}: ReasoningEffortSliderProps) {
  const orderedOptions = useMemo(
    () => orderReasoningOptions(options),
    [options],
  );
  const selectedIndex = Math.max(
    0,
    orderedOptions.findIndex((option) => option.value === value),
  );
  const lastIndex = Math.max(0, orderedOptions.length - 1);
  const [draftIndex, setDraftIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!loading) {
      setDraftIndex(selectedIndex);
    }
  }, [loading, selectedIndex]);

  const clampedDraftIndex = Math.min(lastIndex, Math.max(0, draftIndex));
  const selectedOption = orderedOptions[clampedDraftIndex] ?? orderedOptions[0];
  const committedOption = orderedOptions[selectedIndex] ?? orderedOptions[0];
  const helpText = useMemo(
    () =>
      selectedOption?.description ??
      "在响应速度与推理深度之间调整。不同模型提供的档位可能不同。",
    [selectedOption],
  );

  const detents = useMemo(
    () =>
      orderedOptions.map((option, index) => ({
        label: option.label,
        value: index,
      })),
    [orderedOptions],
  );

  const formatSliderValue = (index: number) =>
    orderedOptions[Math.round(index)]?.label ?? "未选择";

  const handleSliderChange = (nextValue: number) => {
    setDraftIndex(Math.min(lastIndex, Math.max(0, Math.round(nextValue))));
  };

  const handleSliderCommit = (nextValue: number) => {
    const nextIndex = Math.min(lastIndex, Math.max(0, Math.round(nextValue)));
    const nextOption = orderedOptions[nextIndex];
    if (nextOption && nextOption.value !== value) {
      onValueChange(nextOption.value);
    }
  };

  return (
    <Popover
      align="start"
      className="w-56 p-3"
      disabled={disabled}
      label="思考强度设置"
      side="top"
      trigger={
        <>
          {loading ? <LoaderCircleIcon className="animate-spin" /> : null}
          <span className="truncate">
            {committedOption?.label ?? "思考强度"}
          </span>
          <ChevronDownIcon className="size-3.5" />
        </>
      }
      triggerAriaLabel={`思考强度：${committedOption?.label ?? "未选择"}`}
      triggerClassName="motion-view-enter max-w-40 gap-2 rounded-[calc(var(--radius)-3px)] border-transparent bg-transparent px-2.5 text-muted-foreground shadow-none hover:bg-muted/80"
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

      <SliderDetents
        className="mt-1"
        detents={detents}
        disabled={disabled}
        format={formatSliderValue}
        haptic={false}
        label="思考强度"
        max={lastIndex}
        onValueChange={handleSliderChange}
        onValueCommit={handleSliderCommit}
        showHeader={false}
        value={clampedDraftIndex}
      />
    </Popover>
  );
}
