import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentPlanDecision,
  TimelineEntry,
} from "@/domain/acp";
import {
  BanIcon,
  CheckIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

type PlanTimelineEntryValue = Extract<TimelineEntry, { kind: "plan" }>;

interface PlanTimelineEntryProps {
  entry: PlanTimelineEntryValue;
  onDecision: (
    entryId: string,
    outcome: AgentPlanDecision,
    feedback?: string,
  ) => void;
  renderedContent: ReactNode;
}

const planDescription = (entry: PlanTimelineEntryValue) => {
  switch (entry.status) {
    case "streaming":
      return "Melody 正在制定实施步骤";
    case "awaiting-approval":
      return "请审阅计划，然后决定是否开始实施";
    case "approved":
      return "计划已批准，Melody 将开始实施";
    case "changes-requested":
      return "已将修改意见发回 Melody";
    case "abandoned":
      return "计划已放弃";
    case "superseded":
      return "此计划已被更新版本取代";
  }
};

export function PlanTimelineEntry({
  entry,
  onDecision,
  renderedContent,
}: PlanTimelineEntryProps) {
  const [editingFeedback, setEditingFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const awaiting = entry.status === "awaiting-approval";

  return (
    <Plan
      className="w-full rounded-xl bg-card/70"
      defaultOpen
      isStreaming={entry.status === "streaming"}
    >
      <PlanHeader className="items-start">
        <div className="space-y-1">
          <PlanTitle>实施计划</PlanTitle>
          <PlanDescription>{planDescription(entry)}</PlanDescription>
        </div>
        <PlanAction>
          <PlanTrigger aria-label="展开或收起实施计划" />
        </PlanAction>
      </PlanHeader>
      <PlanContent className="border-t pt-4">
        {renderedContent}
      </PlanContent>
      {awaiting ? (
        <PlanFooter className="flex-col items-stretch gap-3">
          {editingFeedback ? (
            <div className="space-y-2">
              <Textarea
                autoFocus
                className="min-h-20 resize-y bg-background"
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="告诉 Melody 需要怎样修改这份计划…"
                value={feedback}
              />
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => {
                    setEditingFeedback(false);
                    setFeedback("");
                  }}
                  size="sm"
                  variant="ghost"
                >
                  取消
                </Button>
                <Button
                  disabled={!feedback.trim()}
                  onClick={() =>
                    onDecision(entry.id, "cancelled", feedback)
                  }
                  size="sm"
                  variant="outline"
                >
                  发送修改意见
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-wrap justify-end gap-2">
              <Button
                onClick={() => onDecision(entry.id, "abandoned")}
                size="sm"
                variant="ghost"
              >
                <BanIcon />
                放弃计划
              </Button>
              <Button
                onClick={() => setEditingFeedback(true)}
                size="sm"
                variant="outline"
              >
                <MessageSquareTextIcon />
                提出修改
              </Button>
              <Button
                onClick={() => onDecision(entry.id, "approved")}
                size="sm"
              >
                <CheckIcon />
                开始实施
              </Button>
            </div>
          )}
        </PlanFooter>
      ) : entry.status === "approved" ? (
        <PlanFooter className="gap-2 text-muted-foreground text-xs">
          <CheckIcon className="size-3.5 text-emerald-600" />
          已批准
        </PlanFooter>
      ) : entry.status === "changes-requested" ? (
        <PlanFooter className="gap-2 text-muted-foreground text-xs">
          <RotateCcwIcon className="size-3.5" />
          等待 Melody 更新计划
        </PlanFooter>
      ) : null}
    </Plan>
  );
}
