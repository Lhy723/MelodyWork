//! Bounded and isolated projection of user-approved `.envrc` environment.
//!
//! The worker supervisor supplies its explicit inherited-environment
//! allowlist. This module runs `direnv` from an empty environment, then filters
//! and bounds the returned values before they can reach the worker process.

use std::{env, path::Path, process::Stdio};

use serde_json::Value;
use tokio::{
    process::Command,
    time::{Duration, timeout},
};

use crate::config_runtime::pi_load_envrc;

const ENVRC_TIMEOUT: Duration = Duration::from_secs(5);
const ENVRC_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const ENVRC_MAX_ENTRIES: usize = 256;
const ENVRC_MAX_KEY_BYTES: usize = 128;
pub(super) const ENVRC_MAX_VALUE_BYTES: usize = 16 * 1024;

fn valid_envrc_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn denied_envrc_name(value: &str) -> bool {
    matches!(
        value,
        "LD_PRELOAD" | "DYLD_INSERT_LIBRARIES" | "NODE_OPTIONS" | "RUSTFLAGS" | "BASH_ENV"
    ) || value.starts_with("DYLD_")
}

pub(super) fn parse_envrc_json(output: &[u8]) -> Result<Vec<(String, String)>, String> {
    if output.len() > ENVRC_MAX_OUTPUT_BYTES {
        return Err("direnv 输出超过 1 MB 限制。".to_string());
    }
    let value: Value = serde_json::from_slice(output)
        .map_err(|error| format!("direnv 返回的环境不是有效 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "direnv export json 必须返回一个对象。".to_string())?;
    if object.len() > ENVRC_MAX_ENTRIES {
        return Err(format!(
            ".envrc 导出的环境变量超过 {ENVRC_MAX_ENTRIES} 个。"
        ));
    }
    let mut entries = Vec::with_capacity(object.len());
    for (name, value) in object {
        if name.len() > ENVRC_MAX_KEY_BYTES || !valid_envrc_name(name) || denied_envrc_name(name) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        if value.len() > ENVRC_MAX_VALUE_BYTES {
            return Err(format!(".envrc 环境变量 {name} 超过大小限制。"));
        }
        entries.push((name.clone(), value.to_string()));
    }
    Ok(entries)
}

pub(super) async fn load_envrc(
    cwd: &Path,
    inherited_worker_env: &[&str],
) -> Result<Vec<(String, String)>, String> {
    if !pi_load_envrc(&cwd.to_string_lossy()) || !cwd.join(".envrc").is_file() {
        return Ok(Vec::new());
    }
    let direnv = env::var_os("MELODY_DIRENV_PATH").unwrap_or_else(|| "direnv".into());
    let mut command = Command::new(direnv);
    command
        .args(["export", "json"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for key in inherited_worker_env {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("DIRENV_LOG_FORMAT", "");
    let output = timeout(ENVRC_TIMEOUT, command.output())
        .await
        .map_err(|_| "direnv 加载 .envrc 超时（5 秒）。".to_string())?
        .map_err(|error| format!("无法执行 direnv export json：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "direnv 加载 .envrc 失败（{}）：{}",
            output.status,
            bounded_stderr(&stderr)
        ));
    }
    parse_envrc_json(&output.stdout)
}

fn bounded_stderr(value: &str) -> String {
    let value = value.trim();
    if value.len() <= 512 {
        return value.to_string();
    }
    let mut end = 512;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}
