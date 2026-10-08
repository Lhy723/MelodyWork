//! Host-owned MCP bridge for the opt-in Pi worker.
//!
//! Pi intentionally does not receive an MCP client or a raw process API.  The
//! Host reads the trusted Melody configuration, starts only local stdio
//! servers or sends requests through a bounded HTTP/SSE client, speaks
//! JSON-RPC, and exposes the result through the normal Pi ToolGateway.  Pi
//! never receives raw process or network capabilities.

use std::{
    collections::{BTreeMap, HashMap},
    env,
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use reqwest::{Client, Method, Url, header};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, oneshot, watch},
    time::timeout,
};

use crate::config_runtime::read_melody_config_inner;
use crate::pi_tool_gateway::{MCP_ARCHIVE_FILE_PREFIX, archive_tool_output};

const MAX_SERVER_NAME_BYTES: usize = 128;
const MAX_COMMAND_BYTES: usize = 512;
const MAX_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_ENV_ENTRIES: usize = 64;
const MAX_ENV_KEY_BYTES: usize = 128;
const MAX_ENV_VALUE_BYTES: usize = 16 * 1024;
const MAX_REMOTE_URL_BYTES: usize = 4096;
const MAX_REMOTE_HEADERS: usize = 64;
const MAX_REMOTE_HEADER_NAME_BYTES: usize = 256;
const MAX_REMOTE_HEADER_VALUE_BYTES: usize = 16 * 1024;
const MAX_REMOTE_HEADER_ENV_NAME_BYTES: usize = 128;
const MAX_SERVERS: usize = 64;
const MAX_TOOLS: usize = 256;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 4 * 1024;
const MAX_TOOL_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_RESULT_BYTES: usize = 512 * 1024;
const MAX_REMOTE_BODY_BYTES: usize = 1024 * 1024;
const MAX_LIST_PAGES: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

/// Keep MCP processes from inheriting ambient credentials and package-manager
/// flags from the Tauri process. Explicit values in the trusted config are
/// added after this small, non-secret baseline.
const INHERITED_MCP_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

const MCP_ROOT_KEYS: &[&str] = &["mcp_servers", "mcpServers", "mcp", "mcps"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatus {
    pub(crate) name: String,
    pub(crate) transport: String,
    pub(crate) supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct McpServerSpec {
    name: String,
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum McpTransport {
    Http,
    Sse,
}

impl McpTransport {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Sse => "sse",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct McpRemoteSpec {
    name: String,
    transport: McpTransport,
    url: String,
    headers: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
struct McpServerEntry {
    status: McpServerStatus,
    spec: Option<McpServerSpec>,
    remote: Option<McpRemoteSpec>,
}

#[derive(Clone, Debug, Serialize)]
struct McpToolSummary {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
    input_schema: Option<Value>,
}

struct McpConnection {
    spec: McpServerSpec,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    write_lock: Mutex<()>,
    next_id: AtomicU64,
    tools: Mutex<Option<Vec<McpToolSummary>>>,
}

struct RemoteResponse {
    status: u16,
    content_type: Option<String>,
    session_id: Option<String>,
    body: Vec<u8>,
}

struct RemoteMcpConnection {
    root: PathBuf,
    spec: McpRemoteSpec,
    client: Client,
    endpoint: Mutex<Url>,
    session_id: Mutex<Option<String>>,
    request_lock: Mutex<()>,
    next_id: AtomicU64,
    tools: Mutex<Option<Vec<McpToolSummary>>>,
    stop_signal: watch::Sender<bool>,
}

struct ActiveMcpCall {
    session_id: String,
    root: PathBuf,
    run_id: Option<String>,
    cancel: oneshot::Sender<()>,
}

#[derive(Clone, Default)]
pub(crate) struct PiMcpRuntime {
    inner: Arc<PiMcpRuntimeInner>,
}

struct PiMcpRuntimeInner {
    lifecycle: Mutex<()>,
    connections: Mutex<HashMap<String, Arc<McpConnection>>>,
    remote_connections: Mutex<HashMap<String, Arc<RemoteMcpConnection>>>,
    active_calls: Mutex<HashMap<String, ActiveMcpCall>>,
}

impl Default for PiMcpRuntimeInner {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(()),
            connections: Mutex::new(HashMap::new()),
            remote_connections: Mutex::new(HashMap::new()),
            active_calls: Mutex::new(HashMap::new()),
        }
    }
}

fn bounded_text(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n[output truncated]");
    text
}

fn bounded_json(value: &Value, limit: usize) -> Result<String, String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    Ok(bounded_text(text, limit))
}

fn object_has_descriptor_fields(object: &Map<String, Value>) -> bool {
    [
        "name",
        "command",
        "args",
        "env",
        "cwd",
        "transport",
        "type",
        "url",
        "uri",
        "server_url",
        "serverUrl",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
}

fn collect_server_values(
    value: &Value,
    name_hint: Option<&str>,
    output: &mut Vec<(String, Map<String, Value>)>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_server_values(item, name_hint, output);
                if output.len() >= MAX_SERVERS {
                    return;
                }
            }
        }
        Value::Object(object) if object_has_descriptor_fields(object) => {
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .or(name_hint)
                .unwrap_or("unnamed")
                .to_string();
            output.push((name, object.clone()));
        }
        Value::Object(object) => {
            for (key, nested) in object {
                if matches!(key.as_str(), "servers" | "mcp_servers" | "mcpServers") {
                    collect_server_values(nested, name_hint, output);
                } else if nested.is_object() || nested.is_array() {
                    collect_server_values(nested, Some(key), output);
                }
                if output.len() >= MAX_SERVERS {
                    return;
                }
            }
        }
        _ => {}
    }
}

fn unsupported_entry(name: String, transport: String, reason: impl Into<String>) -> McpServerEntry {
    McpServerEntry {
        status: McpServerStatus {
            name,
            transport,
            supported: false,
            reason: Some(reason.into()),
        },
        spec: None,
        remote: None,
    }
}

fn normalize_remote_transport(value: &str) -> Option<McpTransport> {
    match value.trim().to_ascii_lowercase().as_str() {
        "http" | "streamable-http" | "streamable_http" | "streamablehttp" => {
            Some(McpTransport::Http)
        }
        "sse" | "server-sent-events" | "server_sent_events" => Some(McpTransport::Sse),
        _ => None,
    }
}

fn valid_environment_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Resolve explicit `${ENV_VAR}` references in a remote MCP header without
/// exposing the resolved value to the config snapshot or diagnostics. Plain
/// values remain supported for backwards compatibility; references are useful
/// for bearer tokens because only the Host process reads the environment.
fn resolve_remote_header_value(
    server_name: &str,
    header_name: &str,
    value: &str,
) -> Result<String, String> {
    if !value.contains("${") {
        return Ok(value.to_string());
    }
    let mut resolved = String::with_capacity(value.len());
    let mut remainder = value;
    while let Some(start) = remainder.find("${") {
        resolved.push_str(&remainder[..start]);
        let placeholder = &remainder[start + 2..];
        let Some(end) = placeholder.find('}') else {
            return Err(format!(
                "MCP remote server {server_name} header {header_name} contains an unterminated environment reference"
            ));
        };
        let name = &placeholder[..end];
        if name.is_empty()
            || name.len() > MAX_REMOTE_HEADER_ENV_NAME_BYTES
            || !valid_environment_name(name)
        {
            return Err(format!(
                "MCP remote server {server_name} header {header_name} contains an invalid environment reference"
            ));
        }
        let secret = env::var(name).map_err(|_| {
            format!(
                "MCP remote server {server_name} header {header_name} references unset environment variable {name}"
            )
        })?;
        resolved.push_str(&secret);
        if resolved.len() > MAX_REMOTE_HEADER_VALUE_BYTES {
            return Err(format!(
                "MCP remote server {server_name} header exceeds the configured limit"
            ));
        }
        remainder = &placeholder[end + 1..];
    }
    resolved.push_str(remainder);
    if resolved.len() > MAX_REMOTE_HEADER_VALUE_BYTES {
        return Err(format!(
            "MCP remote server {server_name} header exceeds the configured limit"
        ));
    }
    Ok(resolved)
}

fn parse_remote_headers(
    object: &Map<String, Value>,
    server_name: &str,
) -> Result<Vec<(String, String)>, String> {
    let Some(value) = object.get("headers") else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_object() else {
        return Err(format!(
            "MCP remote server {server_name} headers must be an object"
        ));
    };
    if values.len() > MAX_REMOTE_HEADERS {
        return Err(format!(
            "MCP remote server {server_name} has too many headers (limit {MAX_REMOTE_HEADERS})"
        ));
    }
    let mut headers = Vec::with_capacity(values.len());
    for (name, value) in values {
        let Some(value) = value.as_str() else {
            return Err(format!(
                "MCP remote server {server_name} header values must be strings"
            ));
        };
        if name.is_empty() || name.len() > MAX_REMOTE_HEADER_NAME_BYTES {
            return Err(format!(
                "MCP remote server {server_name} header exceeds the configured limit"
            ));
        }
        let lower_name = name.to_ascii_lowercase();
        if matches!(
            lower_name.as_str(),
            "accept"
                | "content-type"
                | "content-length"
                | "connection"
                | "host"
                | "mcp-session-id"
                | "transfer-encoding"
        ) {
            return Err(format!(
                "MCP remote server {server_name} header {name} is reserved by the Host bridge"
            ));
        }
        header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            format!("MCP remote server {server_name} contains an invalid header name")
        })?;
        let value = resolve_remote_header_value(server_name, name, value)?;
        header::HeaderValue::from_str(&value).map_err(|_| {
            format!("MCP remote server {server_name} contains an invalid header value")
        })?;
        headers.push((name.clone(), value));
    }
    Ok(headers)
}

fn parse_server_entry(name: String, object: &Map<String, Value>, root: &Path) -> McpServerEntry {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > MAX_SERVER_NAME_BYTES {
        return unsupported_entry(
            if name.is_empty() { "unnamed" } else { &name }.to_string(),
            "unknown".to_string(),
            "MCP server name is empty or exceeds the 128 byte limit",
        );
    }

    let declared_transport = match object.get("transport").or_else(|| object.get("type")) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.trim().to_ascii_lowercase(),
        Some(_) => {
            return unsupported_entry(
                name,
                "unknown".to_string(),
                "MCP transport must be a string",
            );
        }
    };
    let remote_url_keys = ["url", "uri", "server_url", "serverUrl"];
    let has_remote_url_field = remote_url_keys
        .iter()
        .any(|key| object.get(*key).is_some_and(|value| !value.is_null()));
    let remote_url = remote_url_keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .filter(|url| !url.trim().is_empty())
    });
    let transport = if remote_url.is_some() {
        if declared_transport.is_empty() {
            "http".to_string()
        } else {
            declared_transport.clone()
        }
    } else if declared_transport.is_empty() {
        "stdio".to_string()
    } else {
        declared_transport.clone()
    };
    if has_remote_url_field {
        let Some(remote_url) = remote_url else {
            return unsupported_entry(name, transport, "MCP remote URL must be a non-empty string");
        };
        if object
            .get("command")
            .is_some_and(|command| !command.is_null())
        {
            return unsupported_entry(
                name,
                transport,
                "MCP remote server cannot define both a URL and a local stdio command",
            );
        }
        let Some(remote_transport) = normalize_remote_transport(&transport) else {
            return unsupported_entry(
                name,
                transport,
                "MCP remote transport must be HTTP, streamable HTTP, or SSE",
            );
        };
        if remote_url.len() > MAX_REMOTE_URL_BYTES {
            return unsupported_entry(
                name,
                remote_transport.as_str().to_string(),
                "MCP remote URL exceeds the 4 KB limit",
            );
        }
        let parsed_url = match Url::parse(remote_url.trim()) {
            Ok(url)
                if matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.fragment().is_none() =>
            {
                url
            }
            _ => {
                return unsupported_entry(
                    name,
                    remote_transport.as_str().to_string(),
                    "MCP remote URL must be an HTTP(S) URL without credentials or fragments",
                );
            }
        };
        let headers = match parse_remote_headers(object, &name) {
            Ok(headers) => headers,
            Err(reason) => {
                return unsupported_entry(name, remote_transport.as_str().to_string(), reason);
            }
        };
        return McpServerEntry {
            status: McpServerStatus {
                name: name.clone(),
                transport: remote_transport.as_str().to_string(),
                supported: true,
                reason: None,
            },
            spec: None,
            remote: Some(McpRemoteSpec {
                name,
                transport: remote_transport,
                url: parsed_url.to_string(),
                headers,
            }),
        };
    }
    if !declared_transport.is_empty() && !matches!(declared_transport.as_str(), "stdio" | "local") {
        return unsupported_entry(
            name,
            transport,
            "MCP server must use a local stdio transport or provide an HTTP/SSE URL",
        );
    }

    let command = match object.get("command").and_then(Value::as_str) {
        Some(command) if !command.trim().is_empty() && command.len() <= MAX_COMMAND_BYTES => {
            command.trim().to_string()
        }
        Some(_) => {
            return unsupported_entry(
                name,
                transport,
                "MCP stdio command is empty or exceeds the 512 byte limit",
            );
        }
        None => {
            return unsupported_entry(
                name,
                transport,
                "MCP server must provide a local stdio command",
            );
        }
    };

    let args = match object.get("args") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut args = Vec::with_capacity(items.len());
            for item in items {
                let Some(argument) = item.as_str() else {
                    return unsupported_entry(name, transport, "MCP stdio args must be strings");
                };
                if argument.len() > MAX_ARGUMENT_BYTES {
                    return unsupported_entry(
                        name,
                        transport,
                        "MCP stdio argument exceeds the 16 KB limit",
                    );
                }
                args.push(argument.to_string());
            }
            args
        }
        Some(_) => {
            return unsupported_entry(name, transport, "MCP stdio args must be an array");
        }
    };

    let env = match object.get("env") {
        None => Vec::new(),
        Some(Value::Object(values)) if values.len() <= MAX_ENV_ENTRIES => {
            let mut env = Vec::with_capacity(values.len());
            for (key, value) in values {
                let Some(value) = value.as_str() else {
                    return unsupported_entry(
                        name,
                        transport,
                        "MCP stdio environment values must be strings",
                    );
                };
                if key.is_empty()
                    || key.len() > MAX_ENV_KEY_BYTES
                    || value.len() > MAX_ENV_VALUE_BYTES
                {
                    return unsupported_entry(
                        name,
                        transport,
                        "MCP stdio environment entry exceeds the configured limit",
                    );
                }
                env.push((key.clone(), value.to_string()));
            }
            env
        }
        Some(Value::Object(_)) => {
            return unsupported_entry(
                name,
                transport,
                "MCP stdio environment has too many entries",
            );
        }
        Some(_) => {
            return unsupported_entry(name, transport, "MCP stdio env must be an object");
        }
    };

    let cwd = match object.get("cwd").and_then(Value::as_str) {
        None => root.to_path_buf(),
        Some(value) => {
            let path = Path::new(value);
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return unsupported_entry(
                    name,
                    transport,
                    "MCP stdio cwd must stay inside the authorized workspace",
                );
            }
            root.join(path)
        }
    };

    McpServerEntry {
        status: McpServerStatus {
            name: name.clone(),
            transport,
            supported: true,
            reason: None,
        },
        spec: Some(McpServerSpec {
            name,
            command,
            args,
            env,
            cwd,
        }),
        remote: None,
    }
}

fn load_mcp_entries(root: &Path) -> Result<BTreeMap<String, McpServerEntry>, String> {
    let cwd = root.to_string_lossy().into_owned();
    let mut merged = BTreeMap::new();
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.clone())?;
        if let Some(error) = document.parse_error {
            return Err(format!("Failed to parse {scope} Melody config: {error}"));
        }
        for key in MCP_ROOT_KEYS {
            let Some(value) = document.values.get(key) else {
                continue;
            };
            let mut values = Vec::new();
            collect_server_values(value, None, &mut values);
            for (name, object) in values {
                let entry = parse_server_entry(name, &object, root);
                merged.insert(entry.status.name.clone(), entry);
            }
        }
    }
    Ok(merged)
}

/// Inspect the trusted MCP config without starting any process. This is also
/// useful to the Host's capability preflight and keeps unsupported transports
/// visible instead of silently dropping them.
#[allow(dead_code)]
pub(crate) fn inspect_mcp_config(root: &Path) -> Result<Vec<McpServerStatus>, String> {
    Ok(load_mcp_entries(root)?
        .into_values()
        .map(|entry| entry.status)
        .collect())
}

fn apply_safe_environment(command: &mut Command, explicit: &[(String, String)]) {
    command.env_clear();
    for key in INHERITED_MCP_ENV {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, value) in explicit {
        command.env(key, value);
    }
}

impl McpConnection {
    fn start(spec: McpServerSpec) -> Result<Arc<Self>, String> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        apply_safe_environment(&mut command, &spec.env);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start MCP server {}: {error}", spec.name))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP server {} did not expose stdin", spec.name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP server {} did not expose stdout", spec.name))?;
        let stderr = child.stderr.take();
        let connection = Arc::new(Self {
            spec,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            write_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            tools: Mutex::new(None),
        });
        let reader_connection = Arc::downgrade(&connection);
        tokio::spawn(async move {
            read_stdout(reader_connection, stdout).await;
        });
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                drain_stderr(stderr).await;
            });
        }
        Ok(connection)
    }

    async fn reject_pending(&self, message: String) {
        let mut pending = self.pending.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(message.clone()));
        }
    }

    /// Check the child before reusing a cached connection.  A server can exit
    /// while idle (for example after an auth failure or a one-shot command),
    /// so a populated tool cache must not make the next request look healthy.
    async fn is_running(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => false,
            Ok(None) => true,
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        request_timeout: Duration,
        cancellation: Option<oneshot::Receiver<()>>,
    ) -> Result<Value, String> {
        let _write_guard = self.write_lock.lock().await;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut frame = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| format!("Failed to encode MCP request: {error}"))?;
        if frame.len() + 1 > MAX_FRAME_BYTES {
            return Err("MCP request exceeds the 1 MB frame limit".to_string());
        }
        frame.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let write_result = {
            let mut stdin = self.stdin.lock().await;
            if let Err(error) = stdin.write_all(&frame).await {
                Err(error)
            } else {
                stdin.flush().await
            }
        };
        if let Err(error) = write_result {
            self.pending.lock().await.remove(&id);
            return Err(format!("Failed to write MCP request: {error}"));
        }
        let response = if let Some(mut cancellation) = cancellation {
            tokio::select! {
                response = receiver => response
                    .map_err(|_| "MCP response channel closed".to_string())
                    .and_then(|result| result),
                _ = &mut cancellation => Err(format!("MCP request {method} cancelled")),
                _ = tokio::time::sleep(request_timeout) => Err(format!("MCP request {method} timed out")),
            }
        } else {
            match timeout(request_timeout, receiver).await {
                Ok(Ok(response)) => response,
                Ok(Err(_)) => Err("MCP response channel closed".to_string()),
                Err(_) => Err(format!("MCP request {method} timed out")),
            }
        };
        self.pending.lock().await.remove(&id);
        let response = response?;
        if let Some(error) = response.get("error") {
            return Err(format!(
                "MCP {method} failed: {}",
                bounded_json(error, 8 * 1024)?
            ));
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| format!("MCP {method} response did not contain a result"))
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let _write_guard = self.write_lock.lock().await;
        let mut frame = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .map_err(|error| format!("Failed to encode MCP notification: {error}"))?;
        if frame.len() + 1 > MAX_FRAME_BYTES {
            return Err("MCP notification exceeds the 1 MB frame limit".to_string());
        }
        frame.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        if let Err(error) = stdin.write_all(&frame).await {
            return Err(format!("Failed to write MCP notification: {error}"));
        }
        stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to write MCP notification: {error}"))
    }

    async fn initialize(&self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "melody-work", "version": env!("CARGO_PKG_VERSION") },
            }),
            INITIALIZE_TIMEOUT,
            None,
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await
    }

    async fn list_tools(&self) -> Result<Vec<McpToolSummary>, String> {
        if let Some(tools) = self.tools.lock().await.clone() {
            return Ok(tools);
        }
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let result = self
                .request("tools/list", params, REQUEST_TIMEOUT, None)
                .await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| "MCP tools/list response did not contain tools[]".to_string())?;
            for item in page {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let Some(name) = object.get("name").and_then(Value::as_str) else {
                    continue;
                };
                if name.is_empty() || name.len() > MAX_TOOL_NAME_BYTES {
                    continue;
                }
                let description = object
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|value| bounded_text(value.to_string(), MAX_DESCRIPTION_BYTES));
                let input_schema = object
                    .get("inputSchema")
                    .filter(|value| value.is_object())
                    .and_then(|value| {
                        serde_json::to_vec(value)
                            .ok()
                            .filter(|bytes| bytes.len() <= MAX_TOOL_SCHEMA_BYTES)
                            .map(|_| value.clone())
                    });
                tools.push(McpToolSummary {
                    name: name.to_string(),
                    description,
                    input_schema,
                });
                if tools.len() >= MAX_TOOLS {
                    break;
                }
            }
            if tools.len() >= MAX_TOOLS {
                break;
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        *self.tools.lock().await = Some(tools.clone());
        Ok(tools)
    }

    async fn call_tool(
        &self,
        tool: &str,
        arguments: &Value,
        cancellation: Option<oneshot::Receiver<()>>,
    ) -> Result<String, String> {
        if !arguments.is_object() {
            return Err("mcp_call_tool arguments must be an object".to_string());
        }
        // Discovery is deliberately completed before the cancellable call.
        // When the cache is cold this may take one bounded request, but it
        // avoids consuming the one-shot cancellation signal before the actual
        // side-effecting `tools/call` request has been sent.
        let tools = self.list_tools().await?;
        if !tools.iter().any(|item| item.name == tool) {
            return Err(format!(
                "MCP tool {tool} is not advertised by {}",
                self.spec.name
            ));
        }
        let result = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
                REQUEST_TIMEOUT,
                cancellation,
            )
            .await?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            let text = mcp_result_text(&result)?;
            return Err(if text.is_empty() {
                format!("MCP tool {tool} returned an error")
            } else {
                text
            });
        }
        mcp_result_text(&result)
    }

    async fn stop(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
        self.reject_pending("MCP server stopped".to_string()).await;
    }
}

fn remote_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("melody-work/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Failed to create MCP remote client: {error}"))
}

async fn execute_remote_request(
    client: &Client,
    request: reqwest::Request,
    expected_id: Option<u64>,
    method: &str,
) -> Result<RemoteResponse, String> {
    let response = client
        .execute(request)
        .await
        .map_err(|error| format!("MCP remote request failed: {error}"))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .filter(|value| !value.is_empty());
    let mut response = response;
    // Authentication failures are classified from the status alone. Do not
    // drain a potentially unbounded HTML/login body (or wait for a server
    // that leaves it open); the parser deliberately never exposes that body.
    if matches!(status, 401 | 403) {
        return Ok(RemoteResponse {
            status,
            content_type,
            session_id,
            body: Vec::new(),
        });
    }
    let mut body = Vec::new();
    let is_sse = content_type
        .as_deref()
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read MCP remote response: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_REMOTE_BODY_BYTES {
            return Err("MCP remote response exceeds the 1 MB limit".to_string());
        }
        body.extend_from_slice(&chunk);
        // A streamable HTTP server is allowed to keep an SSE response open
        // for notifications after it has delivered the JSON-RPC result.  Do
        // not wait for EOF in that case: return as soon as the requested id
        // is complete and let reqwest drop the response body.
        if is_sse
            && (200..300).contains(&status)
            && expected_id.is_some_and(|id| parse_sse_rpc_response(&body, id, method).is_ok())
        {
            break;
        }
    }
    Ok(RemoteResponse {
        status,
        content_type,
        session_id,
        body,
    })
}

async fn run_remote_operation<T, F>(
    operation: F,
    request_timeout: Duration,
    cancellation: Option<oneshot::Receiver<()>>,
    method: &str,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let operation = Box::pin(operation);
    if let Some(mut cancellation) = cancellation {
        tokio::select! {
            result = timeout(request_timeout, operation) => match result {
                Ok(result) => result,
                Err(_) => Err(format!("MCP remote request {method} timed out")),
            },
            _ = &mut cancellation => Err(format!("MCP remote request {method} cancelled")),
        }
    } else {
        match timeout(request_timeout, operation).await {
            Ok(result) => result,
            Err(_) => Err(format!("MCP remote request {method} timed out")),
        }
    }
}

fn remote_http_error_code(status: u16) -> &'static str {
    match status {
        401 => "mcp.auth_required",
        403 => "mcp.access_denied",
        300..=399 => "mcp.redirect_blocked",
        404 => "mcp.endpoint_not_found",
        429 => "mcp.rate_limited",
        _ => "mcp.remote_http_error",
    }
}

/// Format an HTTP failure without echoing an authentication response body.
/// Remote servers often return HTML or a bearer-token challenge on 401/403;
/// neither is useful in the timeline and either can disclose sensitive
/// provider details. Other statuses retain a small bounded body for diagnosis.
fn remote_http_error(method: &str, status: u16, body: &[u8]) -> String {
    let code = remote_http_error_code(status);
    if matches!(status, 401 | 403) {
        return format!("MCP remote {method} failed [{code}] (HTTP {status})");
    }
    let body = bounded_text(String::from_utf8_lossy(body).into_owned(), 8 * 1024);
    if body.trim().is_empty() {
        format!("MCP remote {method} failed [{code}] (HTTP {status})")
    } else {
        format!("MCP remote {method} failed [{code}] (HTTP {status}): {body}")
    }
}

fn remote_error_code(message: &str) -> Option<&'static str> {
    [
        "mcp.auth_required",
        "mcp.access_denied",
        "mcp.redirect_blocked",
        "mcp.endpoint_not_found",
        "mcp.rate_limited",
        "mcp.remote_http_error",
    ]
    .into_iter()
    .find(|code| message.contains(code))
}

fn sse_events(text: &str) -> Vec<(String, String)> {
    let mut events = Vec::new();
    let normalized = text.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }
        let mut event = String::new();
        let mut data = Vec::new();
        for line in block.lines() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }
        if !data.is_empty() {
            events.push((event, data.join("\n")));
        }
    }
    events
}

fn parse_sse_rpc_response(body: &[u8], expected_id: u64, method: &str) -> Result<Value, String> {
    let text = String::from_utf8_lossy(body);
    for (_, data) in sse_events(&text) {
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) == Some(expected_id) {
            return Ok(value);
        }
    }
    Err(format!(
        "MCP remote {method} SSE response did not contain id {expected_id}"
    ))
}

/// Resolve an endpoint advertised by the legacy SSE bootstrap without
/// allowing the server to redirect Host-owned credentials to another origin.
/// Relative paths and absolute URLs on the configured origin are valid; a
/// scheme/host/port change is rejected before any JSON-RPC request is sent.
fn resolve_sse_endpoint(base: &Url, advertised: &str) -> Result<Url, String> {
    let endpoint = base
        .join(advertised.trim())
        .map_err(|error| format!("MCP SSE endpoint URL is invalid: {error}"))?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(
            "MCP SSE endpoint must be an HTTP(S) URL without credentials or fragments".to_string(),
        );
    }
    if endpoint.scheme() != base.scheme()
        || endpoint.host_str() != base.host_str()
        || endpoint.port_or_known_default() != base.port_or_known_default()
    {
        return Err("MCP SSE endpoint must stay on the configured server origin".to_string());
    }
    Ok(endpoint)
}

fn parse_remote_rpc_response(
    response: &RemoteResponse,
    expected_id: u64,
    method: &str,
) -> Result<Value, String> {
    if !(200..300).contains(&response.status) {
        return Err(remote_http_error(method, response.status, &response.body));
    }
    let is_sse = response
        .content_type
        .as_deref()
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    let value = match serde_json::from_slice::<Value>(&response.body) {
        Ok(value) => value,
        Err(error) if is_sse || response.body.windows(5).any(|window| window == b"data:") => {
            parse_sse_rpc_response(&response.body, expected_id, method).map_err(|sse_error| {
                format!("MCP remote {method} returned invalid JSON/SSE: {error}; {sse_error}")
            })?
        }
        Err(error) => {
            return Err(format!(
                "MCP remote {method} returned invalid JSON: {error}"
            ));
        }
    };
    if value.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Err(format!(
            "MCP remote {method} response id did not match request id {expected_id}"
        ));
    }
    if let Some(error) = value.get("error") {
        return Err(format!(
            "MCP remote {method} failed: {}",
            bounded_json(error, 8 * 1024)?
        ));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| format!("MCP remote {method} response did not contain a result"))
}

impl RemoteMcpConnection {
    fn start(root: PathBuf, spec: McpRemoteSpec) -> Result<Arc<Self>, String> {
        let client = remote_client()?;
        let endpoint =
            Url::parse(&spec.url).map_err(|error| format!("MCP remote URL is invalid: {error}"))?;
        Ok(Arc::new(Self {
            root,
            spec,
            client,
            endpoint: Mutex::new(endpoint),
            session_id: Mutex::new(None),
            request_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            tools: Mutex::new(None),
            stop_signal: watch::channel(false).0,
        }))
    }

    async fn run_with_stop<T, F>(
        &self,
        operation: F,
        request_timeout: Duration,
        cancellation: Option<oneshot::Receiver<()>>,
        method: &str,
    ) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        if *self.stop_signal.borrow() {
            return Err(format!(
                "MCP remote request {method} cancelled: connection stopped"
            ));
        }
        let mut stop_signal = self.stop_signal.subscribe();
        let operation = run_remote_operation(operation, request_timeout, cancellation, method);
        tokio::select! {
            result = operation => result,
            changed = stop_signal.changed() => {
                if changed.is_ok() && *stop_signal.borrow() {
                    Err(format!("MCP remote request {method} cancelled: connection stopped"))
                } else {
                    Err(format!("MCP remote request {method} cancelled: connection unavailable"))
                }
            }
        }
    }

    fn apply_headers(
        &self,
        mut request: reqwest::RequestBuilder,
        accept: &'static str,
    ) -> reqwest::RequestBuilder {
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, accept);
        for (name, value) in &self.spec.headers {
            request = request.header(name, value);
        }
        request
    }

    async fn send_locked(
        &self,
        method: &str,
        params: Value,
        request_id: Option<u64>,
        request_timeout: Duration,
        cancellation: Option<oneshot::Receiver<()>>,
    ) -> Result<RemoteResponse, String> {
        let endpoint = self.endpoint.lock().await.clone();
        let session_id = self.session_id.lock().await.clone();
        let mut payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        if let Some(request_id) = request_id {
            payload["id"] = Value::Number(request_id.into());
        }
        let mut builder = self
            .apply_headers(
                self.client.request(Method::POST, endpoint),
                "application/json, text/event-stream",
            )
            .json(&payload);
        if let Some(session_id) = session_id {
            builder = builder.header("mcp-session-id", session_id);
        }
        let request = builder
            .build()
            .map_err(|error| format!("Failed to build MCP remote request: {error}"))?;
        let response = self
            .run_with_stop(
                execute_remote_request(&self.client, request, request_id, method),
                request_timeout,
                cancellation,
                method,
            )
            .await?;
        if *self.stop_signal.borrow() {
            return Err(format!(
                "MCP remote request {method} cancelled: connection stopped"
            ));
        }
        if let Some(session_id) = response.session_id.clone() {
            *self.session_id.lock().await = Some(session_id);
        }
        Ok(response)
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        request_timeout: Duration,
        cancellation: Option<oneshot::Receiver<()>>,
    ) -> Result<Value, String> {
        let _request_guard = self.request_lock.lock().await;
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let response = self
            .send_locked(
                method,
                params,
                Some(request_id),
                request_timeout,
                cancellation,
            )
            .await?;
        parse_remote_rpc_response(&response, request_id, method)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let _request_guard = self.request_lock.lock().await;
        let response = self
            .send_locked(method, params, None, REQUEST_TIMEOUT, None)
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(remote_http_error(method, response.status, &response.body));
        }
        Ok(())
    }

    async fn bootstrap_sse(&self) -> Result<(), String> {
        let endpoint = self.endpoint.lock().await.clone();
        let request = self
            .apply_headers(
                self.client.request(Method::GET, endpoint.clone()),
                "text/event-stream",
            )
            .build()
            .map_err(|error| format!("Failed to build MCP SSE request: {error}"))?;
        let future = async {
            let response = self
                .client
                .execute(request)
                .await
                .map_err(|error| format!("MCP SSE connection failed: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(remote_http_error("SSE bootstrap", status.as_u16(), &[]));
            }
            let session_id = response
                .headers()
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            let mut response = response;
            let mut buffer = String::new();
            loop {
                let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|error| format!("Failed to read MCP SSE endpoint: {error}"))?
                else {
                    return Err(
                        "MCP SSE endpoint closed before sending an endpoint event".to_string()
                    );
                };
                if buffer.len().saturating_add(chunk.len()) > MAX_FRAME_BYTES {
                    return Err("MCP SSE endpoint preamble exceeds the 1 MB limit".to_string());
                }
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                for (event, data) in sse_events(&buffer) {
                    if event != "endpoint" {
                        continue;
                    }
                    let endpoint = resolve_sse_endpoint(&endpoint, &data)?;
                    return Ok((endpoint, session_id));
                }
            }
        };
        let (endpoint, session_id) = self
            .run_with_stop(future, INITIALIZE_TIMEOUT, None, "SSE bootstrap")
            .await?;
        if *self.stop_signal.borrow() {
            return Err("MCP SSE bootstrap cancelled: connection stopped".to_string());
        }
        *self.endpoint.lock().await = endpoint;
        if session_id.is_some() {
            *self.session_id.lock().await = session_id;
        }
        Ok(())
    }

    async fn initialize(&self) -> Result<(), String> {
        if self.spec.transport == McpTransport::Sse {
            self.bootstrap_sse().await?;
        }
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "melody-work", "version": env!("CARGO_PKG_VERSION") },
            }),
            INITIALIZE_TIMEOUT,
            None,
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await
    }

    async fn list_tools(&self) -> Result<Vec<McpToolSummary>, String> {
        if let Some(tools) = self.tools.lock().await.clone() {
            return Ok(tools);
        }
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let result = self
                .request("tools/list", params, REQUEST_TIMEOUT, None)
                .await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    "MCP remote tools/list response did not contain tools[]".to_string()
                })?;
            for item in page {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let Some(name) = object.get("name").and_then(Value::as_str) else {
                    continue;
                };
                if name.is_empty() || name.len() > MAX_TOOL_NAME_BYTES {
                    continue;
                }
                let description = object
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|value| bounded_text(value.to_string(), MAX_DESCRIPTION_BYTES));
                let input_schema = object
                    .get("inputSchema")
                    .filter(|value| value.is_object())
                    .and_then(|value| {
                        serde_json::to_vec(value)
                            .ok()
                            .filter(|bytes| bytes.len() <= MAX_TOOL_SCHEMA_BYTES)
                            .map(|_| value.clone())
                    });
                tools.push(McpToolSummary {
                    name: name.to_string(),
                    description,
                    input_schema,
                });
                if tools.len() >= MAX_TOOLS {
                    break;
                }
            }
            if tools.len() >= MAX_TOOLS {
                break;
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        if *self.stop_signal.borrow() {
            return Err("MCP remote tools/list cancelled: connection stopped".to_string());
        }
        *self.tools.lock().await = Some(tools.clone());
        Ok(tools)
    }

    async fn call_tool(
        &self,
        tool: &str,
        arguments: &Value,
        cancellation: Option<oneshot::Receiver<()>>,
    ) -> Result<String, String> {
        if !arguments.is_object() {
            return Err("mcp_call_tool arguments must be an object".to_string());
        }
        let tools = self.list_tools().await?;
        if !tools.iter().any(|item| item.name == tool) {
            return Err(format!(
                "MCP tool {tool} is not advertised by {}",
                self.spec.name
            ));
        }
        let result = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
                REQUEST_TIMEOUT,
                cancellation,
            )
            .await?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            let text = mcp_result_text(&result)?;
            return Err(if text.is_empty() {
                format!("MCP tool {tool} returned an error")
            } else {
                text
            });
        }
        mcp_result_text(&result)
    }

    async fn stop(&self) {
        self.stop_signal.send_replace(true);
        *self.tools.lock().await = None;
        *self.session_id.lock().await = None;
    }
}

async fn read_bounded_line(
    reader: &mut BufReader<ChildStdout>,
    line: &mut Vec<u8>,
) -> std::io::Result<Option<usize>> {
    loop {
        let mut byte = [0_u8; 1];
        let bytes = reader.read(&mut byte).await?;
        if bytes == 0 {
            return Ok((!line.is_empty()).then_some(line.len()));
        }
        line.push(byte[0]);
        if line.len() > MAX_FRAME_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "MCP response exceeds the 1 MB frame limit",
            ));
        }
        if byte[0] == b'\n' {
            return Ok(Some(line.len()));
        }
    }
}

async fn read_stdout(connection: std::sync::Weak<McpConnection>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match read_bounded_line(&mut reader, &mut line).await {
            Ok(None) => {
                if let Some(connection) = connection.upgrade() {
                    connection
                        .reject_pending("MCP server closed stdout".to_string())
                        .await;
                }
                return;
            }
            Ok(Some(_)) => {}
            Err(error) => {
                if let Some(connection) = connection.upgrade() {
                    connection
                        .reject_pending(format!("Failed to read MCP stdout: {error}"))
                        .await;
                }
                return;
            }
        }
        let text = String::from_utf8_lossy(&line).trim().to_string();
        if text.is_empty() {
            continue;
        }
        let value = match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(error) => {
                if let Some(connection) = connection.upgrade() {
                    connection
                        .reject_pending(format!("MCP server emitted invalid JSON: {error}"))
                        .await;
                }
                return;
            }
        };
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            // Notifications and server-initiated requests are deliberately
            // ignored until the bridge has an explicit policy for them.
            continue;
        };
        if let Some(connection) = connection.upgrade() {
            if let Some(sender) = connection.pending.lock().await.remove(&id) {
                let _ = sender.send(Ok(value));
            }
        } else {
            return;
        }
    }
}

async fn drain_stderr(stderr: tokio::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

fn mcp_result_text(result: &Value) -> Result<String, String> {
    let Some(content) = result.get("content").and_then(Value::as_array) else {
        return serde_json::to_string(result).map_err(|error| error.to_string());
    };
    let mut parts = Vec::new();
    for item in content {
        let Some(object) = item.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                parts.push(text.to_string());
            }
        } else {
            parts.push(bounded_json(item, 16 * 1024)?);
        }
    }
    Ok(parts.join("\n"))
}

fn format_mcp_tool_output(root: &Path, server: &str, tool: &str, output: String) -> String {
    let preview = bounded_text(output.clone(), MAX_RESULT_BYTES);
    if output.len() <= MAX_RESULT_BYTES {
        return format!("MCP server {server} tool {tool} result:\n{preview}");
    }

    let archive_note = match archive_tool_output(root, output.as_bytes(), MCP_ARCHIVE_FILE_PREFIX) {
        Ok((path, bytes_written, truncated)) if truncated => {
            format!("MCP output archive contains the first {bytes_written} bytes at {path}")
        }
        Ok((path, _, _)) => format!(
            "full MCP output ({} bytes) archived at {path}",
            output.len()
        ),
        Err(error) => format!(
            "full MCP output ({} bytes) could not be archived: {error}",
            output.len()
        ),
    };
    format!(
        "MCP server {server} tool {tool} result:\n{preview}\n[MCP output truncated: {archive_note}]"
    )
}

fn connection_key(root: &Path, name: &str) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    format!("{}\0{name}", canonical.to_string_lossy())
}

impl PiMcpRuntime {
    async fn begin_call(
        &self,
        session_id: &str,
        root: &Path,
        run_id: Option<&str>,
        tool_call_id: &str,
    ) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        self.inner.active_calls.lock().await.insert(
            tool_call_id.to_string(),
            ActiveMcpCall {
                session_id: session_id.to_string(),
                root: root.to_path_buf(),
                run_id: run_id.map(str::to_string),
                cancel: sender,
            },
        );
        receiver
    }

    async fn end_call(&self, tool_call_id: &str) {
        self.inner.active_calls.lock().await.remove(tool_call_id);
    }

    /// Cancel MCP calls owned by a product session. A run id narrows the
    /// cancellation to the root run; passing `cancel_subagents` also covers
    /// child task runs that share the root product session.
    pub(crate) async fn cancel_session(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        cancel_subagents: bool,
    ) {
        let mut calls = self.inner.active_calls.lock().await;
        let ids = calls
            .iter()
            .filter(|(_, call)| {
                call.session_id == session_id
                    && (cancel_subagents || run_id.is_none() || call.run_id.as_deref() == run_id)
            })
            .map(|(tool_call_id, _)| tool_call_id.clone())
            .collect::<Vec<_>>();
        let senders = ids
            .into_iter()
            .filter_map(|tool_call_id| calls.remove(&tool_call_id))
            .map(|call| call.cancel)
            .collect::<Vec<_>>();
        drop(calls);
        for sender in senders {
            let _ = sender.send(());
        }
    }

    /// Stop every MCP process rooted at a workspace. This is used when a
    /// product session/project is deleted so a worker shutdown cannot leave a
    /// detached server holding open pipes or executing a stale request.
    pub(crate) async fn stop_workspace(&self, root: &Path) {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut calls = self.inner.active_calls.lock().await;
        let call_ids = calls
            .iter()
            .filter(|(_, call)| {
                let call_root = call
                    .root
                    .canonicalize()
                    .unwrap_or_else(|_| call.root.clone());
                call_root == canonical || call_root.starts_with(&canonical)
            })
            .map(|(tool_call_id, _)| tool_call_id.clone())
            .collect::<Vec<_>>();
        let senders = call_ids
            .into_iter()
            .filter_map(|tool_call_id| calls.remove(&tool_call_id))
            .map(|call| call.cancel)
            .collect::<Vec<_>>();
        drop(calls);
        for sender in senders {
            let _ = sender.send(());
        }

        let mut connections = self.inner.connections.lock().await;
        let keys = connections
            .iter()
            .filter(|(_, connection)| {
                let connection_cwd = connection
                    .spec
                    .cwd
                    .canonicalize()
                    .unwrap_or_else(|_| connection.spec.cwd.clone());
                connection_cwd == canonical || connection_cwd.starts_with(&canonical)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let stopped = keys
            .into_iter()
            .filter_map(|key| connections.remove(&key))
            .collect::<Vec<_>>();
        drop(connections);
        for connection in stopped {
            connection.stop().await;
        }

        let mut remote_connections = self.inner.remote_connections.lock().await;
        let remote_keys = remote_connections
            .iter()
            .filter(|(_, connection)| {
                let connection_root = connection
                    .root
                    .canonicalize()
                    .unwrap_or_else(|_| connection.root.clone());
                connection_root == canonical || connection_root.starts_with(&canonical)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let stopped_remote = remote_keys
            .into_iter()
            .filter_map(|key| remote_connections.remove(&key))
            .collect::<Vec<_>>();
        drop(remote_connections);
        for connection in stopped_remote {
            connection.stop().await;
        }
    }

    /// Resolve a normalized `tool.requested` event emitted by the Pi worker.
    /// The event parser accepts the current flat activity shape and the
    /// historical nested shape so replayed sessions remain understandable.
    pub(crate) async fn resolve_request(
        &self,
        root: &Path,
        value: &Value,
    ) -> Result<String, String> {
        let event = value
            .get("event")
            .and_then(Value::as_object)
            .ok_or_else(|| "MCP tool request is missing event".to_string())?;
        let tool_name = event
            .get("toolName")
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool request is missing toolName".to_string())?;
        let activity = event.get("activity").unwrap_or(&Value::Null);
        let arguments = activity
            .as_object()
            .and_then(|object| object.get("arguments"))
            .or_else(|| {
                activity
                    .get("activity")
                    .and_then(Value::as_object)
                    .and_then(|object| object.get("arguments"))
            })
            .ok_or_else(|| "MCP tool request is missing arguments".to_string())?;
        let arguments = arguments
            .as_object()
            .ok_or_else(|| "MCP tool request arguments must be an object".to_string())?;
        match tool_name {
            "mcp_list_tools" => {
                let server = arguments.get("server").and_then(Value::as_str);
                self.list_tools(root, server).await
            }
            "mcp_call_tool" => {
                let server = arguments
                    .get("server")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "mcp_call_tool requires server".to_string())?;
                let tool = arguments
                    .get("tool")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "mcp_call_tool requires tool".to_string())?;
                let tool_arguments = arguments
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let session_id = value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "MCP tool request is missing sessionId".to_string())?;
                let tool_call_id = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "MCP tool request is missing toolCallId".to_string())?;
                let run_id = value.get("runId").and_then(Value::as_str);
                let cancellation = self
                    .begin_call(session_id, root, run_id, tool_call_id)
                    .await;
                let result = self
                    .call_tool(root, server, tool, &tool_arguments, Some(cancellation))
                    .await;
                self.end_call(tool_call_id).await;
                result
            }
            _ => Err(format!("Unsupported MCP gateway tool {tool_name}")),
        }
    }

    async fn ensure_connection(
        &self,
        root: &Path,
        name: &str,
    ) -> Result<(String, Arc<McpConnection>), String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let entries = load_mcp_entries(root)?;
        let entry = entries
            .get(name)
            .ok_or_else(|| format!("MCP server {name} is not configured"))?;
        let spec = entry.spec.clone().ok_or_else(|| {
            entry
                .status
                .reason
                .clone()
                .unwrap_or_else(|| "MCP server is unsupported".to_string())
        })?;
        let key = connection_key(root, name);
        if let Some(connection) = self.inner.remote_connections.lock().await.remove(&key) {
            connection.stop().await;
        }
        if let Some(connection) = self.inner.connections.lock().await.get(&key).cloned() {
            if connection.is_running().await && connection.spec == spec {
                return Ok((key, connection));
            }
            self.remove_connection(&key, &connection).await;
        }
        let connection = McpConnection::start(spec)?;
        if let Err(error) = connection.initialize().await {
            connection.stop().await;
            return Err(error);
        }
        self.inner
            .connections
            .lock()
            .await
            .insert(key.clone(), connection.clone());
        Ok((key, connection))
    }

    async fn remove_connection(&self, key: &str, connection: &Arc<McpConnection>) {
        let removed = self
            .inner
            .connections
            .lock()
            .await
            .remove(key)
            .filter(|current| Arc::ptr_eq(current, connection));
        if let Some(connection) = removed {
            connection.stop().await;
        }
    }

    async fn ensure_remote_connection(
        &self,
        root: &Path,
        name: &str,
    ) -> Result<(String, Arc<RemoteMcpConnection>), String> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let entries = load_mcp_entries(root)?;
        let entry = entries
            .get(name)
            .ok_or_else(|| format!("MCP server {name} is not configured"))?;
        let spec = entry.remote.clone().ok_or_else(|| {
            entry
                .status
                .reason
                .clone()
                .unwrap_or_else(|| "MCP server is unsupported".to_string())
        })?;
        let key = connection_key(root, name);
        if let Some(connection) = self.inner.connections.lock().await.remove(&key) {
            connection.stop().await;
        }
        if let Some(connection) = self
            .inner
            .remote_connections
            .lock()
            .await
            .get(&key)
            .cloned()
        {
            if connection.spec == spec {
                return Ok((key, connection));
            }
            self.remove_remote_connection(&key, &connection).await;
        }
        let connection = RemoteMcpConnection::start(root.to_path_buf(), spec)?;
        if let Err(error) = connection.initialize().await {
            connection.stop().await;
            return Err(error);
        }
        self.inner
            .remote_connections
            .lock()
            .await
            .insert(key.clone(), connection.clone());
        Ok((key, connection))
    }

    async fn remove_remote_connection(&self, key: &str, connection: &Arc<RemoteMcpConnection>) {
        let removed = self
            .inner
            .remote_connections
            .lock()
            .await
            .remove(key)
            .filter(|current| Arc::ptr_eq(current, connection));
        if let Some(connection) = removed {
            connection.stop().await;
        }
    }

    pub(crate) async fn list_tools(
        &self,
        root: &Path,
        requested_server: Option<&str>,
    ) -> Result<String, String> {
        let entries = load_mcp_entries(root)?;
        let names = if let Some(name) = requested_server {
            if !entries.contains_key(name) {
                return Err(format!("MCP server {name} is not configured"));
            }
            vec![name.to_string()]
        } else {
            entries.keys().cloned().collect::<Vec<_>>()
        };
        let mut servers = Vec::new();
        for name in names {
            let entry = entries
                .get(&name)
                .ok_or_else(|| format!("MCP server {name} is not configured"))?;
            let mut status =
                serde_json::to_value(&entry.status).map_err(|error| error.to_string())?;
            if entry.spec.is_some() {
                match self.ensure_connection(root, &name).await {
                    Ok((key, connection)) => match connection.list_tools().await {
                        Ok(tools) => {
                            status["tools"] =
                                serde_json::to_value(tools).unwrap_or_else(|_| json!([]))
                        }
                        Err(error) => {
                            status["reason"] = Value::String(error);
                            if let Some(code) = status
                                .get("reason")
                                .and_then(Value::as_str)
                                .and_then(remote_error_code)
                            {
                                status["errorCode"] = Value::String(code.to_string());
                            }
                            self.remove_connection(&key, &connection).await;
                        }
                    },
                    Err(error) => status["reason"] = Value::String(error),
                }
            } else if entry.remote.is_some() {
                match self.ensure_remote_connection(root, &name).await {
                    Ok((key, connection)) => match connection.list_tools().await {
                        Ok(tools) => {
                            status["tools"] =
                                serde_json::to_value(tools).unwrap_or_else(|_| json!([]))
                        }
                        Err(error) => {
                            status["reason"] = Value::String(error);
                            if let Some(code) = status
                                .get("reason")
                                .and_then(Value::as_str)
                                .and_then(remote_error_code)
                            {
                                status["errorCode"] = Value::String(code.to_string());
                            }
                            self.remove_remote_connection(&key, &connection).await;
                        }
                    },
                    Err(error) => status["reason"] = Value::String(error),
                }
            }
            servers.push(status);
        }
        bounded_json(&json!({ "servers": servers }), MAX_RESULT_BYTES)
    }

    pub(crate) async fn call_tool(
        &self,
        root: &Path,
        server: &str,
        tool: &str,
        arguments: &Value,
        cancellation: Option<oneshot::Receiver<()>>,
    ) -> Result<String, String> {
        let entries = load_mcp_entries(root)?;
        let entry = entries
            .get(server)
            .ok_or_else(|| format!("MCP server {server} is not configured"))?;
        let result = if entry.spec.is_some() {
            let (key, connection) = self.ensure_connection(root, server).await?;
            let result = connection.call_tool(tool, arguments, cancellation).await;
            if result.is_err() {
                self.remove_connection(&key, &connection).await;
            }
            result
        } else if entry.remote.is_some() {
            let (key, connection) = self.ensure_remote_connection(root, server).await?;
            let result = connection.call_tool(tool, arguments, cancellation).await;
            if result.is_err() {
                self.remove_remote_connection(&key, &connection).await;
            }
            result
        } else {
            Err(entry
                .status
                .reason
                .clone()
                .unwrap_or_else(|| "MCP server is unsupported".to_string()))
        };
        result.map(|output| format_mcp_tool_output(root, server, tool, output))
    }

    pub(crate) async fn stop_all(&self) {
        let calls = self
            .inner
            .active_calls
            .lock()
            .await
            .drain()
            .map(|(_, call)| call.cancel)
            .collect::<Vec<_>>();
        for sender in calls {
            let _ = sender.send(());
        }
        let connections = self
            .inner
            .connections
            .lock()
            .await
            .drain()
            .map(|(_, connection)| connection)
            .collect::<Vec<_>>();
        for connection in connections {
            connection.stop().await;
        }
        let remote_connections = self
            .inner
            .remote_connections
            .lock()
            .await
            .drain()
            .map(|(_, connection)| connection)
            .collect::<Vec<_>>();
        for connection in remote_connections {
            connection.stop().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{Read, Write},
        net::TcpListener,
        path::PathBuf,
        thread,
    };

    fn root() -> PathBuf {
        let root = env::temp_dir().join(format!("melody-pi-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let bytes = stream.read(&mut buffer).unwrap();
            if bytes == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..bytes]);
            let header_end = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4);
            let Some(header_end) = header_end else {
                continue;
            };
            let content_length = String::from_utf8_lossy(&request[..header_end])
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= header_end + content_length {
                break;
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    #[test]
    fn parses_local_stdio_and_remote_transports() {
        let root = root();
        let local = parse_server_entry(
            "filesystem".to_string(),
            &serde_json::from_value(json!({
                "command": "mcp-server-filesystem",
                "args": ["/tmp"],
            }))
            .unwrap(),
            &root,
        );
        assert!(local.status.supported);
        assert_eq!(local.status.transport, "stdio");
        assert_eq!(local.spec.as_ref().unwrap().cwd, root);

        let remote = parse_server_entry(
            "remote".to_string(),
            &serde_json::from_value(json!({
                "url": "https://example.test/mcp",
                "transport": "streamable-http",
                "headers": { "Authorization": "Bearer test" },
            }))
            .unwrap(),
            &root,
        );
        assert!(remote.status.supported);
        assert_eq!(remote.status.transport, "http");
        assert_eq!(remote.spec, None);
        assert_eq!(remote.remote.as_ref().unwrap().headers.len(), 1);

        let invalid = parse_server_entry(
            "invalid".to_string(),
            &serde_json::from_value(json!({
                "url": "https://user:pass@example.test/mcp",
                "transport": "sse",
            }))
            .unwrap(),
            &root,
        );
        assert!(!invalid.status.supported);
        assert!(
            invalid
                .status
                .reason
                .unwrap()
                .contains("without credentials")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_sse_events_and_requires_matching_json_rpc_id() {
        let body =
            b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        let value = parse_sse_rpc_response(body, 7, "tools/list").unwrap();
        assert_eq!(value["id"], 7);
        assert!(
            parse_sse_rpc_response(body, 8, "tools/list")
                .unwrap_err()
                .contains("id 8")
        );

        let base = Url::parse("https://mcp.example.test/sse").unwrap();
        assert_eq!(
            resolve_sse_endpoint(&base, "/message").unwrap().as_str(),
            "https://mcp.example.test/message"
        );
        assert!(
            resolve_sse_endpoint(&base, "https://attacker.example.test/message")
                .unwrap_err()
                .contains("configured server origin")
        );
        assert!(
            resolve_sse_endpoint(&base, "//attacker.example.test/message")
                .unwrap_err()
                .contains("configured server origin")
        );
    }

    #[test]
    fn resolves_explicit_environment_references_without_echoing_secret_values() {
        let variable = format!("MELODY_PI_TEST_MCP_{}", uuid::Uuid::new_v4().simple());
        let secret = format!("secret-{}", uuid::Uuid::new_v4());
        unsafe {
            env::set_var(&variable, &secret);
        }
        let headers = parse_remote_headers(
            &serde_json::from_value(json!({
                "headers": {
                    "Authorization": format!("Bearer ${{{variable}}}"),
                    "X-Trace": "plain-value"
                }
            }))
            .unwrap(),
            "remote",
        )
        .unwrap();
        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), format!("Bearer {secret}")),
                ("X-Trace".to_string(), "plain-value".to_string())
            ]
        );
        let missing = parse_remote_headers(
            &serde_json::from_value(json!({
                "headers": { "Authorization": "Bearer ${MELODY_PI_MISSING_MCP_TOKEN}" }
            }))
            .unwrap(),
            "remote",
        )
        .unwrap_err();
        assert!(missing.contains("unset environment variable"));
        assert!(!missing.contains(&secret));
        unsafe {
            env::remove_var(&variable);
        }
    }

    #[test]
    fn classifies_remote_auth_failures_without_echoing_response_body() {
        let body = br#"{"error":"token=do-not-log"}"#;
        let response = RemoteResponse {
            status: 401,
            content_type: Some("application/json".to_string()),
            session_id: None,
            body: body.to_vec(),
        };
        let error = parse_remote_rpc_response(&response, 1, "tools/list").unwrap_err();
        assert!(error.contains("[mcp.auth_required]"));
        assert!(error.contains("HTTP 401"));
        assert!(!error.contains("do-not-log"));

        let forbidden = remote_http_error("tools/call", 403, body);
        assert!(forbidden.contains("[mcp.access_denied]"));
        assert!(!forbidden.contains("do-not-log"));
        assert_eq!(remote_error_code(&forbidden), Some("mcp.access_denied"));

        let unavailable = remote_http_error("tools/list", 503, b"temporarily unavailable");
        assert!(unavailable.contains("[mcp.remote_http_error]"));
        assert!(unavailable.contains("temporarily unavailable"));
    }

    #[tokio::test]
    async fn remote_operation_honors_host_cancellation() {
        let (sender, receiver) = oneshot::channel();
        let operation = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok::<_, String>(())
        };
        sender.send(()).unwrap();
        let result = run_remote_operation(
            operation,
            Duration::from_secs(30),
            Some(receiver),
            "tools/call",
        )
        .await;
        assert!(result.unwrap_err().contains("cancelled"));
    }

    #[tokio::test]
    async fn remote_auth_failure_returns_without_draining_an_open_body() {
        let root = root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_http_request(&mut stream);
            stream
                .write_all(
                    concat!(
                        "HTTP/1.1 401 Unauthorized\r\n",
                        "Content-Type: text/html\r\n",
                        "Connection: keep-alive\r\n\r\n",
                        "<html>token=must-not-be-read</html>"
                    )
                    .as_bytes(),
                )
                .unwrap();
            thread::sleep(Duration::from_secs(2));
        });
        let client = remote_client().unwrap();
        let request = client.get(format!("http://{address}/mcp")).build().unwrap();
        let response = timeout(
            Duration::from_secs(1),
            execute_remote_request(&client, request, Some(1), "tools/list"),
        )
        .await
        .expect("auth status should not wait for an open response body")
        .unwrap();
        assert_eq!(response.status, 401);
        assert!(response.body.is_empty());
        let error = parse_remote_rpc_response(&response, 1, "tools/list").unwrap_err();
        assert!(error.contains("[mcp.auth_required]"));
        assert!(!error.contains("must-not-be-read"));

        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn result_text_preserves_text_content_for_host_archival() {
        let result = json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "image", "data": "opaque" }
            ]
        });
        let text = mcp_result_text(&result).unwrap();
        assert!(text.starts_with("hello\n"));
        assert!(text.contains("image"));

        let huge =
            json!({ "content": [{ "type": "text", "text": "x".repeat(MAX_RESULT_BYTES + 10) }] });
        let large = mcp_result_text(&huge).unwrap();
        assert_eq!(large.len(), MAX_RESULT_BYTES + 10);
        assert!(!large.contains("output truncated"));
    }

    #[test]
    fn large_mcp_result_is_archived_with_bounded_preview() {
        let root = root();
        let output = "m".repeat(MAX_RESULT_BYTES + 10);
        let rendered = format_mcp_tool_output(&root, "demo", "large", output.clone());
        assert!(rendered.contains("MCP output truncated"));
        assert!(rendered.contains("full MCP output"));

        let archive_dir = root.join(".melody/pi/tool-output");
        let mut archives = fs::read_dir(&archive_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with(MCP_ARCHIVE_FILE_PREFIX) && name.ends_with(".log"))
                    .unwrap_or(false)
            });
        let archive = archives.next().expect("MCP output archive should exist");
        assert!(archives.next().is_none());
        assert_eq!(fs::read(&archive).unwrap(), output.as_bytes());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_stdio_server_lists_and_calls_tools() {
        let root = root();
        let script = root.join("mcp-server.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}' ;;
    *'"method":"tools/list"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}' ;;
    *'"method":"tools/call"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}]}}' ;;
  esac
done
"#,
        )
        .unwrap();

        let connection = McpConnection::start(McpServerSpec {
            name: "test".to_string(),
            command: "/bin/sh".to_string(),
            args: vec![script.to_string_lossy().into_owned()],
            env: Vec::new(),
            cwd: root.clone(),
        })
        .unwrap();
        connection.initialize().await.unwrap();
        let tools = connection.list_tools().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].description.as_deref(), Some("Echo text"));
        assert_eq!(
            tools[0]
                .input_schema
                .as_ref()
                .and_then(|schema| schema.get("type"))
                .and_then(Value::as_str),
            Some("object")
        );
        let output = connection
            .call_tool("echo", &json!({ "text": "hello" }), None)
            .await
            .unwrap();
        assert_eq!(output, "ok");
        connection.stop().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_stops_a_waiting_mcp_call() {
        let root = root();
        let script = root.join("mcp-server.sh");
        let marker = root.join("call-started");
        let marker_path = marker.to_string_lossy().replace('\'', "'\\''");
        fs::write(
            &script,
            format!(
                r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2024-11-05"}}}}' ;;
    *'"method":"tools/list"'*) printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"tools":[{{"name":"wait"}}]}}}}' ;;
    *'"method":"tools/call"'*) : > '{marker_path}'; while IFS= read -r ignored; do :; done ;;
  esac
done
"#
            ),
        )
        .unwrap();

        let connection = McpConnection::start(McpServerSpec {
            name: "test".to_string(),
            command: "/bin/sh".to_string(),
            args: vec![script.to_string_lossy().into_owned()],
            env: Vec::new(),
            cwd: root.clone(),
        })
        .unwrap();
        connection.initialize().await.unwrap();
        assert_eq!(connection.list_tools().await.unwrap().len(), 1);

        let (cancel_sender, cancel_receiver) = oneshot::channel();
        let call_connection = connection.clone();
        let call = tokio::spawn(async move {
            call_connection
                .call_tool("wait", &json!({}), Some(cancel_receiver))
                .await
        });
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(marker.exists(), "MCP server did not receive tools/call");
        cancel_sender.send(()).unwrap();
        let result = timeout(Duration::from_secs(1), call)
            .await
            .expect("cancelled MCP call should finish promptly")
            .expect("MCP call task should not panic")
            .expect_err("cancelled MCP call must return an error");
        assert!(result.contains("cancelled"));

        connection.stop().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn remote_http_server_lists_and_calls_tools() {
        let root = root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let bytes = stream.read(&mut buffer).unwrap();
                    if bytes == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..bytes]);
                    let header_end = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|position| position + 4);
                    let Some(header_end) = header_end else {
                        continue;
                    };
                    let content_length = String::from_utf8_lossy(&request[..header_end])
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("Content-Length:")
                                .or_else(|| line.strip_prefix("content-length:"))
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + content_length {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let (status, body, content_type) = if text.contains("\"method\":\"initialize\"") {
                    (
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#,
                        "application/json",
                    )
                } else if text.contains("\"method\":\"notifications/initialized\"") {
                    ("202 Accepted", "", "application/json")
                } else if text.contains("\"method\":\"tools/list\"") {
                    (
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object"}}]}}"#,
                        "application/json",
                    )
                } else {
                    (
                        "200 OK",
                        r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"remote-ok"}]}}"#,
                        "application/json",
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
                    body.len(),
                    if text.contains("\"method\":\"initialize\"") {
                        "Mcp-Session-Id: test-session\r\n"
                    } else {
                        ""
                    },
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });

        let connection = RemoteMcpConnection::start(
            root.clone(),
            McpRemoteSpec {
                name: "remote".to_string(),
                transport: McpTransport::Http,
                url: format!("http://{address}/mcp"),
                headers: vec![("Authorization".to_string(), "Bearer test".to_string())],
            },
        )
        .unwrap();
        connection.initialize().await.unwrap();
        assert_eq!(
            connection.session_id.lock().await.as_deref(),
            Some("test-session")
        );
        let tools = connection.list_tools().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        let output = connection
            .call_tool("echo", &json!({ "text": "hello" }), None)
            .await
            .unwrap();
        assert_eq!(output, "remote-ok");
        connection.stop().await;
        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn remote_sse_response_returns_after_matching_event_without_waiting_for_eof() {
        let root = root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_http_request(&mut stream);
            // Streamable HTTP servers may leave an SSE response open after
            // delivering the requested JSON-RPC result. The client must
            // resolve on the matching event instead of waiting for EOF.
            let response = concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/event-stream\r\n",
                "Connection: keep-alive\r\n\r\n",
                "event: message\r\n",
                "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).unwrap();
            thread::sleep(Duration::from_secs(2));
        });

        let connection = RemoteMcpConnection::start(
            root.clone(),
            McpRemoteSpec {
                name: "streaming".to_string(),
                transport: McpTransport::Http,
                url: format!("http://{address}/mcp"),
                headers: Vec::new(),
            },
        )
        .unwrap();
        let started = std::time::Instant::now();
        let result = timeout(
            Duration::from_secs(1),
            connection.request("tools/list", json!({}), REQUEST_TIMEOUT, None),
        )
        .await
        .expect("SSE result should not wait for the server to close the stream")
        .unwrap();
        assert_eq!(result["tools"], json!([]));
        assert!(started.elapsed() < Duration::from_secs(1));

        connection.stop().await;
        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stopping_remote_connection_cancels_in_flight_request() {
        let root = root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_seen_sender, request_seen_receiver) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_http_request(&mut stream);
            request_seen_sender.send(()).unwrap();
            thread::sleep(Duration::from_secs(2));
        });

        let connection = RemoteMcpConnection::start(
            root.clone(),
            McpRemoteSpec {
                name: "remote".to_string(),
                transport: McpTransport::Http,
                url: format!("http://{address}/mcp"),
                headers: Vec::new(),
            },
        )
        .unwrap();
        let request_connection = connection.clone();
        let request = tokio::spawn(async move {
            request_connection
                .request("tools/list", json!({}), REQUEST_TIMEOUT, None)
                .await
        });
        tokio::task::spawn_blocking(move || {
            request_seen_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("remote server should receive the request");
        })
        .await
        .unwrap();
        connection.stop().await;
        let result = timeout(Duration::from_secs(1), request)
            .await
            .expect("stopping a remote connection should cancel promptly")
            .expect("remote request task should not panic")
            .expect_err("stopped remote request must return an error");
        assert!(result.contains("connection stopped"));

        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn remote_sse_server_bootstraps_endpoint_and_lists_tools() {
        let root = root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_request(&mut stream);
                if request.starts_with("GET /sse ") {
                    let response = concat!(
                        "HTTP/1.1 200 OK\r\n",
                        "Content-Type: text/event-stream\r\n",
                        "Mcp-Session-Id: sse-session\r\n",
                        "Connection: close\r\n\r\n",
                        "event: endpoint\r\n",
                        "data: /message\r\n\r\n"
                    );
                    stream.write_all(response.as_bytes()).unwrap();
                    continue;
                }
                let body = if request.contains("\"method\":\"initialize\"") {
                    r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#
                } else if request.contains("\"method\":\"notifications/initialized\"") {
                    ""
                } else if request.contains("\"method\":\"tools/list\"") {
                    r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo"}]}}"#
                } else {
                    r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"sse-ok"}]}}"#
                };
                let status = if body.is_empty() {
                    "202 Accepted"
                } else {
                    "200 OK"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });

        let connection = RemoteMcpConnection::start(
            root.clone(),
            McpRemoteSpec {
                name: "sse".to_string(),
                transport: McpTransport::Sse,
                url: format!("http://{address}/sse"),
                headers: Vec::new(),
            },
        )
        .unwrap();
        connection.initialize().await.unwrap();
        assert_eq!(
            connection.session_id.lock().await.as_deref(),
            Some("sse-session")
        );
        let tools = connection.list_tools().await.unwrap();
        assert_eq!(tools[0].name, "echo");
        assert_eq!(
            connection
                .call_tool("echo", &json!({}), None)
                .await
                .unwrap(),
            "sse-ok"
        );
        connection.stop().await;
        server.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stop_workspace_cancels_calls_in_workspace_subdirectories() {
        let root = root();
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let runtime = PiMcpRuntime::default();
        let receiver = runtime
            .begin_call("session", &nested, None, "tool-call")
            .await;

        runtime.stop_workspace(&root).await;

        assert!(
            timeout(Duration::from_secs(1), receiver)
                .await
                .expect("workspace cancellation should resolve promptly")
                .is_ok(),
            "calls rooted in workspace subdirectories must be cancelled"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
