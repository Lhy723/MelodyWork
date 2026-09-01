import type {
  StatisticsActivityDay,
  UsageStatistics,
} from "@/domain/statistics";

export type ActivityView = "day" | "week" | "cumulative";

export const emptyStatistics: UsageStatistics = {
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

export const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const dateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const compactNumber = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);

export const formatDuration = (milliseconds: number) => {
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

export const formatApiDuration = (milliseconds: number) => {
  if (milliseconds < 60_000) {
    return `${Math.max(0, Math.round(milliseconds / 1_000))} 秒`;
  }
  return formatDuration(milliseconds);
};

export const formatCost = (ticks: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(ticks / 10_000_000_000);

export const effortLabel = (effort: string | undefined) => {
  const normalized = effort?.toLowerCase();
  if (!normalized) return "暂无数据";
  if (normalized.includes("ultra")) return "极高";
  if (normalized.includes("high")) return "高";
  if (normalized.includes("medium")) return "中";
  if (normalized.includes("low")) return "低";
  return effort ?? "暂无数据";
};

export const buildActivitySeries = (
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

export const ACTIVITY_CALENDAR_WEEK_COUNT = 53;
export const ACTIVITY_CALENDAR_DAY_COUNT = 7;
export const ACTIVITY_CALENDAR_HORIZONTAL_INSET = 20;
export const ACTIVITY_CALENDAR_VERTICAL_INSET = 34;

export const activityCalendarCellSize = (container: HTMLElement) => {
  const availableWidth = Math.max(
    1,
    container.clientWidth - ACTIVITY_CALENDAR_HORIZONTAL_INSET,
  );
  const availableHeight = Math.max(
    1,
    container.clientHeight - ACTIVITY_CALENDAR_VERTICAL_INSET,
  );
  return Math.max(
    1,
    Math.min(
      availableWidth / ACTIVITY_CALENDAR_WEEK_COUNT,
      availableHeight / ACTIVITY_CALENDAR_DAY_COUNT,
    ),
  );
};

export const buildTokenBreakdownDays = (activity: StatisticsActivityDay[]) => {
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
};
