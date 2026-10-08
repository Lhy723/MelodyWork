//! Restricted 5-field cron expressions for Host-owned schedules.
//!
//! Deliberately self-contained (no external parser crate): the dispatcher runs
//! this on every fire, so the search is bounded and every edge is unit-tested.
//! Supported syntax is the classic Vixie minute subset:
//! `minute hour day-of-month month day-of-week` with `*`, `a-b`, `a-b/step`,
//! `*/step`, and comma lists. Both day fields restricted follows Vixie's
//! either-matches rule. Times are evaluated in the machine's local timezone.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike};

const MAX_EXPRESSION_BYTES: usize = 256;
/// Bound the forward search: a never-matching expression (e.g. `0 0 31 2 *`)
/// must fail fast instead of hanging the dispatcher.
const SEARCH_HORIZON_DAYS: i64 = 5 * 366;
const MAX_SEARCH_STEPS: u32 = 500_000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CronFields {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: Vec<u32>,
    months: Vec<u32>,
    days_of_week: Vec<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FieldSpec {
    min: u32,
    max: u32,
}

const MINUTE: FieldSpec = FieldSpec { min: 0, max: 59 };
const HOUR: FieldSpec = FieldSpec { min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = FieldSpec { min: 1, max: 31 };
const MONTH: FieldSpec = FieldSpec { min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = FieldSpec { min: 0, max: 7 };

fn parse_field(field: &str, spec: FieldSpec) -> Result<(Vec<u32>, bool), String> {
    if field.is_empty() {
        return Err("empty cron field".to_string());
    }
    let mut values = Vec::new();
    for part in field.split(',') {
        if part.is_empty() {
            return Err(format!("empty list item in cron field {field:?}"));
        }
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step
                    .parse()
                    .map_err(|_| format!("invalid step {step:?} in cron field {field:?}"))?;
                if step == 0 {
                    return Err(format!("step must be at least 1 in cron field {field:?}"));
                }
                (range, step)
            }
            None => (part, 1),
        };
        let (low, high) = if range == "*" {
            (spec.min, spec.max)
        } else if let Some((low, high)) = range.split_once('-') {
            let low: u32 = low
                .parse()
                .map_err(|_| format!("invalid value {low:?} in cron field {field:?}"))?;
            let high: u32 = high
                .parse()
                .map_err(|_| format!("invalid value {high:?} in cron field {field:?}"))?;
            (low, high)
        } else {
            let value: u32 = range
                .parse()
                .map_err(|_| format!("invalid value {range:?} in cron field {field:?}"))?;
            if step > 1 {
                // `5/2` is Vixie shorthand for `5-max/2`.
                (value, spec.max)
            } else {
                (value, value)
            }
        };
        if low < spec.min || high > spec.max || low > high {
            return Err(format!(
                "value out of range {}-{} in cron field {field:?}",
                spec.min, spec.max
            ));
        }
        let mut value = low;
        while value <= high {
            values.push(value);
            value += step;
        }
    }
    values.sort_unstable();
    values.dedup();
    Ok((values, field != "*"))
}

fn day_of_week_value(raw: u32) -> u32 {
    // Vixie allows 7 for Sunday; normalize to 0 so the set matches `weekday()`.
    if raw == 7 { 0 } else { raw }
}

impl CronFields {
    /// Vixie semantics: when both day fields are restricted, a day matches if
    /// EITHER matches.
    fn day_matches(&self, day: u32, weekday: u32) -> bool {
        let dom_ok = self.days_of_month.contains(&day);
        let dow_ok = self.days_of_week.contains(&weekday);
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom_ok || dow_ok,
            (true, false) => dom_ok,
            (false, true) => dow_ok,
            (false, false) => true,
        }
    }
}

pub(crate) fn parse_cron_expression(value: &str) -> Result<CronFields, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("cron expression is empty".to_string());
    }
    if trimmed.len() > MAX_EXPRESSION_BYTES {
        return Err(format!(
            "cron expression exceeds the {MAX_EXPRESSION_BYTES}-byte limit"
        ));
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got {}",
            fields.len()
        ));
    }
    let (minutes, _) = parse_field(fields[0], MINUTE)?;
    let (hours, _) = parse_field(fields[1], HOUR)?;
    let (days_of_month, dom_restricted) = parse_field(fields[2], DAY_OF_MONTH)?;
    let (months, _) = parse_field(fields[3], MONTH)?;
    let (days_of_week_raw, dow_restricted) = parse_field(fields[4], DAY_OF_WEEK)?;
    let days_of_week: Vec<u32> = {
        let mut normalized: Vec<u32> = days_of_week_raw
            .iter()
            .map(|d| day_of_week_value(*d))
            .collect();
        normalized.sort_unstable();
        normalized.dedup();
        normalized
    };
    Ok(CronFields {
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        dom_restricted,
        dow_restricted,
    })
}

/// The next fire time strictly after `after_ms` (epoch milliseconds), in the
/// given timezone, or `None` when nothing matches within the search horizon.
fn next_cron_fire_in_tz<Tz: TimeZone>(fields: &CronFields, after_ms: i64, tz: &Tz) -> Option<i64> {
    let start: DateTime<Tz> = tz.timestamp_millis_opt(after_ms).single()?;
    // Candidates are minute-aligned and strictly after `after`.
    let mut current = start.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
    let horizon = current.date_naive() + Duration::days(SEARCH_HORIZON_DAYS);
    for _ in 0..MAX_SEARCH_STEPS {
        if current.date_naive() > horizon {
            return None;
        }
        if !fields.months.contains(&current.month()) {
            // Jump to the first minute of the next month.
            let next_month = if current.month() == 12 {
                current
                    .date_naive()
                    .with_year(current.year() + 1)
                    .and_then(|date| date.with_month(1))
            } else {
                current.date_naive().with_month(current.month() + 1)
            }
            .and_then(|date| date.with_day(1))
            .and_then(|date| date.and_hms_opt(0, 0, 0))?;
            current = tz.from_local_datetime(&next_month).earliest()?;
            continue;
        }
        if !fields.day_matches(current.day(), current.weekday().num_days_from_sunday()) {
            let next_day = current
                .date_naive()
                .succ_opt()
                .and_then(|date| date.and_hms_opt(0, 0, 0))?;
            current = tz.from_local_datetime(&next_day).earliest()?;
            continue;
        }
        if !fields.hours.contains(&current.hour()) {
            current =
                current.with_minute(0)?.with_second(0)?.with_nanosecond(0)? + Duration::hours(1);
            continue;
        }
        if !fields.minutes.contains(&current.minute()) {
            current += Duration::minutes(1);
            continue;
        }
        return Some(current.timestamp_millis());
    }
    None
}

/// Parse and search in one step. `after_ms` is epoch milliseconds; the result
/// is epoch milliseconds of the next matching local minute.
pub(crate) fn next_cron_fire_after_ms(value: &str, after_ms: i64) -> Result<i64, String> {
    let fields = parse_cron_expression(value)?;
    next_cron_fire_in_tz(&fields, after_ms, &chrono::Local)
        .ok_or_else(|| format!("cron expression {value:?} never fires within the search horizon"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tz() -> chrono::FixedOffset {
        chrono::FixedOffset::east_opt(8 * 3600).unwrap()
    }

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        let naive = chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap();
        tz().from_local_datetime(&naive)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn parses_lists_ranges_steps_and_dow_seven() {
        let fields = parse_cron_expression("*/15 0 1,15 1-3 7").unwrap();
        assert_eq!(fields.minutes, vec![0, 15, 30, 45]);
        assert_eq!(fields.hours, vec![0]);
        assert_eq!(fields.days_of_month, vec![1, 15]);
        assert_eq!(fields.months, vec![1, 2, 3]);
        // 7 normalizes to Sunday (0).
        assert_eq!(fields.days_of_week, vec![0]);
        assert!(fields.dom_restricted);
        assert!(fields.dow_restricted);
        // A bare `*` is unrestricted; `*/2` is restricted.
        let all = parse_cron_expression("* * * * *").unwrap();
        assert!(!all.dom_restricted && !all.dow_restricted);
        let stepped = parse_cron_expression("0 0 */2 * *").unwrap();
        assert!(stepped.dom_restricted);
    }

    #[test]
    fn rejects_malformed_expressions() {
        for expression in [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 32 * *",
            "* * * 13 *",
            "* * * * 8",
            "*/0 * * * *",
            "5-1 * * * *",
            "1,,2 * * * *",
        ] {
            assert!(parse_cron_expression(expression).is_err(), "{expression:?}");
        }
        let long = format!("0 0 1 1 {}", "1".repeat(300));
        assert!(parse_cron_expression(&long).is_err());
    }

    #[test]
    fn finds_the_next_matching_minute() {
        // 10:07 → next 15-minute mark is 10:15.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("*/15 * * * *").unwrap(),
                at(2026, 1, 5, 10, 7),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 5, 10, 15)
        );
        // Same minute is strictly excluded: 10:15 → 10:30.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("*/15 * * * *").unwrap(),
                at(2026, 1, 5, 10, 15),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 5, 10, 30)
        );
        // Hour skip: 09:59 with hour set {5} lands at 05:00 the next day.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 5 * * *").unwrap(),
                at(2026, 1, 5, 9, 59),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 6, 5, 0)
        );
    }

    #[test]
    fn respects_weekday_and_month_boundaries() {
        // 2026-01-05 is a Monday; Saturday 2026-01-10 → Monday 2026-01-12 09:00.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 9 * * 1-5").unwrap(),
                at(2026, 1, 10, 12, 0),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 12, 9, 0)
        );
        // Yearly: after Jan 1 the next match is the next Jan 1.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 0 1 1 *").unwrap(),
                at(2026, 1, 1, 0, 0),
                &tz()
            )
            .unwrap(),
            at(2027, 1, 1, 0, 0)
        );
        // Leap day: from 2025 the next Feb 29 is in 2028.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 0 29 2 *").unwrap(),
                at(2025, 6, 1, 0, 0),
                &tz()
            )
            .unwrap(),
            at(2028, 2, 29, 0, 0)
        );
    }

    #[test]
    fn vixie_rule_either_day_field_matches_when_both_are_restricted() {
        // 2026-01-01 is a Thursday. "13th OR Friday" fires on Friday Jan 2
        // first — the OR rule is what makes that happen.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 0 13 * 5").unwrap(),
                at(2026, 1, 1, 0, 0),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 2, 0, 0)
        );
        // After Friday Jan 9 the 13th (a Tuesday) fires before the next Friday.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 0 13 * 5").unwrap(),
                at(2026, 1, 9, 0, 1),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 13, 0, 0)
        );
        // Then the following Friday.
        assert_eq!(
            next_cron_fire_in_tz(
                &parse_cron_expression("0 0 13 * 5").unwrap(),
                at(2026, 1, 13, 0, 1),
                &tz()
            )
            .unwrap(),
            at(2026, 1, 16, 0, 0)
        );
    }

    #[test]
    fn never_matching_expressions_are_bounded() {
        // Feb 31 does not exist: the search must terminate with an error rather
        // than hang the dispatcher.
        let error = next_cron_fire_after_ms("0 0 31 2 *", at(2026, 1, 1, 0, 0)).unwrap_err();
        assert!(error.contains("never fires"), "{error}");
    }

    #[test]
    fn agrees_with_a_brute_force_minute_scan() {
        let expression = "*/7 3-5 * * 1,3";
        let fields = parse_cron_expression(expression).unwrap();
        let start = at(2026, 3, 1, 0, 0);
        let fast = next_cron_fire_in_tz(&fields, start, &tz()).unwrap();
        // Brute force: scan minute by minute for 90 days.
        let mut probe = tz().timestamp_millis_opt(start + 60_000).single().unwrap();
        let mut expected = None;
        for _ in 0..(90 * 24 * 60) {
            if fields.minutes.contains(&probe.minute())
                && fields.hours.contains(&probe.hour())
                && fields.day_matches(probe.day(), probe.weekday().num_days_from_sunday())
            {
                expected = Some(probe.timestamp_millis());
                break;
            }
            probe += Duration::minutes(1);
        }
        assert_eq!(Some(fast), expected);
    }
}
