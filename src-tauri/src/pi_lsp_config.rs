//! Trusted LSP server configuration and workspace path projection.
//!
//! This module owns user/project config loading, server validation and the
//! filesystem scope checks needed before the runtime starts a configured
//! language server. The parent runtime owns process supervision and JSON-RPC.

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;

use crate::agent_runtime::melody_home;

const CONFIG_MAX_BYTES: u64 = 1024 * 1024;
const COMMAND_MAX_BYTES: usize = 1024;
const MAX_ARGS: usize = 64;
const ARG_MAX_BYTES: usize = 4096;
const MAX_ENV_ENTRIES: usize = 128;
const ENV_NAME_MAX_BYTES: usize = 128;
const ENV_VALUE_MAX_BYTES: usize = 16 * 1024;
const MAX_EXTENSION_ENTRIES: usize = 256;
const MAX_NAME_BYTES: usize = 128;

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspServerConfig {
    #[serde(default = "default_enabled")]
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) command: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) transport: Option<String>,
    #[serde(default)]
    pub(super) env: BTreeMap<String, String>,
    #[serde(
        default,
        alias = "extensionToLanguage",
        alias = "extensionToLanguageId"
    )]
    pub(super) extensions: BTreeMap<String, String>,
    #[serde(default, alias = "initializationOptions")]
    pub(super) initialization_options: Option<Value>,
    #[serde(default)]
    pub(super) settings: Option<Value>,
    #[serde(default, alias = "workspaceFolder")]
    pub(super) workspace_folder: Option<String>,
    #[serde(default, alias = "startupTimeout")]
    pub(super) startup_timeout: Option<u64>,
    #[serde(default, alias = "shutdownTimeout")]
    pub(super) shutdown_timeout: Option<u64>,
    /// Project-scoped config must opt in explicitly because it can start an
    /// executable from a repository. User-scoped config is already an
    /// explicit user setting and does not need this marker.
    #[serde(default)]
    pub(super) trusted: bool,
}

#[derive(Debug, Clone)]
pub(super) struct LoadedServer {
    pub(super) name: String,
    pub(super) scope: &'static str,
    pub(super) source_path: PathBuf,
    pub(super) config: LspServerConfig,
    pub(super) unsupported_fields: Vec<String>,
}

fn valid_name(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn valid_env_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(super) fn canonical_workspace(root: &Path) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("无法解析工作区路径：{error}"))?;
    if !canonical.is_dir() {
        return Err("工作区路径不是目录。".to_string());
    }
    Ok(canonical)
}

fn config_path(scope: &str, root: &Path) -> Result<PathBuf, String> {
    match scope {
        "user" => melody_home()
            .map(|home| home.join("lsp.json"))
            .ok_or_else(|| "无法定位 Melody 用户目录。".to_string()),
        "project" => Ok(root.join(".melody").join("lsp.json")),
        _ => Err("LSP 配置作用域无效。".to_string()),
    }
}

fn read_config_file(path: &Path) -> Result<BTreeMap<String, LspServerConfig>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("无法读取 LSP 配置 {}：{error}", path.display())),
    };
    if bytes.len() as u64 > CONFIG_MAX_BYTES {
        return Err(format!("LSP 配置 {} 超过 1 MB 限制。", path.display()));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("LSP 配置 {} 不是有效 JSON：{error}", path.display()))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("LSP 配置 {} 必须是对象。", path.display()))?;
    if object.len() > MAX_EXTENSION_ENTRIES {
        return Err("LSP server 数量超过安全上限。".to_string());
    }
    let mut result = BTreeMap::new();
    for (name, value) in object {
        if !valid_name(name, MAX_NAME_BYTES) {
            return Err(format!("LSP server 名称无效：{name}"));
        }
        let config: LspServerConfig = serde_json::from_value(value.clone())
            .map_err(|error| format!("LSP server {name} 配置无效：{error}"))?;
        result.insert(name.clone(), config);
    }
    Ok(result)
}

fn validate_server(scope: &'static str, root: &Path, config: &LspServerConfig) -> Vec<String> {
    let mut unsupported = Vec::new();
    if !valid_name(&config.command, COMMAND_MAX_BYTES) {
        unsupported.push("command".to_string());
    }
    if config.args.len() > MAX_ARGS
        || config
            .args
            .iter()
            .any(|arg| !valid_name(arg, ARG_MAX_BYTES))
    {
        unsupported.push("args".to_string());
    }
    let transport = config
        .transport
        .as_deref()
        .unwrap_or("stdio")
        .trim()
        .to_ascii_lowercase();
    if !["stdio", "local"].contains(&transport.as_str()) {
        unsupported.push("transport".to_string());
    }
    if config.env.len() > MAX_ENV_ENTRIES
        || config.env.iter().any(|(name, value)| {
            name.len() > ENV_NAME_MAX_BYTES
                || !valid_env_name(name)
                || value.len() > ENV_VALUE_MAX_BYTES
                || value.chars().any(char::is_control)
        })
    {
        unsupported.push("env".to_string());
    }
    if config.extensions.len() > MAX_EXTENSION_ENTRIES
        || config
            .extensions
            .iter()
            .any(|(extension, language)| !valid_name(extension, 256) || !valid_name(language, 128))
    {
        unsupported.push("extensions".to_string());
    }
    if let Some(folder) = &config.workspace_folder {
        if resolve_workspace_folder(root, folder).is_err() {
            unsupported.push("workspaceFolder".to_string());
        }
    }
    if scope == "project" && !config.trusted {
        unsupported.push("projectTrustRequired".to_string());
    }
    if config.initialization_options.as_ref().is_some_and(|value| {
        serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > 256 * 1024)
    }) {
        unsupported.push("initializationOptions".to_string());
    }
    if config.settings.as_ref().is_some_and(|value| {
        serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > 256 * 1024)
    }) {
        unsupported.push("settings".to_string());
    }
    unsupported.sort();
    unsupported.dedup();
    unsupported
}

pub(super) fn load_servers(root: &Path) -> Result<Vec<LoadedServer>, String> {
    let root = canonical_workspace(root)?;
    let mut merged: BTreeMap<String, LoadedServer> = BTreeMap::new();
    for scope in ["user", "project"] {
        let path = config_path(scope, &root)?;
        let configs = read_config_file(&path)?;
        for (name, config) in configs {
            let scope_static: &'static str = if scope == "user" { "user" } else { "project" };
            let unsupported = validate_server(scope_static, &root, &config);
            merged.insert(
                name.clone(),
                LoadedServer {
                    name,
                    scope: scope_static,
                    source_path: path.clone(),
                    config,
                    unsupported_fields: unsupported,
                },
            );
        }
    }
    Ok(merged.into_values().collect())
}

pub(super) fn normalize_file_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    if !valid_name(value, 4096) {
        return Err("file_path 必须是有效路径。".to_string());
    }
    let candidate = {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法读取 LSP 文件 {}：{error}", candidate.display()))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err("LSP 文件必须位于当前工作区内。".to_string());
    }
    Ok(canonical)
}

fn resolve_workspace_folder(root: &Path, value: &str) -> Result<PathBuf, String> {
    if !valid_name(value, 4096) {
        return Err("workspaceFolder 必须是有效路径。".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法解析工作区路径：{error}"))?;
    let path = PathBuf::from(value);
    let candidate = if path.is_absolute() {
        path
    } else {
        canonical_root.join(path)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析 LSP workspaceFolder：{error}"))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_dir() {
        return Err("workspaceFolder 必须位于当前工作区内。".to_string());
    }
    Ok(canonical)
}

pub(super) fn workspace_root_for_server(root: &Path, config: &LspServerConfig) -> PathBuf {
    config
        .workspace_folder
        .as_ref()
        .and_then(|path| resolve_workspace_folder(root, path).ok())
        .unwrap_or_else(|| root.to_path_buf())
}

pub(super) fn language_id(server: &LoadedServer, path: &Path) -> String {
    let extension = path.extension().and_then(|value| value.to_str());
    extension
        .and_then(|extension| {
            let dot = format!(".{extension}");
            server
                .config
                .extensions
                .iter()
                .find_map(|(candidate, language)| {
                    candidate
                        .trim_start_matches('.')
                        .eq_ignore_ascii_case(dot.trim_start_matches('.'))
                        .then(|| language.clone())
                })
        })
        .unwrap_or_else(|| "plaintext".to_string())
}

pub(super) fn file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut encoded = String::with_capacity(raw.len() + 8);
    for byte in raw.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            encoded.push(char::from(b"0123456789ABCDEF"[(byte & 0x0f) as usize]));
        }
    }
    format!("file://{encoded}")
}
