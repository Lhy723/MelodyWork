import {
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { BarChart, HeatmapChart } from "echarts/charts";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  BrainCircuitIcon,
  Clock3Icon,
  FlameIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  StatisticsActivityDay,
  UsageStatistics,
} from "@/domain/statistics";
import {
  getUsageStatistics,
  listMelodySkills,
} from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

echarts.use([
  CalendarComponent,
  GridComponent,
  HeatmapChart,
  BarChart,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

type ActivityView = "day" | "week" | "cumulative";

const emptyStatistics: UsageStatistics = {
  totalTokens: 0,
  peakTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  reasoningTokens: 0,
  modelCalls: 0,
  apiDurationMs: 0,
  usageIncompleteTasks: 0,
  longestTaskMs: 0,
  currentStreakDays: 0,
  longestStreakDays: 0,
  totalTasks: 0,
  quickModeTasks: 0,
  activity: [],
  reasoningEfforts: [],
  plugins: [],
  usedSkills: 0,
};

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const dateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const compactNumber = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);

const formatDuration = (milliseconds: number) => {
  if (milliseconds <= 0) {
    return "0 分钟";
  }
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0
    ? `${hours} 小时${remaining > 0 ? ` ${remaining} 分` : ""}`
    : `${minutes} 分钟`;
};

const formatApiDuration = (milliseconds: number) => {
  if (milliseconds < 60_000) {
    return `${Math.max(0, Math.round(milliseconds / 1_000))} 秒`;
  }
  return formatDuration(milliseconds);
};

const formatCost = (ticks: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(ticks / 10_000_000_000);

const effortLabel = (effort: string | undefined) => {
  const normalized = effort?.toLowerCase();
  if (!normalized) return "暂无数据";
  if (normalized.includes("ultra")) return "极高";
  if (normalized.includes("high")) return "高";
  if (normalized.includes("medium")) return "中";
  if (normalized.includes("low")) return "低";
  return effort ?? "暂无数据";
};

const buildActivitySeries = (
  activity: StatisticsActivityDay[],
  view: ActivityView,
) => {
  const values = new Map(
    activity.map((item) => [
      dateKey(new Date(item.dayStartMs)),
      { tokens: item.tokens, tasks: item.tasks },
    ]),
  );
  const today = startOfDay(new Date());
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  const raw: Array<{
    date: string;
    tokens: number;
    tasks: number;
  }> = [];

  for (
    const cursor = new Date(start);
    cursor <= today;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const date = dateKey(cursor);
    const item = values.get(date) ?? { tokens: 0, tasks: 0 };
    raw.push({ date, ...item });
  }

  let cumulative = 0;
  return raw.map((item, index) => {
    cumulative += item.tokens;
    const weeklyTokens = raw
      .slice(Math.max(0, index - 6), index + 1)
      .reduce((sum, day) => sum + day.tokens, 0);
    const metric =
      view === "cumulative"
        ? cumulative
        : view === "week"
          ? weeklyTokens
          : item.tokens;
    return {
      value: [item.date, metric > 0 ? metric : item.tasks > 0 ? 1 : 0],
      tokens: item.tokens,
      tasks: item.tasks,
    };
  });
};

function ActivityHeatmap({
  activity,
  view,
}: {
  activity: StatisticsActivityDay[];
  view: ActivityView;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const series = useMemo(
    () => buildActivitySeries(activity, view),
    [activity, view],
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((current) => current + 1);
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    const isDark = document.documentElement.classList.contains("dark");
    const max = Math.max(1, ...series.map((item) => item.value[1] as number));
    chart.setOption({
      animationDuration: 240,
      calendar: {
        range: [
          series[0]?.value[0] ?? dateKey(new Date()),
          series.at(-1)?.value[0] ?? dateKey(new Date()),
        ],
        left: 10,
        right: 10,
        top: 4,
        bottom: 30,
        cellSize: ["auto", 15],
        splitLine: { show: false },
        itemStyle: {
          borderColor: isDark ? "#181818" : "#ffffff",
          borderWidth: 3,
          borderRadius: 3,
          color: isDark ? "#232425" : "#edf0f2",
        },
        yearLabel: { show: false },
        dayLabel: { show: false },
        monthLabel: {
          color: isDark ? "#8d8f92" : "#707276",
          fontSize: 11,
          margin: 8,
          nameMap: "ZH",
          position: "end",
        },
      },
      tooltip: {
        backgroundColor: isDark ? "#262728" : "#ffffff",
        borderColor: isDark ? "#3b3c3e" : "#dfe2e5",
        borderWidth: 1,
        textStyle: {
          color: isDark ? "#f5f5f5" : "#26272a",
          fontSize: 12,
        },
        formatter: (params: {
          data?: {
            value: [string, number];
            tokens: number;
            tasks: number;
          };
        }) => {
          const item = params.data;
          if (!item) return "";
          return `${item.value[0]}<br/>${compactNumber(item.tokens)} Token · ${item.tasks} 个任务`;
        },
      },
      visualMap: {
        show: false,
        min: 0,
        max,
        inRange: {
          color: isDark
            ? ["#232425", "#2e4054", "#4f7eae", "#78b7f4"]
            : ["#edf0f2", "#d8e9f8", "#82b9ea", "#339cff"],
        },
      },
      series: [
        {
          type: "heatmap",
          coordinateSystem: "calendar",
          data: series,
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [series, themeVersion]);

  return <div className="h-44 w-full" ref={containerRef} />;
}

function TokenBreakdownChart({
  activity,
}: {
  activity: StatisticsActivityDay[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const days = useMemo(() => {
    const byDate = new Map(
      activity.map((item) => [dateKey(new Date(item.dayStartMs)), item]),
    );
    const today = startOfDay(new Date());
    return Array.from({ length: 30 }, (_, index) => {
      const date = new Date(today);
      date.setDate(date.getDate() - (29 - index));
      const key = dateKey(date);
      return {
        key,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        ...(byDate.get(key) ?? {
          inputTokens: 0,
          outputTokens: 0,
          cachedReadTokens: 0,
          reasoningTokens: 0,
        }),
      };
    });
  }, [activity]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeVersion((current) => current + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    const isDark = document.documentElement.classList.contains("dark");
    const textColor = isDark ? "#a8aaad" : "#696c70";
    const splitColor = isDark ? "#2c2d2f" : "#edf0f2";
    const hasUsage = days.some(
      (day) => day.inputTokens > 0 || day.outputTokens > 0,
    );
    chart.setOption({
      animationDuration: 240,
      color: ["#8bb7df", "#4f8fca", "#9b8bd9", "#6953bd"],
      grid: {
        left: 4,
        right: 4,
        top: 38,
        bottom: 24,
        outerBoundsMode: "same",
        outerBoundsContain: "axisLabel",
      },
      legend: {
        top: 0,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: textColor, fontSize: 11 },
        data: ["非缓存输入", "缓存读取", "普通输出", "推理"],
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: isDark ? "#262728" : "#ffffff",
        borderColor: isDark ? "#3b3c3e" : "#dfe2e5",
        textStyle: { color: isDark ? "#f5f5f5" : "#26272a", fontSize: 12 },
        valueFormatter: (value: number) => `${compactNumber(value)} Token`,
      },
      xAxis: {
        type: "category",
        data: days.map((day) => day.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: textColor,
          fontSize: 10,
          interval: 4,
        },
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          show: hasUsage,
          color: textColor,
          fontSize: 10,
          formatter: (value: number) => compactNumber(value),
        },
        splitLine: {
          show: hasUsage,
          lineStyle: { color: splitColor },
        },
      },
      series: [
        {
          name: "非缓存输入",
          type: "bar",
          stack: "usage",
          barMaxWidth: 18,
          data: days.map((day) =>
            Math.max(0, day.inputTokens - day.cachedReadTokens),
          ),
        },
        {
          name: "缓存读取",
          type: "bar",
          stack: "usage",
          barMaxWidth: 18,
          data: days.map((day) => day.cachedReadTokens),
        },
        {
          name: "普通输出",
          type: "bar",
          stack: "usage",
          barMaxWidth: 18,
          data: days.map((day) =>
            Math.max(0, day.outputTokens - day.reasoningTokens),
          ),
        },
        {
          name: "推理",
          type: "bar",
          stack: "usage",
          barMaxWidth: 18,
          data: days.map((day) => day.reasoningTokens),
        },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [days, themeVersion]);

  return <div className="h-60 w-full" ref={containerRef} />;
}

export function StatisticsPage({ cwd }: { cwd: string }) {
  const [statistics, setStatistics] =
    useState<UsageStatistics>(emptyStatistics);
  const [skillCount, setSkillCount] = useState(0);
  const [view, setView] = useState<ActivityView>("day");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextStatistics, extensions] = await Promise.all([
        getUsageStatistics(),
        listMelodySkills(cwd),
      ]);
      setStatistics(nextStatistics);
      setSkillCount(
        extensions.filter((extension) => extension.enabled).length,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [cwd]);

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

  return (
    <section className="motion-view-enter min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-xl">统计</h3>
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
          <p className="mt-5 rounded-lg bg-destructive/5 px-3 py-2 text-destructive text-sm">
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
                  <p className="mt-0.5 text-muted-foreground text-xs">{label}</p>
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
              {statistics.usageIncompleteTasks} 个任务的用量不完整，累计值可能偏低。
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
                        (mostUsedEffort.count /
                          Math.max(
                            1,
                            statistics.reasoningEfforts.reduce(
                              (sum, item) => sum + item.count,
                              0,
                            ),
                          )) *
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

function InsightRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FlameIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <dt className="min-w-0 flex-1 text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
