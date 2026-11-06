//! Host-side projections of Melody configuration into bounded Pi runtime policy.
//!
//! Policy values are resolved from user/project config and explicit process
//! overrides, then normalized before they cross the worker boundary. The
//! generic config merge helpers remain in the parent because inventory and
//! policy projections both consume them.

use std::env;

use serde_json::Value;

use super::merged_config_string;
use crate::config_core::{
    MelodyConfigDocument, PiQuestionTimeoutPolicy, PiTerminalPolicy, read_melody_config_inner,
};

fn parse_boolean_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

const PI_TERMINAL_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const PI_TERMINAL_ABSOLUTE_MAX_TIMEOUT_MS: u64 = 36_000_000;
const PI_TERMINAL_DEFAULT_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const PI_QUESTION_TIMEOUT_DEFAULT_MS: u64 = 30 * 60 * 1000;
// JavaScript setTimeout accepts a signed 32-bit delay. Keeping the Host
// projection below that boundary avoids overflow-to-immediate timers.
const PI_QUESTION_TIMEOUT_MAX_MS: u64 = 2_147_483_647;

fn positive_seconds_to_millis(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let millis = (seconds * 1000.0).round();
    if !millis.is_finite() || millis <= 0.0 {
        return Some(1);
    }
    Some((millis as u64).clamp(1, PI_TERMINAL_ABSOLUTE_MAX_TIMEOUT_MS))
}

fn positive_output_limit(value: &Value) -> Option<usize> {
    let bytes = value.as_u64()?.max(1);
    Some(bytes.min(PI_TERMINAL_DEFAULT_OUTPUT_BYTES as u64) as usize)
}

fn positive_question_seconds_to_millis(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let millis = (seconds * 1000.0).round();
    if !millis.is_finite() || millis <= 0.0 {
        return Some(1);
    }
    Some((millis as u64).clamp(1, PI_QUESTION_TIMEOUT_MAX_MS))
}

fn terminal_policy_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    document
        .values
        .get("toolset")
        .and_then(Value::as_object)
        .and_then(|toolset| toolset.get("bash"))
        .and_then(Value::as_object)
        .and_then(|bash| bash.get(key))
        .cloned()
}

fn env_positive_seconds(name: &str) -> Option<u64> {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .and_then(|value| positive_seconds_to_millis(&Value::from(value)))
}

fn env_positive_output_limit(name: &str) -> Option<usize> {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| positive_output_limit(&Value::from(value)))
}

/// Resolve the foreground terminal controls that can be enforced by the
/// Host-owned Pi ToolGateway.  Project values override user values per field;
/// explicit environment overrides are applied last.  The hard caps keep a
/// malformed or over-generous config from turning a worker request into an
/// unbounded process or an unbounded in-memory preview.
pub(crate) fn pi_terminal_policy(cwd: &str) -> Option<PiTerminalPolicy> {
    let mut timeout_ms = None;
    let mut max_timeout_ms = None;
    let mut output_byte_limit = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = terminal_policy_value(&document, "timeout_secs")
            && let Some(parsed) = positive_seconds_to_millis(&value)
        {
            timeout_ms = Some(parsed);
        }
        if let Some(value) = terminal_policy_value(&document, "max_timeout_secs")
            && let Some(parsed) = positive_seconds_to_millis(&value)
        {
            max_timeout_ms = Some(parsed);
        }
        if let Some(value) = terminal_policy_value(&document, "output_byte_limit")
            && let Some(parsed) = positive_output_limit(&value)
        {
            output_byte_limit = Some(parsed);
        }
    }
    if let Some(parsed) = env_positive_seconds("MELODY_TERMINAL_TIMEOUT_SECS") {
        timeout_ms = Some(parsed);
    }
    if let Some(parsed) = env_positive_seconds("MELODY_TERMINAL_MAX_TIMEOUT_SECS") {
        max_timeout_ms = Some(parsed);
    }
    if let Some(parsed) = env_positive_output_limit("MELODY_TERMINAL_OUTPUT_BYTE_LIMIT") {
        output_byte_limit = Some(parsed);
    }

    if timeout_ms.is_none() && max_timeout_ms.is_none() && output_byte_limit.is_none() {
        return None;
    }
    let default_timeout_ms = timeout_ms.unwrap_or(PI_TERMINAL_DEFAULT_TIMEOUT_MS);
    let max_timeout_ms = max_timeout_ms
        .unwrap_or(PI_TERMINAL_DEFAULT_TIMEOUT_MS.max(default_timeout_ms))
        .max(1);
    Some(PiTerminalPolicy {
        default_timeout_ms: default_timeout_ms.min(max_timeout_ms),
        max_timeout_ms,
        output_byte_limit: output_byte_limit.unwrap_or(PI_TERMINAL_DEFAULT_OUTPUT_BYTES),
    })
}

fn question_policy_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    document
        .values
        .get("toolset")
        .and_then(Value::as_object)
        .and_then(|toolset| toolset.get("ask_user_question"))
        .and_then(Value::as_object)
        .and_then(|question| question.get(key))
        .cloned()
}

/// Resolve Melody's question waiting policy for the Pi worker.  Pi exposes
/// the interaction itself but no product-level timeout switch, so this small
/// Host projection preserves the existing `timeout_enabled`/`timeout_secs`
/// semantics without exposing an ambient timer or config file to the worker.
pub(crate) fn pi_question_timeout_policy(cwd: &str) -> Option<PiQuestionTimeoutPolicy> {
    let mut enabled = None;
    let mut timeout_ms = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = question_policy_value(&document, "timeout_enabled")
            && let Some(parsed) = value.as_bool()
        {
            enabled = Some(parsed);
        }
        if let Some(value) = question_policy_value(&document, "timeout_secs")
            && let Some(parsed) = positive_question_seconds_to_millis(&value)
        {
            timeout_ms = Some(parsed);
        }
    }
    if let Ok(raw) = env::var("MELODY_ASK_USER_QUESTION_TIMEOUT_ENABLED")
        && let Some(parsed) = parse_boolean_override(&raw)
    {
        enabled = Some(parsed);
    }
    if let Ok(raw) = env::var("MELODY_ASK_USER_QUESTION_TIMEOUT_SECS")
        && let Ok(seconds) = raw.parse::<f64>()
    {
        if let Some(parsed) = positive_question_seconds_to_millis(&Value::from(seconds)) {
            timeout_ms = Some(parsed);
        }
    }

    if enabled.is_none() && timeout_ms.is_none() {
        return None;
    }
    Some(PiQuestionTimeoutPolicy {
        enabled: enabled.unwrap_or(true),
        timeout_ms: timeout_ms.unwrap_or(PI_QUESTION_TIMEOUT_DEFAULT_MS),
    })
}

const PI_GOAL_MAX_TOKEN_BUDGET: u64 = 100_000_000;
const PI_GOAL_MAX_STALL_TIMEOUT_SECS: u64 = 7 * 24 * 60 * 60;
const PI_GOAL_MAX_BLOCKED_ATTEMPTS: u64 = 100;

fn goal_policy_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    for section_name in ["goal", "goal_orchestration"] {
        if let Some(value) = document
            .values
            .get(section_name)
            .and_then(Value::as_object)
            .and_then(|section| section.get(key))
        {
            return Some(value.clone());
        }
    }
    None
}

fn goal_policy_top_level_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    document.values.get(key).cloned()
}

fn positive_goal_integer(value: &Value, max: u64) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| *number >= 1 && *number <= max)
}

fn env_positive_goal_integer(name: &str, max: u64) -> Option<u64> {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|number| *number >= 1 && *number <= max)
}

/// Project the deterministic portion of Melody's goal safeguards into Pi.
///
/// A configured classifier/planner/retry policy is still negotiated by the
/// capability report and routed to ACP. This projection only carries bounded
/// token, wall-clock stall, and blocked-report controls that the Pi extension
/// can enforce without hidden model calls.
pub(crate) fn pi_goal_policy(cwd: &str) -> Option<Value> {
    let mut policy = serde_json::Map::new();
    let mut token_budget = None;
    let mut stall_detection = None;
    let mut stall_timeout_secs = None;
    let mut max_blocked_attempts = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        token_budget = goal_policy_value(&document, "token_budget")
            .or_else(|| goal_policy_top_level_value(&document, "goal_token_budget"))
            .and_then(|value| positive_goal_integer(&value, PI_GOAL_MAX_TOKEN_BUDGET))
            .or(token_budget);
        stall_detection = goal_policy_value(&document, "stall_detection")
            .or_else(|| goal_policy_top_level_value(&document, "goal_stall_detection"))
            .and_then(|value| value.as_bool())
            .or(stall_detection);
        stall_timeout_secs = goal_policy_value(&document, "stall_timeout_secs")
            .or_else(|| goal_policy_top_level_value(&document, "goal_stall_timeout_secs"))
            .and_then(|value| positive_goal_integer(&value, PI_GOAL_MAX_STALL_TIMEOUT_SECS))
            .or(stall_timeout_secs);
        max_blocked_attempts = goal_policy_value(&document, "max_blocked_attempts")
            .or_else(|| goal_policy_top_level_value(&document, "goal_max_blocked_attempts"))
            .and_then(|value| positive_goal_integer(&value, PI_GOAL_MAX_BLOCKED_ATTEMPTS))
            .or(max_blocked_attempts);
    }
    if let Some(value) =
        env_positive_goal_integer("MELODY_GOAL_TOKEN_BUDGET", PI_GOAL_MAX_TOKEN_BUDGET)
    {
        token_budget = Some(value);
    }
    if let Ok(raw) = env::var("MELODY_GOAL_STALL_DETECTION")
        && let Some(value) = parse_boolean_override(&raw)
    {
        stall_detection = Some(value);
    }
    if let Some(value) = env_positive_goal_integer(
        "MELODY_GOAL_STALL_TIMEOUT_SECS",
        PI_GOAL_MAX_STALL_TIMEOUT_SECS,
    ) {
        stall_timeout_secs = Some(value);
    }
    if let Some(value) = env_positive_goal_integer(
        "MELODY_GOAL_MAX_BLOCKED_ATTEMPTS",
        PI_GOAL_MAX_BLOCKED_ATTEMPTS,
    ) {
        max_blocked_attempts = Some(value);
    }
    if let Some(value) = token_budget {
        policy.insert("tokenBudget".to_string(), Value::from(value));
    }
    if let Some(value) = stall_detection {
        policy.insert("stallDetection".to_string(), Value::from(value));
    }
    if let Some(value) = stall_timeout_secs {
        policy.insert("stallTimeoutSecs".to_string(), Value::from(value));
    }
    if let Some(value) = max_blocked_attempts {
        policy.insert("maxBlockedAttempts".to_string(), Value::from(value));
    }
    (!policy.is_empty()).then_some(Value::Object(policy))
}

/// Resolve Melody's `.gitignore` visibility policy for the Pi worker.
///
/// The project setting wins over the user setting, and the explicit
/// `MELODY_RESPECT_GITIGNORE` environment override wins over both. Invalid
/// environment values are ignored so a malformed inherited environment cannot
/// silently change the Host's default-deny projection.
pub(crate) fn pi_respect_gitignore(cwd: &str) -> bool {
    let mut enabled = false;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = document
            .values
            .get("tools")
            .and_then(Value::as_object)
            .and_then(|tools| tools.get("respect_gitignore"))
            .and_then(Value::as_bool)
        {
            enabled = value;
        }
    }
    if let Ok(raw) = env::var("MELODY_RESPECT_GITIGNORE")
        && let Some(value) = parse_boolean_override(&raw)
    {
        enabled = value;
    }
    enabled
}

/// Host-side projection of the optional `.envrc` integration.  The worker is
/// started with an empty environment; when this setting is enabled the Host
/// evaluates only the workspace's own `.envrc` through `direnv export json`
/// and injects the bounded result into that one worker generation.
pub(crate) fn pi_load_envrc(cwd: &str) -> bool {
    let mut enabled = false;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = document
            .values
            .get("session")
            .and_then(Value::as_object)
            .and_then(|session| session.get("load_envrc"))
            .and_then(Value::as_bool)
        {
            enabled = value;
        }
    }
    if let Ok(raw) = env::var("MELODY_PI_LOAD_ENVRC")
        && let Some(value) = parse_boolean_override(&raw)
    {
        enabled = value;
    }
    enabled
}

/// Resolve whether Pi may use its native online model catalog overlay.  The
/// setting is intentionally projected as a process flag rather than copied
/// into the renderer or an arbitrary worker environment.  A custom catalog
/// base is accepted only as a public HTTPS URL; the default remains Pi's
/// signed `pi.dev` catalog.
pub(crate) fn pi_model_network_policy(cwd: &str) -> Result<Option<(bool, Option<String>)>, String> {
    // Melody-build defaults remote_fetch to true.  Keep that behavior for Pi
    // while allowing an explicit config/environment opt-out for offline use.
    let mut enabled = true;
    let mut catalog_base_url = None;
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.to_string())?;
        if let Some(error) = document.parse_error {
            return Err(format!("无法解析 {scope} Melody 配置：{error}"));
        }
        if let Some(value) = document
            .values
            .get("features")
            .and_then(Value::as_object)
            .and_then(|features| features.get("remote_fetch"))
            .and_then(Value::as_bool)
        {
            enabled = value;
        }
        if let Some(value) = document
            .values
            .get("endpoints")
            .and_then(Value::as_object)
            .and_then(|endpoints| endpoints.get("models_catalog_base_url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            catalog_base_url = Some(value.to_string());
        }
    }
    if let Ok(raw) = env::var("MELODY_PI_ALLOW_MODEL_NETWORK")
        && let Some(value) = parse_boolean_override(&raw)
    {
        enabled = value;
    }
    if let Ok(value) = env::var("MELODY_PI_CATALOG_BASE_URL") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            catalog_base_url = Some(value);
        }
    }
    if !enabled {
        return Ok(Some((false, None)));
    }
    if let Some(value) = catalog_base_url.as_deref() {
        let url =
            reqwest::Url::parse(value).map_err(|error| format!("Pi 模型目录地址无效：{error}"))?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Pi 模型目录地址必须是无凭据/片段的 HTTPS URL。".to_string());
        }
    }
    Ok(Some((true, catalog_base_url)))
}

/// The sandbox profile that applies to this workspace, if any.
///
/// `MELODY_SANDBOX` is an explicit process-level override (it is how Melody
/// launches a sandboxed agent), so it wins over `[sandbox].profile` in config.
pub(crate) fn pi_sandbox_profile(cwd: &str) -> Option<String> {
    let override_value = std::env::var(crate::workspace_sandbox::PROFILE_ENV_VAR).ok();
    resolve_sandbox_profile(
        override_value.as_deref(),
        merged_config_string(cwd, "sandbox", "profile"),
    )
}

/// Apply the documented precedence without touching the environment.
///
/// Kept pure so the rule can be tested deterministically: an explicit
/// `MELODY_SANDBOX` (unless it disables sandboxing) beats the config value.
pub(super) fn resolve_sandbox_profile(
    override_value: Option<&str>,
    config_value: Option<String>,
) -> Option<String> {
    if let Some(value) = override_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !matches!(trimmed.to_ascii_lowercase().as_str(), "off" | "none") {
            return Some(trimmed.to_string());
        }
    }
    config_value
}
