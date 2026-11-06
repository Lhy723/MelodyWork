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
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Map, Value, json};

#[path = "pi_lsp_config.rs"]
mod lsp_config;
#[path = "pi_lsp_projection.rs"]
mod projection;

use self::lsp_config::{
    LoadedServer, LspServerConfig, canonical_workspace, file_uri, language_id, load_servers,
    normalize_file_path, workspace_root_for_server,
};
use self::projection::{bounded_text, format_locations, format_symbols, hover_text};

use crate::pi_tool_gateway::{self, success_for_request, tool_request_arguments};

pub(crate) const LSP_TOOL: &str = "lsp";

const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 2048;
const MAX_POSITION: u64 = 100_000;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

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
