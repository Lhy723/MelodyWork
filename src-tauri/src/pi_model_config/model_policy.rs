//! Host projection of Melody's per-model request policies into the versioned
//! snapshot consumed by the Pi worker.
//!
//! This owner is deliberately pure: it resolves user/project precedence and
//! validates values before the parent model-config module writes either
//! generated Pi file.

use serde::{Deserialize, Serialize};

const MAX_PI_IDLE_TIMEOUT_SECS: u64 = 2_147_483;
const MAX_PI_POLICY_RETRIES: u64 = 10_000;
const MAX_PI_AUTO_COMPACT_THRESHOLD_PERCENT: u8 = 100;
const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT: u8 = 85;

/// Per-model request policy accepted by Pi's public `SettingsManager`.
/// Credentials and arbitrary request fields are intentionally excluded.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiModelPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) max_retries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) inference_idle_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) auto_compact_threshold_percent: Option<u8>,
}

/// Resolve the request policy with model-over-global precedence. Session-wide
/// auto-compaction is the fallback, followed by the product default. Pi's HTTP
/// timeout uses an i32-compatible duration internally, so unrepresentable
/// values are rejected instead of being silently wrapped.
pub(super) fn project_policy(
    model: &toml::Table,
    global: &toml::Table,
    session: &toml::Table,
    alias: &str,
) -> Result<PiModelPolicy, String> {
    let max_retries = bounded_retry_value(model, "max_retries", alias)?.or(bounded_retry_value(
        global,
        "max_retries",
        "default",
    )?);
    let timeout_secs = super::positive_value(model, "inference_idle_timeout_secs")
        .or_else(|| super::positive_value(global, "inference_idle_timeout_secs"));
    let inference_idle_timeout_ms = match timeout_secs {
        Some(seconds) if seconds <= MAX_PI_IDLE_TIMEOUT_SECS => Some(seconds * 1000),
        Some(seconds) => {
            return Err(format!(
                "[model.{alias}] 的 inference_idle_timeout_secs={seconds} 不能超过 {MAX_PI_IDLE_TIMEOUT_SECS} 秒"
            ));
        }
        None => None,
    };
    let auto_compact_threshold_percent =
        percentage_value(model, "auto_compact_threshold_percent", alias)?
            .or(percentage_value(
                session,
                "auto_compact_threshold_percent",
                alias,
            )?)
            .or(Some(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT));

    Ok(PiModelPolicy {
        max_retries,
        inference_idle_timeout_ms,
        auto_compact_threshold_percent,
    })
}

fn nonnegative_value(table: &toml::Table, key: &str) -> Option<u64> {
    table
        .get(key)
        .and_then(toml::Value::as_integer)
        .and_then(|value| u64::try_from(value).ok())
}

fn bounded_retry_value(table: &toml::Table, key: &str, alias: &str) -> Result<Option<u64>, String> {
    let Some(value) = nonnegative_value(table, key) else {
        return Ok(None);
    };
    if value > MAX_PI_POLICY_RETRIES {
        return Err(format!(
            "[model.{alias}] 的 {key}={value} 不能超过 {MAX_PI_POLICY_RETRIES}"
        ));
    }
    Ok(Some(value))
}

fn percentage_value(table: &toml::Table, key: &str, alias: &str) -> Result<Option<u8>, String> {
    let Some(value) = table.get(key) else {
        return Ok(None);
    };
    let Some(raw) = value.as_integer() else {
        return Err(format!("[model.{alias}] 的 {key} 必须是 0 到 100 的整数"));
    };
    u8::try_from(raw)
        .ok()
        .filter(|value| *value <= MAX_PI_AUTO_COMPACT_THRESHOLD_PERCENT)
        .map(Some)
        .ok_or_else(|| format!("[model.{alias}] 的 {key} 必须是 0 到 100 的整数"))
}
