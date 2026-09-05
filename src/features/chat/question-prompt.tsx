import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgentQuestion, AgentQuestionResponse } from "@/domain/acp";
import type { ToolTimelineEntry } from "@/domain/timeline-groups";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SkipForwardIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface QuestionPromptProps {
  entry: ToolTimelineEntry;
  onResolve: (
    entryId: string,
    response: AgentQuestionResponse,
  ) => void | Promise<void>;
}

type AnswerMap = Record<string, string[]>;
type NoteMap = Record<string, string>;

const otherOption = (label: string) => {
  const normalized = label.trim().toLocaleLowerCase();
  return (
    normalized === "other" ||
    normalized === "其他" ||
    normalized.startsWith("other ") ||
    normalized.startsWith("其他")
  );
};

const requestKey = (entry: ToolTimelineEntry) => {
  const request = entry.question;
  return request
    ? `${request.sessionId}:${String(request.requestId)}`
    : entry.id;
};

const initialNotes = (
  annotations: Record<string, { notes?: string }> | undefined,
): NoteMap =>
  Object.fromEntries(
    Object.entries(annotations ?? {}).flatMap(([question, annotation]) =>
      annotation.notes?.trim() ? [[question, annotation.notes]] : [],
    ),
  );

const answerText = (question: string, answers: AnswerMap, notes: NoteMap) => {
  const note = notes[question]?.trim();
  if (note) {
    return note;
  }
  return answers[question]?.join("、") ?? "";
};

const normalizedAnswers = (answers: AnswerMap) =>
  Object.fromEntries(
    Object.entries(answers).flatMap(([question, values]) => {
      const normalized = values.map((value) => value.trim()).filter(Boolean);
      return normalized.length ? [[question, normalized]] : [];
    }),
  );

const normalizedAnnotations = (
  questions: AgentQuestion[],
  answers: AnswerMap,
  notes: NoteMap,
) => {
  const annotations = Object.fromEntries(
    questions.flatMap((question) => {
      const selected = answers[question.question] ?? [];
      const note = notes[question.question]?.trim();
      const preview =
        !question.multiSelect && selected.length === 1
          ? question.options.find((option) => option.label === selected[0])
              ?.preview
          : undefined;
      if (!preview && !note) {
        return [];
      }
      return [
        [
          question.question,
          {
            ...(preview ? { preview } : {}),
            ...(note ? { notes: note } : {}),
          },
        ],
      ];
    }),
  );
  return Object.keys(annotations).length ? annotations : undefined;
};

const partialAnswers = (questions: AgentQuestion[], answers: AnswerMap) =>
  Object.fromEntries(
    questions.flatMap((question) => {
      const value = answers[question.question]?.[0]?.trim() ?? "";
      return value ? [[question.question, value]] : [];
    }),
  );

const QuestionOption = ({
  label,
  description,
  disabled,
  selected,
  onClick,
}: {
  label: string;
  description: string;
  disabled: boolean;
  selected: boolean;
  onClick: () => void;
}) => (
  <button
    aria-pressed={selected}
    className={cn(
      "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
      "hover:border-primary/50 hover:bg-muted/60",
      selected
        ? "border-primary bg-primary/8 text-foreground ring-1 ring-primary/25"
        : "border-border/80 bg-background",
      disabled &&
        "cursor-default opacity-70 hover:border-border/80 hover:bg-background",
    )}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-primary",
        selected && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {selected ? <CheckIcon className="size-3" /> : null}
    </span>
    <span className="min-w-0">
      <span className="block font-medium">{label}</span>
      {description ? (
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      ) : null}
    </span>
  </button>
);

export function QuestionPrompt({ entry, onResolve }: QuestionPromptProps) {
  const request = entry.question;
  const key = requestKey(entry);
  const [answers, setAnswers] = useState<AnswerMap>(
    () => request?.answers ?? {},
  );
  const [notes, setNotes] = useState<NoteMap>(() =>
    initialNotes(request?.annotations),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setAnswers(request?.answers ?? {});
    setNotes(initialNotes(request?.annotations));
    setSubmitting(false);
    setError(undefined);
  }, [key, request?.answers, request?.annotations, request?.outcome]);

  const pending = request?.outcome === "pending";
  const isPlan = request?.mode === "plan";
  const selectedCount = useMemo(
    () =>
      Object.values(answers).reduce(
        (count, values) => count + values.length,
        0,
      ),
    [answers],
  );

  if (!request) {
    return null;
  }

  const updateAnswer = (question: AgentQuestion, label: string) => {
    if (!pending) {
      return;
    }
    const currentSelection = answers[question.question] ?? [];
    const nextSelection = question.multiSelect
      ? currentSelection.includes(label)
        ? currentSelection.filter((value) => value !== label)
        : [...currentSelection, label]
      : [label];
    setAnswers((current) => {
      return { ...current, [question.question]: nextSelection };
    });
    if (!nextSelection.some(otherOption)) {
      setNotes((current) => {
        if (!(question.question in current)) {
          return current;
        }
        const next = { ...current };
        delete next[question.question];
        return next;
      });
    }
  };

  const submit = async (response: AgentQuestionResponse) => {
    setSubmitting(true);
    setError(undefined);
    try {
      await onResolve(entry.id, response);
    } catch {
      setSubmitting(false);
      setError("回答发送失败，请稍后重试。");
    }
  };

  const accept = () => {
    const nextAnswers = normalizedAnswers(answers);
    const annotations = normalizedAnnotations(
      request.questions,
      answers,
      notes,
    );
    void submit({
      outcome: "accepted",
      answers: nextAnswers,
      ...(annotations ? { annotations } : {}),
    });
  };

  const discuss = () =>
    void submit({
      outcome: "chat_about_this",
      partialAnswers: partialAnswers(request.questions, answers),
    });

  const skip = () =>
    void submit({
      outcome: "skip_interview",
      partialAnswers: partialAnswers(request.questions, answers),
    });

  return (
    <Card
      aria-live={pending ? "polite" : undefined}
      className="motion-view-enter border-primary/25 bg-card/95 shadow-sm"
      data-question-outcome={request.outcome}
    >
      <CardHeader className="gap-2 border-b border-border/70 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CircleHelpIcon aria-hidden="true" className="size-4 text-primary" />
          {pending ? "需要你的回答" : "问题回答"}
        </CardTitle>
        <CardDescription>
          {isPlan
            ? "回答这些问题可以帮助 Melody 更准确地制定计划。"
            : "Melody 需要确认一些信息后才能继续。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        {request.questions.map((question, index) => {
          const selected = answers[question.question] ?? [];
          const selectedOther = selected.some(otherOption);
          const freeformOnly = question.options.length === 0;
          return (
            <fieldset
              className="space-y-2.5"
              key={question.id ?? question.question}
            >
              <legend className="text-sm font-medium leading-6">
                <span className="mr-1.5 text-muted-foreground">
                  {index + 1}.
                </span>
                {question.question}
                {question.multiSelect ? (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    可多选
                  </span>
                ) : null}
              </legend>
              {question.options.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {question.options.map((option) => (
                    <QuestionOption
                      description={option.description}
                      disabled={!pending || submitting}
                      key={option.id ?? option.label}
                      label={option.label}
                      onClick={() => updateAnswer(question, option.label)}
                      selected={selected.includes(option.label)}
                    />
                  ))}
                </div>
              ) : null}
              {freeformOnly || selectedOther ? (
                <div className="space-y-1.5">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${entry.id}-${index}-notes`}
                  >
                    {freeformOnly ? "你的回答" : "补充说明"}
                  </label>
                  {freeformOnly ? (
                    <Textarea
                      aria-label={`${question.question} 的回答`}
                      className="min-h-20"
                      disabled={!pending || submitting}
                      id={`${entry.id}-${index}-notes`}
                      onChange={(event) => {
                        const value = event.target.value;
                        setNotes((current) => ({
                          ...current,
                          [question.question]: value,
                        }));
                        setAnswers((current) => ({
                          ...current,
                          [question.question]: value.trim() ? ["Other"] : [],
                        }));
                      }}
                      placeholder="输入你的回答…"
                      value={notes[question.question] ?? ""}
                    />
                  ) : (
                    <Input
                      aria-label={`${question.question} 的补充说明`}
                      disabled={!pending || submitting}
                      id={`${entry.id}-${index}-notes`}
                      onChange={(event) =>
                        setNotes((current) => ({
                          ...current,
                          [question.question]: event.target.value,
                        }))
                      }
                      placeholder="可以补充说明…"
                      value={notes[question.question] ?? ""}
                    />
                  )}
                </div>
              ) : null}
              {!pending && (selected.length > 0 || notes[question.question]) ? (
                <p className="text-xs text-muted-foreground">
                  已选：{answerText(question.question, answers, notes)}
                </p>
              ) : null}
            </fieldset>
          );
        })}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </CardContent>
      {pending ? (
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {isPlan ? (
            <>
              <Button
                disabled={submitting}
                onClick={discuss}
                size="sm"
                type="button"
                variant="ghost"
              >
                {submitting ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <MessageCircleIcon />
                )}
                继续讨论
              </Button>
              <Button
                disabled={submitting}
                onClick={skip}
                size="sm"
                type="button"
                variant="ghost"
              >
                <SkipForwardIcon />
                跳过
              </Button>
            </>
          ) : null}
          <Button
            disabled={submitting}
            onClick={() => void submit({ outcome: "cancelled" })}
            size="sm"
            type="button"
            variant="ghost"
          >
            <XIcon />
            取消
          </Button>
          <Button
            disabled={submitting}
            onClick={accept}
            size="sm"
            type="button"
          >
            {submitting ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <CheckIcon />
            )}
            {selectedCount > 0 ? "提交回答" : "继续"}
          </Button>
        </CardFooter>
      ) : (
        <CardFooter className="justify-end py-2.5 text-xs text-muted-foreground">
          {request.outcome === "cancelled"
            ? "已取消回答"
            : request.outcome === "chat_about_this"
              ? "已请求继续讨论"
              : request.outcome === "skip_interview"
                ? "已跳过提问"
                : "回答已提交"}
        </CardFooter>
      )}
    </Card>
  );
}
