import type {
  AgentScheduleRecord,
  AgentScheduleRunRecord,
} from "@melody/agent-contract";
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { UseAgentSchedulesResult } from "@/hooks/use-agent-schedules";

interface SchedulePanelProps {
  className?: string;
  schedules: UseAgentSchedulesResult;
}

/** Common interval presets; cron covers calendar-shaped schedules. */
const INTERVAL_PRESETS: Array<{ label: string; intervalMs: number }> = [
  { label: "每 5 分钟", intervalMs: 5 * 60 * 1_000 },
  { label: "每 30 分钟", intervalMs: 30 * 60 * 1_000 },
  { label: "每小时", intervalMs: 60 * 60 * 1_000 },
  { label: "每天", intervalMs: 24 * 60 * 60 * 1_000 },
];

const statusLabel: Record<AgentScheduleRecord["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  expired: "已过期",
  cancelled: "已取消",
};

const runStatusLabel: Record<AgentScheduleRunRecord["status"], string> = {
  fired: "已触发",
  skipped: "已跳过",
  failed: "失败",
};

const timeLabel = (value?: number) =>
  value === undefined
    ? "—"
    : new Date(value).toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

/**
 * Host-owned schedules for the active session.
 *
 * The Host owns the clock, the missed-trigger policy and the audit journal, so
 * this panel only submits intent (create/pause/resume/cancel) and renders the
 * rows the Host reports back, including why a trigger was skipped or failed.
 */
export function SchedulePanel({ className, schedules }: SchedulePanelProps) {
  const [prompt, setPrompt] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"interval" | "cron">(
    "interval",
  );
  const [intervalMs, setIntervalMs] = useState(INTERVAL_PRESETS[0].intervalMs);
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [missedPolicy, setMissedPolicy] = useState<"skip" | "run-once">("skip");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [journalFor, setJournalFor] = useState<string | undefined>(undefined);
  const [journal, setJournal] = useState<AgentScheduleRunRecord[]>([]);
  const [journalError, setJournalError] = useState<string | undefined>(
    undefined,
  );

  const trimmed = prompt.trim();
  const canCreate =
    trimmed.length > 0 &&
    !busy &&
    (scheduleKind !== "cron" || cron.trim().length > 0);

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setFormError(undefined);
    try {
      // Submit the conservative baseline (ask + default mode). The dispatcher
      // narrows it against the session's current binding at fire time, so a
      // schedule can only run with equal or smaller authority than the session
      // had when it was created.
      await schedules.create({
        ...(scheduleKind === "cron"
          ? { kind: "cron" as const, cron: cron.trim() }
          : { kind: "interval" as const, intervalMs }),
        prompt: trimmed,
        missedPolicy,
        permissionMode: "ask",
        sessionModeId: "default",
      });
      setPrompt("");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openJournal = async (scheduleId: string) => {
    if (journalFor === scheduleId) {
      setJournalFor(undefined);
      return;
    }
    setJournalFor(scheduleId);
    setJournalError(undefined);
    try {
      setJournal(await schedules.loadRuns(scheduleId));
    } catch (cause) {
      setJournal([]);
      setJournalError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={cn("w-full min-w-0 space-y-2 text-xs", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">定时任务</span>
        {schedules.loading ? (
          <span className="text-muted-foreground">读取中…</span>
        ) : null}
        {schedules.error ? (
          <span className="text-destructive">{schedules.error}</span>
        ) : null}
      </div>

      {schedules.schedules.length === 0 ? (
        <p className="text-muted-foreground">
          当前会话没有定时任务。创建后由 Host 持久化，应用重启也会继续计时。
        </p>
      ) : (
        <ul className="space-y-1">
          {schedules.schedules.map((schedule) => (
            <li className="min-w-0 space-y-1" key={schedule.scheduleId}>
              <div className="flex min-w-0 items-start justify-between gap-2">
                <span
                  className="min-w-0 flex-1 truncate"
                  title={schedule.prompt}
                >
                  {schedule.prompt}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {statusLabel[schedule.status]}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span>下次 {timeLabel(schedule.nextRunAt)}</span>
                <span>
                  {schedule.kind === "cron"
                    ? `Cron ${schedule.cron ?? "（缺少表达式）"}`
                    : schedule.kind === "interval"
                      ? `间隔 ${Math.round((schedule.intervalMs ?? 0) / 60_000)} 分钟`
                      : "单次"}
                </span>
                <span>已触发 {schedule.runCount} 次</span>
                <span>
                  {schedule.missedPolicy === "skip"
                    ? "错过即跳过"
                    : "错过补一次"}
                </span>
                <button
                  className="underline-offset-2 hover:underline"
                  onClick={() => void openJournal(schedule.scheduleId)}
                  type="button"
                >
                  {journalFor === schedule.scheduleId ? "收起记录" : "运行记录"}
                </button>
                {schedule.status === "active" ? (
                  <button
                    className="underline-offset-2 hover:underline"
                    onClick={() =>
                      void schedules.setStatus(schedule.scheduleId, "paused")
                    }
                    type="button"
                  >
                    暂停
                  </button>
                ) : null}
                {schedule.status === "paused" ? (
                  <button
                    className="underline-offset-2 hover:underline"
                    onClick={() =>
                      void schedules.setStatus(schedule.scheduleId, "active")
                    }
                    type="button"
                  >
                    恢复
                  </button>
                ) : null}
                {schedule.status === "active" ||
                schedule.status === "paused" ? (
                  <button
                    className="underline-offset-2 hover:underline"
                    onClick={() =>
                      void schedules.setStatus(schedule.scheduleId, "cancelled")
                    }
                    type="button"
                  >
                    取消
                  </button>
                ) : (
                  <button
                    className="underline-offset-2 hover:underline"
                    onClick={() => void schedules.remove(schedule.scheduleId)}
                    type="button"
                  >
                    删除
                  </button>
                )}
              </div>
              {journalFor === schedule.scheduleId ? (
                <div className="space-y-1 pl-2">
                  {journalError ? (
                    <span className="text-destructive">{journalError}</span>
                  ) : journal.length === 0 ? (
                    <span className="text-muted-foreground">暂无运行记录</span>
                  ) : (
                    journal.map((run) => (
                      <div
                        className="flex min-w-0 gap-2"
                        key={`${run.scheduleId}:${run.runOrdinal}`}
                      >
                        <span className="shrink-0 text-muted-foreground">
                          #{run.runOrdinal + 1}
                        </span>
                        <span className="shrink-0">
                          {runStatusLabel[run.status]}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {timeLabel(run.firedAt)}
                        </span>
                        {run.error ? (
                          <span className="min-w-0 truncate text-muted-foreground">
                            {run.error}
                          </span>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1 border-t border-border/40 pt-2">
        <Textarea
          aria-label="定时任务提示词"
          className="min-h-16 text-xs"
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="按计划重复发送的提示词"
          rows={2}
          value={prompt}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            onValueChange={(value) =>
              setScheduleKind(value === "cron" ? "cron" : "interval")
            }
            value={scheduleKind}
          >
            <SelectTrigger aria-label="计划类型" className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="interval">固定间隔</SelectItem>
              <SelectItem value="cron">日历规则（Cron）</SelectItem>
            </SelectContent>
          </Select>
          {scheduleKind === "interval" ? (
            <Select
              onValueChange={(value) => setIntervalMs(Number(value))}
              value={String(intervalMs)}
            >
              <SelectTrigger aria-label="触发间隔" className="h-7 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVAL_PRESETS.map((preset) => (
                  <SelectItem
                    key={preset.intervalMs}
                    value={String(preset.intervalMs)}
                  >
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <input
              aria-label="Cron 表达式"
              className="h-7 w-40 rounded-md border border-input bg-background px-2 font-mono text-xs"
              onChange={(event) => setCron(event.target.value)}
              placeholder="分 时 日 月 周"
              value={cron}
            />
          )}
          <Select
            onValueChange={(value) =>
              setMissedPolicy(value === "run-once" ? "run-once" : "skip")
            }
            value={missedPolicy}
          >
            <SelectTrigger aria-label="错过策略" className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">错过即跳过</SelectItem>
              <SelectItem value="run-once">错过补一次</SelectItem>
            </SelectContent>
          </Select>
          <button
            className="underline-offset-2 hover:underline disabled:opacity-50"
            disabled={!canCreate}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? "创建中…" : "创建定时任务"}
          </button>
        </div>
        {scheduleKind === "cron" ? (
          <p className="text-muted-foreground">
            使用本机时区的 5 段规则：分 时 日 月 周；例如 `0 9 * * 1-5`
            表示工作日 9:00。支持列表、范围与步长。
          </p>
        ) : null}
        {formError ? <p className="text-destructive">{formError}</p> : null}
      </div>
    </div>
  );
}
