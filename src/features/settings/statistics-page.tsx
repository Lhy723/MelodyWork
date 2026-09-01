import {
  BrainCircuitIcon,
  Clock3Icon,
  PuzzleIcon,
  RefreshCwIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { UsageStatistics } from "@/domain/statistics";
import { useAsyncOperation } from "@/hooks/use-async-operation";
import { getUsageStatistics, listMelodySkills } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import { ActivityHeatmap } from "./statistics-heatmap";
import { InsightRow } from "./statistics-insight-row";
import { TokenBreakdownChart } from "./statistics-token-chart";
import {
  compactNumber,
  emptyStatistics,
  effortLabel,
  formatApiDuration,
  formatCost,
  formatDuration,
  type ActivityView,
} from "./statistics-utils";

export function StatisticsPage({ cwd }: { cwd: string }) {
  const [statistics, setStatistics] =
    useState<UsageStatistics>(emptyStatistics);
  const [skillCount, setSkillCount] = useState(0);
  const [view, setView] = useState<ActivityView>("day");
  const { state: loadState, run: runLoad } = useAsyncOperation();
  const loading = loadState.phase === "pending";
  const error = loadState.error;

  const load = useCallback(() => {
    void runLoad(
      () => Promise.all([getUsageStatistics(), listMelodySkills(cwd)]),
      ([nextStatistics, extensions]) => {
        setStatistics(nextStatistics);
        setSkillCount(
          extensions.filter((extension) => extension.enabled).length,
        );
      },
    ).catch(() => undefined);
  }, [cwd, runLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  const topMetrics = [
    {
      label: "累计 Token 数",
      value: compactNumber(statistics.totalTokens),
    },
    {
      label: "峰值 Token 数",
      value: compactNumber(statistics.peakTokens),
    },
    {
      label: "最长任务时长",
      value: formatDuration(statistics.longestTaskMs),
    },
    {
      label: "当前连续天数",
      value: `${statistics.currentStreakDays} 天`,
    },
    {
      label: "最长连续天数",
      value: `${statistics.longestStreakDays} 天`,
    },
  ];
  const mostUsedEffort = statistics.reasoningEfforts[0];
  const totalEffortCount = statistics.reasoningEfforts.reduce(
    (sum, item) => sum + item.count,
    0,
  );

  return (
    <section className="motion-view-enter min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-3xl">统计</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              了解你的任务活跃度、Token 使用和 Melody 扩展使用情况。
            </p>
          </div>
          <Button
            aria-label="刷新统计"
            disabled={loading}
            onClick={() => void load()}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
        </div>

        {error ? (
          <p
            aria-live="assertive"
            className="mt-5 rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-sm"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 grid overflow-hidden rounded-2xl border bg-card sm:grid-cols-5">
          {topMetrics.map((metric) => (
            <div
              className="flex min-h-20 flex-col items-center justify-center border-b px-3 text-center last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
              key={metric.label}
            >
              <p className="font-medium text-base tabular-nums">
                {metric.value}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {metric.label}
              </p>
            </div>
          ))}
        </div>

        <section className="mt-9">
          <div className="flex items-center gap-3">
            <h4 className="font-semibold text-base">Token 活动</h4>
            <div className="ml-auto flex rounded-lg bg-muted/60 p-0.5">
              {(
                [
                  ["day", "每日"],
                  ["week", "每周"],
                  ["cumulative", "累计"],
                ] as const
              ).map(([value, label]) => (
                <button
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs transition-colors",
                    view === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  key={value}
                  onClick={() => setView(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <ActivityHeatmap activity={statistics.activity} view={view} />
        </section>

        <section className="mt-8">
          <div>
            <h4 className="font-semibold text-base">Token 构成</h4>
            <p className="mt-1 text-muted-foreground text-xs">
              最近 30 天的真实模型用量；推理 Token 属于输出 Token 的一部分。
            </p>
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl border bg-card">
            <div className="grid border-b sm:grid-cols-5">
              {[
                ["输入（含缓存）", compactNumber(statistics.inputTokens)],
                ["输出", compactNumber(statistics.outputTokens)],
                ["缓存读取", compactNumber(statistics.cachedReadTokens)],
                ["推理", compactNumber(statistics.reasoningTokens)],
                ["缓存写入", "供应商未提供"],
              ].map(([label, value]) => (
                <div
                  className="border-b px-4 py-3 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
                  key={label}
                >
                  <p className="font-medium text-sm tabular-nums">{value}</p>
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {label}
                  </p>
                </div>
              ))}
            </div>
            <div className="px-4 pt-3 pb-2">
              {statistics.totalTokens > 0 ? (
                <TokenBreakdownChart activity={statistics.activity} />
              ) : (
                <div className="flex h-40 items-center justify-center text-muted-foreground text-xs">
                  完成一次带有用量数据的任务后，这里会显示趋势。
                </div>
              )}
            </div>
          </div>
          {statistics.usageIncompleteTasks > 0 ? (
            <p className="mt-2 text-amber-700 text-xs dark:text-amber-300">
              {statistics.usageIncompleteTasks}{" "}
              个任务的用量不完整，累计值可能偏低。
            </p>
          ) : null}
        </section>

        <div className="mt-6 grid gap-10 md:grid-cols-2">
          <section>
            <h4 className="font-semibold text-base">活动洞察</h4>
            <dl className="mt-4 space-y-3.5 text-sm">
              <InsightRow
                icon={ZapIcon}
                label="快速模式"
                value={
                  statistics.quickModeTasks > 0
                    ? `${statistics.quickModeTasks} 个任务`
                    : "未使用"
                }
              />
              <InsightRow
                icon={BrainCircuitIcon}
                label="最常用的推理强度"
                value={
                  mostUsedEffort
                    ? `${effortLabel(mostUsedEffort.name)} · ${Math.round(
                        (mostUsedEffort.count / Math.max(1, totalEffortCount)) *
                          100,
                      )}%`
                    : "暂无数据"
                }
              />
              <InsightRow
                icon={SparklesIcon}
                label="已探索的技能"
                value={compactNumber(statistics.usedSkills)}
              />
              <InsightRow
                icon={SparklesIcon}
                label="可用技能总数"
                value={compactNumber(skillCount)}
              />
              <InsightRow
                icon={Clock3Icon}
                label="任务总数"
                value={compactNumber(statistics.totalTasks)}
              />
              <InsightRow
                icon={ZapIcon}
                label="模型调用次数"
                value={compactNumber(statistics.modelCalls)}
              />
              <InsightRow
                icon={Clock3Icon}
                label="模型 API 用时"
                value={formatApiDuration(statistics.apiDurationMs)}
              />
              {statistics.costUsdTicks !== undefined ? (
                <InsightRow
                  icon={ZapIcon}
                  label="模型费用"
                  value={formatCost(statistics.costUsdTicks)}
                />
              ) : null}
            </dl>
          </section>

          <section>
            <h4 className="font-semibold text-base">最常用的插件与工具</h4>
            {statistics.plugins.length > 0 ? (
              <ol className="mt-4 space-y-3">
                {statistics.plugins.map((plugin) => (
                  <li
                    className="flex min-w-0 items-center gap-3 text-sm"
                    key={plugin.name}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card">
                      <PuzzleIcon className="size-3.5 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {plugin.name}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {plugin.count} 次运行
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="mt-4 rounded-xl border border-dashed px-4 py-8 text-center">
                <PuzzleIcon className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-muted-foreground text-xs">
                  完成包含工具或插件调用的任务后，这里会显示排行。
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
