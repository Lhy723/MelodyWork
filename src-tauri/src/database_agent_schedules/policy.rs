//! Pure schedule timing and input policy.
//!
//! This module deliberately has no SQLite or Host state dependencies. The
//! persistent schedule owner uses these rules when validating and advancing
//! rows, while the dispatcher uses the same missed-trigger decision.

/// A schedule must not be able to spin the Host: the floor is a rate limit, not
/// a user preference, and matches the handoff's requirement that scheduling has
/// a bounded trigger rate.
pub(crate) const MIN_SCHEDULE_INTERVAL_MS: i64 = 5_000;
pub(crate) const MAX_SCHEDULE_INTERVAL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
pub(crate) const MAX_SCHEDULE_RUNS: i64 = 1_000;

const MAX_SCHEDULE_ID_BYTES: usize = 256;
const SCHEDULE_KINDS: [&str; 3] = ["once", "interval", "cron"];
const MISSED_POLICIES: [&str; 2] = ["skip", "run-once"];
const SCHEDULE_STATUSES: [&str; 5] = ["active", "paused", "completed", "expired", "cancelled"];

/// The outcome of moving a schedule forward in time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScheduleAdvance {
    pub(crate) status: String,
    pub(crate) next_run_at: Option<i64>,
    pub(crate) run_count: i64,
    pub(crate) completed: bool,
}

/// Next fire time at or after `after`, or `None` for a spent schedule.

/// Cron expressions are validated at creation; failure here means the stored
/// row is corrupt or the expression has no match in the bounded search window.
pub(crate) fn next_fire_after_with_cron(
    kind: &str,
    interval_ms: Option<i64>,
    run_at: Option<i64>,
    cron: Option<&str>,
    after: i64,
) -> Option<i64> {
    match kind {
        // A one-shot fires when its instant arrives, so `run_at == now` is due.
        "once" => run_at.filter(|at| *at >= after),
        "interval" => {
            let interval = interval_ms?;
            if interval <= 0 {
                return None;
            }
            match run_at {
                Some(first) if first > after => Some(first),
                _ => {
                    // An interval is anchored at its first run time (or at
                    // creation), and a missed trigger is advanced over rather
                    // than replayed as a burst.
                    let base = run_at.unwrap_or(after);
                    let elapsed = after.saturating_sub(base);
                    let steps = elapsed / interval + 1;
                    Some(base.saturating_add(steps.saturating_mul(interval)))
                }
            }
        }
        "cron" => {
            let expression = cron?;
            crate::cron_schedule::next_cron_fire_after_ms(expression, after).ok()
        }
        _ => None,
    }
}

/// Advance a schedule after one fire (real or skipped).
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn advance_after_fire_with_cron(
    kind: &str,
    interval_ms: Option<i64>,
    run_at: Option<i64>,
    cron: Option<&str>,
    run_count: i64,
    max_runs: Option<i64>,
    expires_at: Option<i64>,
    fired_at: i64,
) -> ScheduleAdvance {
    let run_count = run_count.saturating_add(1);
    let exhausted = max_runs.is_some_and(|limit| run_count >= limit)
        || (kind == "once" && run_at.is_some_and(|at| at <= fired_at));
    if exhausted {
        return ScheduleAdvance {
            status: "completed".to_string(),
            next_run_at: None,
            run_count,
            completed: true,
        };
    }
    let next = next_fire_after_with_cron(kind, interval_ms, run_at, cron, fired_at);
    match next {
        Some(next) if expires_at.is_some_and(|expiry| next > expiry) => ScheduleAdvance {
            status: "expired".to_string(),
            next_run_at: None,
            run_count,
            completed: true,
        },
        Some(next) => ScheduleAdvance {
            status: "active".to_string(),
            next_run_at: Some(next),
            run_count,
            completed: false,
        },
        None => ScheduleAdvance {
            status: "completed".to_string(),
            next_run_at: None,
            run_count,
            completed: true,
        },
    }
}

/// Whether a due schedule should run or be skipped because it was missed.
///
/// `grace` is how late a trigger may be and still count as on time. Anything
/// later follows the schedule's missed policy: `skip` advances without running,
/// `run-once` fires a single catch-up run.
pub(crate) fn missed_decision(due_at: i64, now: i64, grace_ms: i64, missed_policy: &str) -> bool {
    if now.saturating_sub(due_at) <= grace_ms {
        return true;
    }
    missed_policy == "run-once"
}

pub(crate) fn required_id(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > MAX_SCHEDULE_ID_BYTES {
        return Err(format!(
            "{field} exceeds the {MAX_SCHEDULE_ID_BYTES}-byte limit"
        ));
    }
    Ok(())
}

pub(crate) fn validate_kind(value: &str) -> Result<(), String> {
    if SCHEDULE_KINDS.contains(&value) {
        return Ok(());
    }
    Err("schedule kind must be once, interval or cron".to_string())
}

pub(crate) fn validate_status(value: &str) -> Result<(), String> {
    if SCHEDULE_STATUSES.contains(&value) {
        return Ok(());
    }
    Err("schedule status is not recognised".to_string())
}

pub(crate) fn validate_policy(value: &str) -> Result<(), String> {
    if MISSED_POLICIES.contains(&value) {
        return Ok(());
    }
    Err("missedPolicy must be skip or run-once".to_string())
}

/// Parse Melody's compact interval form (`5m`, `2h`, `1d`, `90s`).
///
/// Melody clamps anything below 60 seconds up to 60; the Host keeps that rule so
/// a skill that asks for a tight loop still cannot spin the scheduler.
pub(crate) fn parse_scheduler_interval(value: &str) -> Result<i64, String> {
    let trimmed = value.trim();
    // Split on the last *character*, not the last byte: a multi-byte suffix such
    // as "5分" would otherwise make the slice panic on a non-boundary index.
    let Some(suffix) = trimmed.chars().next_back() else {
        return Err(format!(
            "invalid interval {trimmed:?}: expected e.g. 5m, 2h, 1d"
        ));
    };
    if trimmed.len() < 2 {
        return Err(format!(
            "invalid interval {trimmed:?}: expected e.g. 5m, 2h, 1d"
        ));
    }
    let digits = &trimmed[..trimmed.len() - suffix.len_utf8()];
    let amount: i64 = digits
        .parse()
        .map_err(|_| format!("invalid interval {trimmed:?}: expected e.g. 5m, 2h, 1d"))?;
    if amount <= 0 {
        return Err("interval value must be greater than 0".to_string());
    }
    let unit_ms = match suffix {
        's' => 1_000,
        'm' => 60_000,
        'h' => 3_600_000,
        'd' => 86_400_000,
        other => {
            return Err(format!(
                "invalid interval suffix {other:?}: expected s, m, h or d"
            ));
        }
    };
    // Melody's floor is one minute; the Host's is lower, so the clamp here is
    // what a model-created schedule actually gets.
    let millis = amount.saturating_mul(unit_ms);
    Ok(millis.clamp(
        MIN_SCHEDULE_INTERVAL_MS.max(60_000),
        MAX_SCHEDULE_INTERVAL_MS,
    ))
}
