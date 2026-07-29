export interface StatisticsActivityDay {
  dayStartMs: number;
  tokens: number;
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
}

export interface StatisticsCount {
  name: string;
  count: number;
}

export interface UsageStatistics {
  totalTokens: number;
  peakTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  apiDurationMs: number;
  usageIncompleteTasks: number;
  costUsdTicks?: number;
  longestTaskMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  totalTasks: number;
  quickModeTasks: number;
  activity: StatisticsActivityDay[];
  reasoningEfforts: StatisticsCount[];
  plugins: StatisticsCount[];
  usedSkills: number;
}
