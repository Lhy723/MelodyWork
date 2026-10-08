//! Host-owned, read-only LSP bridge for the Pi worker.
//!
//! Pi deliberately does not start language servers itself.  This module keeps
//! the old Melody `lsp` tool useful without giving the worker an ambient
//! process or filesystem handle: the Host loads a bounded `.melody/lsp.json`,
//! validates the selected server and workspace path, runs one short-lived
//! stdio JSON-RPC session, and returns only a bounded text result.
//!
//! The bridge intentionally implements the same read-only operations exposed
//! by Melody-build (`definition`, `references`, `hover`, `implementation`,
//! `documentSymbol`, and `workspaceSymbol`).  A fresh process per call is a
//! conservative first-party implementation.  It avoids orphaned language
//! servers and makes worker stop/restart cleanup deterministic; a future
//! persistent manager can reuse this protocol boundary without changing the
//! Pi tool contract.

use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    agent_runtime::melody_home,
    pi_tool_gateway::{self, success_for_request, tool_request_arguments},
};

pub(crate) const LSP_TOOL: &str = "lsp";

const CONFIG_MAX_BYTES: u64 = 1024 * 1024;
const COMMAND_MAX_BYTES: usize = 1024;
const MAX_ARGS: usize = 64;
const ARG_MAX_BYTES: usize = 4096;
const MAX_ENV_ENTRIES: usize = 128;
const ENV_NAME_MAX_BYTES: usize = 128;
const ENV_VALUE_MAX_BYTES: usize = 16 * 1024;
const MAX_EXTENSION_ENTRIES: usize = 256;
const MAX_NAME_BYTES: usize = 128;
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 2048;
const MAX_POSITION: u64 = 100_000;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LspServerConfig {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(
        default,
        alias = "extensionToLanguage",
        alias = "extensionToLanguageId"
    )]
    extensions: BTreeMap<String, String>,
    #[serde(default, alias = "initializationOptions")]
    initialization_options: Option<Value>,
    #[serde(default)]
    settings: Option<Value>,
    #[serde(default, alias = "workspaceFolder")]
    workspace_folder: Option<String>,
    #[serde(default, alias = "startupTimeout")]
    startup_timeout: Option<u64>,
    #[serde(default, alias = "shutdownTimeout")]
    shutdown_timeout: Option<u64>,
    /// Project-scoped config must opt in explicitly because it can start an
    /// executable from a repository. User-scoped config is already an
    /// explicit user setting and does not need this marker.
    #[serde(default)]
    trusted: bool,
}

#[derive(Debug, Clone)]
struct LoadedServer {
    name: String,
    scope: &'static str,
    source_path: PathBuf,
    config: LspServerConfig,
    unsupported_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MelodyLspServer {
    pub(crate) name: String,
    pub(crate) scope: String,
    pub(crate) path: String,
    pub(crate) enabled: bool,
    pub(crate) supported: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) unsupported_fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LspOperation {
    Definition,
    References,
    Hover,
    Implementation,
    DocumentSymbol,
    WorkspaceSymbol,
}

impl LspOperation {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "goToDefinition" | "definition" => Some(Self::Definition),
            "findReferences" | "references" => Some(Self::References),
            "hover" => Some(Self::Hover),
            "goToImplementation" | "implementation" => Some(Self::Implementation),
            "documentSymbol" | "documentSymbols" => Some(Self::DocumentSymbol),
            "workspaceSymbol" | "workspaceSymbols" => Some(Self::WorkspaceSymbol),
            _ => None,
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Definition => "textDocument/definition",
            Self::References => "textDocument/references",
            Self::Hover => "textDocument/hover",
            Self::Implementation => "textDocument/implementation",
            Self::DocumentSymbol => "textDocument/documentSymbol",
            Self::WorkspaceSymbol => "workspace/symbol",
        }
    }

    fn requires_position(self) -> bool {
        !matches!(self, Self::WorkspaceSymbol)
    }
}

#[derive(Debug)]
struct LspResponseReader {
    receiver: Receiver<Result<Value, String>>,
}

/// Owns a language-server child for the complete duration of a request.
///
/// Every error path in `run_server` must terminate the short-lived process;
/// otherwise a malformed response or a failed file read would leave an
/// orphaned language server behind.  Keeping the cleanup in `Drop` makes that
/// invariant independent of how many fallible steps are added to the bridge.
struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn as_mut(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("LSP child guard was disarmed before use")
    }

    fn disarm(&mut self) {
        self.child.take();
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn bounded_text(value: impl Into<String>) -> String {
    let value = value.into();
    if value.len() <= MAX_OUTPUT_BYTES {
        return value;
    }
    let suffix = "\n[output truncated]";
    let mut end = MAX_OUTPUT_BYTES.saturating_sub(suffix.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut result = value[..end].to_string();
    result.push_str(suffix);
    result
}

fn valid_name(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn valid_env_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn canonical_workspace(root: &Path) -> Result<PathBuf, String> {
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

fn validate_server(
    name: &str,
    scope: &'static str,
    root: &Path,
    config: &LspServerConfig,
) -> Vec<String> {
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
    let _ = name;
    unsupported
}

fn load_servers(root: &Path) -> Result<Vec<LoadedServer>, String> {
    let root = canonical_workspace(root)?;
    let mut merged: BTreeMap<String, LoadedServer> = BTreeMap::new();
    for scope in ["user", "project"] {
        let path = config_path(scope, &root)?;
        let configs = read_config_file(&path)?;
        for (name, config) in configs {
            let scope_static: &'static str = if scope == "user" { "user" } else { "project" };
            let unsupported = validate_server(&name, scope_static, &root, &config);
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

/// Return the effective LSP inventory for the Settings/capability preflight.
/// Project entries are included as unsupported until the config explicitly
/// opts into `trusted = true`; malformed files fail closed to ACP.
pub(crate) fn list_melody_lsp_servers(cwd: &str) -> Result<Vec<MelodyLspServer>, String> {
    let root = canonical_workspace(Path::new(cwd))?;
    Ok(load_servers(&root)?
        .into_iter()
        .map(|server| MelodyLspServer {
            name: server.name,
            scope: server.scope.to_string(),
            path: server.source_path.to_string_lossy().into_owned(),
            enabled: server.config.enabled,
            supported: server.unsupported_fields.is_empty(),
            unsupported_fields: server.unsupported_fields,
        })
        .collect())
}

fn normalize_file_path(root: &Path, value: &str) -> Result<PathBuf, String> {
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

fn choose_server<'a>(
    servers: &'a [LoadedServer],
    operation: LspOperation,
    path: Option<&Path>,
) -> Result<Vec<&'a LoadedServer>, String> {
    let supported = servers
        .iter()
        .filter(|server| server.config.enabled && server.unsupported_fields.is_empty())
        .collect::<Vec<_>>();
    if supported.is_empty() {
        return Err(
            "没有可安全启动的 LSP server；请检查 .melody/lsp.json（项目配置需 trusted=true）。"
                .to_string(),
        );
    }
    if matches!(operation, LspOperation::WorkspaceSymbol) {
        return Ok(supported);
    }
    let path = path.ok_or_else(|| "该 LSP 操作需要 file_path。".to_string())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"));
    let matching = supported
        .iter()
        .filter(|server| {
            extension.as_deref().is_some_and(|extension| {
                server.config.extensions.keys().any(|candidate| {
                    candidate.eq_ignore_ascii_case(extension)
                        || candidate
                            .trim_start_matches('.')
                            .eq_ignore_ascii_case(extension.trim_start_matches('.'))
                })
            })
        })
        .copied()
        .collect::<Vec<_>>();
    if !matching.is_empty() {
        return Ok(matching.into_iter().take(1).collect());
    }
    if supported.len() == 1 {
        return Ok(supported);
    }
    let extension = extension.unwrap_or_else(|| "<无扩展名>".to_string());
    let _ = operation;
    Err(format!("没有 LSP server 声明处理文件扩展名 {extension}。"))
}

fn language_id(server: &LoadedServer, path: &Path) -> String {
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

fn file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut encoded = String::with_capacity(raw.len() + 8);
    for byte in raw.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            encoded.push(char::from(b"0123456789ABCDEF"[(byte & 0x0F) as usize]));
        }
    }
    format!("file://{encoded}")
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                output.push((hi * 16 + lo) as u8);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn location_path(value: &Value) -> Option<(String, u64, u64)> {
    let object = value.as_object()?;
    let uri = object
        .get("uri")
        .or_else(|| object.get("targetUri"))
        .and_then(Value::as_str)?;
    let range = object
        .get("range")
        .or_else(|| object.get("targetSelectionRange"))
        .and_then(Value::as_object)?;
    let start = range.get("start").and_then(Value::as_object)?;
    let line = start.get("line").and_then(Value::as_u64).unwrap_or(0);
    let character = start.get("character").and_then(Value::as_u64).unwrap_or(0);
    let path = uri
        .strip_prefix("file://")
        .map(percent_decode)
        .unwrap_or_else(|| uri.to_string());
    Some((path, line + 1, character + 1))
}

fn result_items(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

fn format_locations(label: &str, value: &Value) -> String {
    let mut locations = result_items(value)
        .into_iter()
        .filter_map(location_path)
        .map(|(path, line, character)| format!("  {path}:{line}:{character}"))
        .collect::<Vec<_>>();
    locations.sort();
    locations.dedup();
    if locations.is_empty() {
        return "No results found.".to_string();
    }
    format!(
        "{label} ({} location{}):\n{}",
        locations.len(),
        if locations.len() == 1 { "" } else { "s" },
        locations.join("\n")
    )
}

fn symbol_kind(value: &Value) -> &'static str {
    match value.as_u64().unwrap_or(0) {
        1 => "File",
        2 => "Module",
        3 => "Namespace",
        4 => "Package",
        5 => "Class",
        6 => "Method",
        7 => "Property",
        8 => "Field",
        9 => "Constructor",
        10 => "Enum",
        11 => "Interface",
        12 => "Function",
        13 => "Variable",
        14 => "Constant",
        15 => "String",
        16 => "Number",
        17 => "Boolean",
        18 => "Array",
        19 => "Object",
        20 => "Key",
        21 => "Null",
        22 => "EnumMember",
        23 => "Struct",
        24 => "Event",
        25 => "Operator",
        26 => "TypeParameter",
        _ => "Symbol",
    }
}

fn append_symbols(value: &Value, output: &mut Vec<String>) {
    let Some(object) = value.as_object() else {
        return;
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return;
    };
    let location = object
        .get("location")
        .and_then(location_path)
        .or_else(|| location_path(value));
    let Some((path, line, _character)) = location else {
        return;
    };
    let kind = symbol_kind(object.get("kind").unwrap_or(&Value::Null));
    output.push(format!("{kind} {name} ({path}:{line})"));
    if let Some(children) = object.get("children").and_then(Value::as_array) {
        for child in children {
            append_symbols(child, output);
        }
    }
}

fn format_symbols(value: &Value) -> String {
    let mut symbols = Vec::new();
    for item in result_items(value) {
        append_symbols(item, &mut symbols);
    }
    symbols.sort();
    symbols.dedup();
    if symbols.is_empty() {
        "No symbols found.".to_string()
    } else {
        bounded_text(symbols.join("\n"))
    }
}

fn hover_text(value: &Value) -> String {
    let Some(contents) = value.get("contents") else {
        return "No hover information available.".to_string();
    };
    fn one(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => Some(text.clone()),
            Value::Object(object) => object
                .get("value")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            _ => None,
        }
    }
    let text = match contents {
        Value::Array(items) => items.iter().filter_map(one).collect::<Vec<_>>().join("\n"),
        other => one(other).unwrap_or_default(),
    };
    if text.trim().is_empty() {
        "No hover information available.".to_string()
    } else {
        bounded_text(text)
    }
}

fn write_frame(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| format!("LSP JSON 编码失败：{error}"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err("LSP 请求超过 1 MB 限制。".to_string());
    }
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())
        .and_then(|_| stdin.write_all(&body))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("写入 LSP 请求失败：{error}"))
}

fn read_frame(reader: &mut BufReader<ChildStdout>) -> Result<Option<Vec<u8>>, String> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("读取 LSP header 失败：{error}"))?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            let length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "LSP Content-Length 无效。".to_string())?;
            if length > MAX_FRAME_BYTES {
                return Err("LSP 响应超过 1 MB 限制。".to_string());
            }
            content_length = Some(length);
        }
    }
    let Some(length) = content_length else {
        return Err("LSP 响应缺少 Content-Length。".to_string());
    };
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("读取 LSP 响应失败：{error}"))?;
    Ok(Some(body))
}

fn spawn_response_reader(stdout: ChildStdout) -> LspResponseReader {
    let (sender, receiver): (
        SyncSender<Result<Value, String>>,
        Receiver<Result<Value, String>>,
    ) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let frame = match read_frame(&mut reader) {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    let _ = sender.send(Err("LSP server 已关闭输出。".to_string()));
                    break;
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            };
            let value = serde_json::from_slice(&frame)
                .map_err(|error| format!("LSP 响应不是有效 JSON：{error}"));
            if sender.send(value).is_err() {
                break;
            }
        }
    });
    LspResponseReader { receiver }
}

fn drain_stderr(stderr: std::process::ChildStderr) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        let mut bytes = 0usize;
        while bytes < 64 * 1024 {
            line.clear();
            let Ok(read) = reader.read_line(&mut line) else {
                break;
            };
            if read == 0 {
                break;
            }
            bytes = bytes.saturating_add(read);
            // LSP stderr is intentionally drained so a noisy server cannot
            // block the JSON-RPC pipe. Diagnostics stay out of the product
            // event stream because they are not tool results.
        }
    });
}

fn inherited_environment(command: &mut Command) {
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "USER",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "SystemRoot",
    ] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn startup_timeout(config: &LspServerConfig) -> Duration {
    config
        .startup_timeout
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_STARTUP_TIMEOUT)
        .clamp(Duration::from_millis(1), MAX_STARTUP_TIMEOUT)
}

fn workspace_root_for_server(root: &Path, config: &LspServerConfig) -> PathBuf {
    config
        .workspace_folder
        .as_ref()
        .and_then(|path| resolve_workspace_folder(root, path).ok())
        .unwrap_or_else(|| root.to_path_buf())
}

fn send_client_response(stdin: &mut ChildStdin, id: &Value) -> Result<(), String> {
    write_frame(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "Client request is not supported by MelodyWork" },
        }),
    )
}

fn wait_for_response(
    reader: &LspResponseReader,
    stdin: &mut ChildStdin,
    request_id: u64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("LSP 请求超时。".to_string());
        }
        let value = match reader.receiver.recv_timeout(remaining) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => return Err("LSP 请求超时。".to_string()),
            Err(RecvTimeoutError::Disconnected) => return Err("LSP 响应通道已关闭。".to_string()),
        };
        if value.get("method").is_some() {
            if let Some(id) = value.get("id") {
                // Reply to server-side requests so a benign notification or
                // capability probe cannot deadlock the one-shot session.
                send_client_response(stdin, id)?;
            }
            continue;
        }
        if value.get("id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!(
                "LSP server error: {}",
                bounded_text(error.to_string())
            ));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn shutdown_child(
    child: &mut Child,
    stdin: &mut ChildStdin,
    reader: &LspResponseReader,
    next_id: &mut u64,
    shutdown: Duration,
) {
    *next_id = next_id.saturating_add(1);
    let id = *next_id;
    if write_frame(
        stdin,
        &json!({ "jsonrpc": "2.0", "id": id, "method": "shutdown", "params": null }),
    )
    .is_ok()
    {
        let _ = wait_for_response(reader, stdin, id, shutdown);
    }
    let _ = write_frame(
        stdin,
        &json!({ "jsonrpc": "2.0", "method": "exit", "params": null }),
    );
    let _ = child.kill();
    let _ = child.wait();
}

fn run_server(
    root: &Path,
    server: &LoadedServer,
    operation: LspOperation,
    file_path: Option<&Path>,
    line: Option<u64>,
    character: Option<u64>,
    query: Option<&str>,
) -> Result<String, String> {
    let command_root = workspace_root_for_server(root, &server.config);
    let mut command = Command::new(&server.config.command);
    command
        .args(&server.config.args)
        .current_dir(&command_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    inherited_environment(&mut command);
    for (name, value) in &server.config.env {
        command.env(name, value);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 LSP server {}：{error}", server.name))?;
    let mut child = ChildGuard::new(child);
    let mut stdin = child
        .as_mut()
        .stdin
        .take()
        .ok_or_else(|| "LSP server stdin 不可用。".to_string())?;
    let stdout = child
        .as_mut()
        .stdout
        .take()
        .ok_or_else(|| "LSP server stdout 不可用。".to_string())?;
    if let Some(stderr) = child.as_mut().stderr.take() {
        drain_stderr(stderr);
    }
    let reader = spawn_response_reader(stdout);
    let mut next_id = 1u64;
    let workspace_uri = file_uri(&command_root);
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": next_id,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri": workspace_uri,
            "workspaceFolders": [{ "uri": file_uri(&command_root), "name": command_root.file_name().and_then(|value| value.to_str()).unwrap_or("workspace") }],
            "capabilities": {
                "textDocument": {
                    "definition": {}, "references": {}, "hover": {}, "implementation": {}, "documentSymbol": {}
                },
                "workspace": { "symbol": {} }
            },
            "initializationOptions": server.config.initialization_options.clone().unwrap_or(Value::Null)
        }
    });
    write_frame(&mut stdin, &initialize)?;
    wait_for_response(
        &reader,
        &mut stdin,
        next_id,
        startup_timeout(&server.config),
    )?;
    write_frame(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    )?;
    if let Some(settings) = &server.config.settings {
        write_frame(
            &mut stdin,
            &json!({ "jsonrpc": "2.0", "method": "workspace/didChangeConfiguration", "params": { "settings": settings } }),
        )?;
    }

    let mut request_params = Map::new();
    if let Some(path) = file_path {
        let content = fs::read(path).map_err(|error| format!("读取 LSP 文件失败：{error}"))?;
        if content.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("LSP 文件超过 2 MB 限制。".to_string());
        }
        let text =
            String::from_utf8(content).map_err(|_| "LSP 只支持 UTF-8 文本文件。".to_string())?;
        let uri = file_uri(path);
        write_frame(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
                    "textDocument": { "uri": uri, "languageId": language_id(server, path), "version": 1, "text": text }
                }
            }),
        )?;
        request_params.insert("textDocument".to_string(), json!({ "uri": file_uri(path) }));
        if operation.requires_position() {
            request_params.insert(
                "position".to_string(),
                json!({ "line": line.unwrap_or(0), "character": character.unwrap_or(0) }),
            );
        }
        if matches!(operation, LspOperation::References) {
            request_params.insert("context".to_string(), json!({ "includeDeclaration": true }));
        }
    } else if operation.requires_position() {
        return Err("该 LSP 操作需要 file_path、line、character。".to_string());
    }
    if matches!(operation, LspOperation::WorkspaceSymbol) {
        let query = query.ok_or_else(|| "workspaceSymbol 需要 query。".to_string())?;
        if query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control) {
            return Err("query 超过限制或包含控制字符。".to_string());
        }
        request_params.insert("query".to_string(), Value::String(query.to_string()));
    }
    next_id = next_id.saturating_add(1);
    write_frame(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "id": next_id, "method": operation.method(), "params": Value::Object(request_params) }),
    )?;
    let result = wait_for_response(&reader, &mut stdin, next_id, REQUEST_TIMEOUT);
    let output = result.map(|value| match operation {
        LspOperation::Definition => format_locations("Definition", &value),
        LspOperation::References => format_locations("References", &value),
        LspOperation::Implementation => format_locations("Implementations", &value),
        LspOperation::Hover => hover_text(&value),
        LspOperation::DocumentSymbol | LspOperation::WorkspaceSymbol => format_symbols(&value),
    });
    shutdown_child(
        child.as_mut(),
        &mut stdin,
        &reader,
        &mut next_id,
        server
            .config
            .shutdown_timeout
            .map(Duration::from_millis)
            .unwrap_or(SHUTDOWN_TIMEOUT)
            .min(SHUTDOWN_TIMEOUT),
    );
    child.disarm();
    output.map(|value| bounded_text(value))
}

fn parse_u64(object: &Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let value = number
                .as_u64()
                .ok_or_else(|| format!("{key} 必须是非负整数。"))?;
            if value > MAX_POSITION {
                return Err(format!("{key} 超过位置上限 {MAX_POSITION}。"));
            }
            Ok(Some(value))
        }
        Some(_) => Err(format!("{key} 必须是非负整数。")),
    }
}

/// Return the LSP operation represented by a worker tool request.
pub(crate) fn lsp_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = pi_tool_gateway::event_context(value).ok()?;
    (tool_name == LSP_TOOL).then_some("request")
}

/// Resolve a Pi `lsp` tool request through the Host-owned bridge.
pub(crate) fn resolve_request(root: &Path, value: &Value) -> Value {
    let (tool_name, arguments) = match tool_request_arguments(value) {
        Ok((tool_name, arguments)) => (tool_name, arguments),
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.invalid_tool_request", error);
        }
    };
    if tool_name != LSP_TOOL {
        return pi_tool_gateway::fail_for_request(
            value,
            "pi.tool_not_allowed",
            "不是 LSP 工具请求。".to_string(),
        );
    }
    let operation = match arguments
        .get("operation")
        .and_then(Value::as_str)
        .and_then(LspOperation::parse)
    {
        Some(operation) => operation,
        None => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.lsp_tool_failed",
                "operation 必须是受支持的 LSP 操作。".to_string(),
            );
        }
    };
    let root = match canonical_workspace(root) {
        Ok(root) => root,
        Err(error) => return pi_tool_gateway::fail_for_request(value, "pi.lsp_tool_failed", error),
    };
    let path = match arguments.get("file_path").and_then(Value::as_str) {
        Some(path) => match normalize_file_path(&root, path) {
            Ok(path) => Some(path),
            Err(error) => {
                return pi_tool_gateway::fail_for_request(value, "pi.lsp_tool_failed", error);
            }
        },
        None if operation.requires_position() => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.lsp_tool_failed",
                "该 LSP 操作需要 file_path。".to_string(),
            );
        }
        None => None,
    };
    let line = match parse_u64(arguments, "line") {
        Ok(value) => value,
        Err(error) => return pi_tool_gateway::fail_for_request(value, "pi.lsp_tool_failed", error),
    };
    let character = match parse_u64(arguments, "character") {
        Ok(value) => value,
        Err(error) => return pi_tool_gateway::fail_for_request(value, "pi.lsp_tool_failed", error),
    };
    if operation.requires_position() && (line.is_none() || character.is_none()) {
        return pi_tool_gateway::fail_for_request(
            value,
            "pi.lsp_tool_failed",
            "位置操作需要 line 和 character。".to_string(),
        );
    }
    let query = match arguments.get("query") {
        None | Some(Value::Null) => None,
        Some(Value::String(query)) => Some(query.as_str()),
        Some(_) => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.lsp_tool_failed",
                "query 必须是字符串。".to_string(),
            );
        }
    };
    let servers = match load_servers(&root) {
        Ok(servers) => servers,
        Err(error) => return pi_tool_gateway::fail_for_request(value, "pi.lsp_tool_failed", error),
    };
    let selected = match choose_server(&servers, operation, path.as_deref()) {
        Ok(selected) => selected,
        Err(error) => return pi_tool_gateway::fail_for_request(value, "pi.lsp_tool_failed", error),
    };
    let mut outputs = Vec::new();
    let mut last_error = None;
    for server in selected {
        match run_server(
            &root,
            server,
            operation,
            path.as_deref(),
            line,
            character,
            query,
        ) {
            Ok(output) => outputs.push(output),
            Err(error) => last_error = Some(error),
        }
    }
    let output = if outputs.is_empty() {
        return pi_tool_gateway::fail_for_request(
            value,
            "pi.lsp_tool_failed",
            last_error.unwrap_or_else(|| "LSP 没有返回结果。".to_string()),
        );
    } else if matches!(operation, LspOperation::WorkspaceSymbol) {
        outputs.join("\n")
    } else {
        outputs.remove(0)
    };
    success_for_request(value, bounded_text(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_operations_and_aliases() {
        assert_eq!(
            LspOperation::parse("goToDefinition"),
            Some(LspOperation::Definition)
        );
        assert_eq!(
            LspOperation::parse("workspaceSymbol"),
            Some(LspOperation::WorkspaceSymbol)
        );
        assert_eq!(LspOperation::parse("unknown"), None);
    }

    #[test]
    fn rejects_untrusted_project_server_and_invalid_transport() {
        let root = env::temp_dir().join(format!("melody-lsp-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let config = LspServerConfig {
            command: "rust-analyzer".into(),
            transport: Some("socket".into()),
            ..Default::default()
        };
        let fields = validate_server("rust", "project", &root, &config);
        assert!(fields.contains(&"transport".to_string()));
        assert!(fields.contains(&"projectTrustRequired".to_string()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabled_server_is_kept_in_inventory_but_not_selected() {
        let root = env::temp_dir().join(format!("melody-lsp-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let server = LoadedServer {
            name: "disabled".to_string(),
            scope: "user",
            source_path: root.join("lsp.json"),
            config: LspServerConfig {
                enabled: false,
                command: "rust-analyzer".to_string(),
                ..Default::default()
            },
            unsupported_fields: Vec::new(),
        };
        let error = choose_server(&[server], LspOperation::WorkspaceSymbol, None).unwrap_err();
        assert!(error.contains("没有可安全启动"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_relative_workspace_folder_under_workspace_root() {
        let root = env::temp_dir().join(format!("melody-lsp-test-{}", uuid::Uuid::new_v4()));
        let nested = root.join("packages");
        fs::create_dir_all(&nested).unwrap();
        let resolved = resolve_workspace_folder(&root, "packages").unwrap();
        assert_eq!(resolved, nested.canonicalize().unwrap());
        assert!(resolve_workspace_folder(&root, "../").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unbounded_positions() {
        let mut arguments = Map::new();
        arguments.insert("line".to_string(), json!(MAX_POSITION + 1));
        let error = parse_u64(&arguments, "line").unwrap_err();
        assert!(error.contains("位置上限"));
    }

    #[test]
    fn formats_locations_and_decodes_file_uris() {
        let value = json!([
            { "uri": "file:///tmp/a%20b.ts", "range": { "start": { "line": 1, "character": 2 } } }
        ]);
        assert_eq!(
            format_locations("Definition", &value),
            "Definition (1 location):\n  /tmp/a b.ts:2:3"
        );
    }

    #[test]
    fn bounds_large_output_without_splitting_utf8() {
        let output = bounded_text("字".repeat(MAX_OUTPUT_BYTES));
        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert!(output.ends_with("[output truncated]"));
    }
}
