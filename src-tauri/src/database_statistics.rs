use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use tauri::State;

use super::database_core::{AppDatabase, current_timestamp};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsActivityDay {
    day_start_ms: i64,
    tokens: u64,
    tasks: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_read_tokens: u64,
    reasoning_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatisticsCount {
    name: String,
    count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatistics {
    total_tokens: u64,
    peak_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_read_tokens: u64,
    reasoning_tokens: u64,
    model_calls: u64,
    api_duration_ms: u64,
    usage_incomplete_tasks: u64,
    cost_usd_ticks: Option<u64>,
    longest_task_ms: u64,
    current_streak_days: u64,
    longest_streak_days: u64,
    total_tasks: u64,
    quick_mode_tasks: u64,
    activity: Vec<StatisticsActivityDay>,
    reasoning_efforts: Vec<StatisticsCount>,
    plugins: Vec<StatisticsCount>,
    used_skills: u64,
}

fn number_field(value: &serde_json::Value, name: &str) -> Option<u64> {
    value.get(name)?.as_u64()
}

fn timestamp_field(value: &serde_json::Value, name: &str) -> Option<i64> {
    value.get(name)?.as_i64()
}

fn count_rows(values: HashMap<String, u64>, limit: usize) -> Vec<StatisticsCount> {
    let mut rows = values
        .into_iter()
        .map(|(name, count)| StatisticsCount { name, count })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    rows.truncate(limit);
    rows
}

fn day_start_ms(timestamp_ms: i64) -> i64 {
    timestamp_ms.div_euclid(86_400_000) * 86_400_000
}

pub(crate) fn normalized_tool_name(entry: &serde_json::Value) -> String {
    let title = entry
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("工具调用")
        .trim();
    let lower = title.to_ascii_lowercase();
    let operation = entry
        .pointer("/activity/operation")
        .and_then(serde_json::Value::as_str);

    if lower.starts_with("list ")
        || lower.starts_with("listing ")
        || lower.starts_with("listed ")
        || lower.starts_with("listdir")
        || title.starts_with("列出")
        || title.starts_with("已列出")
        || title.contains("目录列表")
    {
        return "List".to_string();
    }
    if lower.starts_with("read ")
        || lower.starts_with("reading ")
        || lower.starts_with("read file")
        || title.starts_with("读取")
        || title.starts_with("已读取")
    {
        return "Read".to_string();
    }
    if lower.starts_with("search ")
        || lower.starts_with("searching ")
        || lower.starts_with("searched ")
        || lower.starts_with("grep ")
        || lower.starts_with("find ")
        || title.starts_with("搜索")
        || title.starts_with("已搜索")
        || (title.starts_with("已在") && title.contains("搜索"))
    {
        return "Search".to_string();
    }
    if lower.starts_with("create ")
        || lower.starts_with("created ")
        || lower.starts_with("creating ")
        || title.starts_with("创建")
        || title.starts_with("已创建")
    {
        return "Create".to_string();
    }
    if lower.starts_with("edit ")
        || lower.starts_with("edited ")
        || lower.starts_with("editing ")
        || lower.starts_with("patch ")
        || title.starts_with("编辑")
        || title.starts_with("已编辑")
    {
        return "Edit".to_string();
    }
    if lower.starts_with("delete ")
        || lower.starts_with("deleted ")
        || lower.starts_with("remove ")
        || title.starts_with("删除")
        || title.starts_with("已删除")
    {
        return "Delete".to_string();
    }
    if lower.starts_with("execute ")
        || lower.starts_with("executing ")
        || lower.starts_with("run ")
        || lower.starts_with("running ")
        || title.starts_with("执行")
        || title.starts_with("运行")
    {
        return "Execute".to_string();
    }

    match operation {
        Some("read") => return "Read".to_string(),
        Some("search") => return "Search".to_string(),
        Some("create") => return "Create".to_string(),
        Some("edit") => return "Edit".to_string(),
        Some("delete") => return "Delete".to_string(),
        Some("execute") => return "Execute".to_string(),
        _ => {}
    }

    let stable = title
        .split(['{', '(', '`'])
        .next()
        .unwrap_or(title)
        .trim()
        .trim_end_matches([':', '：', '-', '—'])
        .trim();
    if stable.is_empty() {
        "工具调用".to_string()
    } else if stable.chars().count() > 48 {
        stable
            .split_whitespace()
            .next()
            .unwrap_or("工具调用")
            .to_string()
    } else {
        stable.to_string()
    }
}

#[tauri::command]
pub fn get_usage_statistics(database: State<'_, AppDatabase>) -> Result<UsageStatistics, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let mut statement = connection
        .prepare("SELECT timeline_json FROM sessions")
        .map_err(|error| error.to_string())?;
    let timelines = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut total_tokens = 0_u64;
    let mut peak_tokens = 0_u64;
    let mut input_tokens = 0_u64;
    let mut output_tokens = 0_u64;
    let mut cached_read_tokens = 0_u64;
    let mut reasoning_tokens = 0_u64;
    let mut model_calls = 0_u64;
    let mut api_duration_ms = 0_u64;
    let mut usage_incomplete_tasks = 0_u64;
    let mut cost_usd_ticks = None::<u64>;
    let mut longest_task_ms = 0_u64;
    let mut total_tasks = 0_u64;
    let mut quick_mode_tasks = 0_u64;
    let mut activity = BTreeMap::<i64, (u64, u64, u64, u64, u64, u64)>::new();
    let mut reasoning = HashMap::<String, u64>::new();
    let mut plugins = HashMap::<String, u64>::new();
    let mut skills = HashSet::<String>::new();

    for timeline_json in timelines {
        let entries =
            serde_json::from_str::<Vec<serde_json::Value>>(&timeline_json).unwrap_or_default();
        let mut turn_started_at = None::<i64>;
        let mut turn_last_activity_at = None::<i64>;

        for entry in &entries {
            let kind = entry.get("kind").and_then(serde_json::Value::as_str);
            let role = entry.get("role").and_then(serde_json::Value::as_str);
            let started_at = timestamp_field(entry, "startedAt");
            let completed_at = timestamp_field(entry, "completedAt").or(started_at);

            if kind == Some("message") && role == Some("user") {
                if let (Some(start), Some(end)) = (turn_started_at, turn_last_activity_at) {
                    longest_task_ms = longest_task_ms.max(end.saturating_sub(start) as u64);
                }
                turn_started_at = started_at;
                turn_last_activity_at = completed_at;
                total_tasks += 1;
                if let Some(day) = started_at.map(day_start_ms) {
                    activity.entry(day).or_default().1 += 1;
                }
                continue;
            }

            if turn_started_at.is_some() {
                turn_last_activity_at = completed_at.or(turn_last_activity_at);
            }

            if kind == Some("message") && role == Some("assistant") {
                if let Some(usage) = entry.get("tokenUsage") {
                    if let Some(used) = number_field(usage, "usedTokens") {
                        peak_tokens = peak_tokens.max(used);
                    }
                }
                if let Some(usage) = entry.get("billingUsage") {
                    let turn_input = number_field(usage, "inputTokens").unwrap_or(0);
                    let turn_output = number_field(usage, "outputTokens").unwrap_or(0);
                    let turn_cached = number_field(usage, "cachedReadTokens")
                        .unwrap_or(0)
                        .min(turn_input);
                    let turn_reasoning = number_field(usage, "reasoningTokens")
                        .unwrap_or(0)
                        .min(turn_output);
                    let turn_total = turn_input.saturating_add(turn_output);
                    total_tokens = total_tokens.saturating_add(turn_total);
                    input_tokens = input_tokens.saturating_add(turn_input);
                    output_tokens = output_tokens.saturating_add(turn_output);
                    cached_read_tokens = cached_read_tokens.saturating_add(turn_cached);
                    reasoning_tokens = reasoning_tokens.saturating_add(turn_reasoning);
                    model_calls =
                        model_calls.saturating_add(number_field(usage, "modelCalls").unwrap_or(0));
                    api_duration_ms = api_duration_ms
                        .saturating_add(number_field(usage, "apiDurationMs").unwrap_or(0));
                    if usage
                        .get("usageIsIncomplete")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                    {
                        usage_incomplete_tasks += 1;
                    }
                    if let Some(turn_cost) = number_field(usage, "costUsdTicks") {
                        cost_usd_ticks =
                            Some(cost_usd_ticks.unwrap_or(0).saturating_add(turn_cost));
                    }
                    if let Some(day) = completed_at.map(day_start_ms) {
                        let row = activity.entry(day).or_default();
                        row.0 = row.0.saturating_add(turn_total);
                        row.2 = row.2.saturating_add(turn_input);
                        row.3 = row.3.saturating_add(turn_output);
                        row.4 = row.4.saturating_add(turn_cached);
                        row.5 = row.5.saturating_add(turn_reasoning);
                    }
                }
                if let Some(effort) = entry
                    .get("reasoningEffort")
                    .and_then(serde_json::Value::as_str)
                {
                    *reasoning.entry(effort.to_string()).or_default() += 1;
                }
                if entry
                    .get("sessionModeId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|mode| {
                        let mode = mode.to_ascii_lowercase();
                        mode.contains("quick") || mode.contains("fast")
                    })
                {
                    quick_mode_tasks += 1;
                }
            }

            if kind == Some("tool") {
                let original_title = entry
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("工具调用")
                    .trim();
                let name = normalized_tool_name(entry);
                if !name.is_empty() {
                    *plugins.entry(name).or_default() += 1;
                    let lower = original_title.to_ascii_lowercase();
                    if lower.contains("skill") || original_title.contains("技能") {
                        skills.insert(original_title.to_string());
                    }
                }
            }
        }

        if let (Some(start), Some(end)) = (turn_started_at, turn_last_activity_at) {
            longest_task_ms = longest_task_ms.max(end.saturating_sub(start) as u64);
        }
    }

    let active_days = activity
        .iter()
        .filter_map(|(day, (_, tasks, _, _, _, _))| (*tasks > 0).then_some(*day / 86_400_000))
        .collect::<Vec<_>>();
    let mut longest_streak_days = 0_u64;
    let mut streak = 0_u64;
    let mut previous_day = None::<i64>;
    for day in &active_days {
        streak = if previous_day.is_some_and(|previous| *day == previous + 1) {
            streak + 1
        } else {
            1
        };
        longest_streak_days = longest_streak_days.max(streak);
        previous_day = Some(*day);
    }
    let today = current_timestamp(&connection)? / 86_400;
    let current_streak_days = active_days
        .last()
        .filter(|last| **last == today || **last == today - 1)
        .map(|_| streak)
        .unwrap_or(0);

    Ok(UsageStatistics {
        total_tokens,
        peak_tokens,
        input_tokens,
        output_tokens,
        cached_read_tokens,
        reasoning_tokens,
        model_calls,
        api_duration_ms,
        usage_incomplete_tasks,
        cost_usd_ticks,
        longest_task_ms,
        current_streak_days,
        longest_streak_days,
        total_tasks,
        quick_mode_tasks,
        activity: activity
            .into_iter()
            .map(
                |(
                    day_start_ms,
                    (
                        tokens,
                        tasks,
                        input_tokens,
                        output_tokens,
                        cached_read_tokens,
                        reasoning_tokens,
                    ),
                )| StatisticsActivityDay {
                    day_start_ms,
                    tokens,
                    tasks,
                    input_tokens,
                    output_tokens,
                    cached_read_tokens,
                    reasoning_tokens,
                },
            )
            .collect(),
        reasoning_efforts: count_rows(reasoning, 8),
        plugins: count_rows(plugins, 5),
        used_skills: skills.len() as u64,
    })
}
