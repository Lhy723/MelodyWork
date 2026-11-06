//! Isolated local stdio process lifecycle and bounded line-delimited JSON-RPC transport.

use std::{
    collections::HashMap,
    env,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, oneshot},
    time::timeout,
};

use super::{
    INITIALIZE_TIMEOUT, MAX_DESCRIPTION_BYTES, MAX_FRAME_BYTES, MAX_LIST_PAGES,
    MAX_TOOL_NAME_BYTES, MAX_TOOL_SCHEMA_BYTES, MAX_TOOLS, McpServerSpec, McpToolSummary,
    REQUEST_TIMEOUT, bounded_json, bounded_text, mcp_result_text,
};

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

pub(super) struct McpConnection {
    spec: McpServerSpec,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    write_lock: Mutex<()>,
    next_id: AtomicU64,
    tools: Mutex<Option<Vec<McpToolSummary>>>,
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
    pub(super) fn start(spec: McpServerSpec) -> Result<Arc<Self>, String> {
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
    pub(super) async fn is_running(&self) -> bool {
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

    pub(super) async fn initialize(&self) -> Result<(), String> {
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

    pub(super) async fn list_tools(&self) -> Result<Vec<McpToolSummary>, String> {
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

    pub(super) async fn call_tool(
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

    pub(super) async fn stop(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
        self.reject_pending("MCP server stopped".to_string()).await;
    }

    pub(super) fn matches_spec(&self, spec: &McpServerSpec) -> bool {
        self.spec == *spec
    }

    pub(super) fn is_rooted_at_or_below(&self, canonical_root: &Path) -> bool {
        let connection_cwd = self
            .spec
            .cwd
            .canonicalize()
            .unwrap_or_else(|_| self.spec.cwd.clone());
        connection_cwd == canonical_root || connection_cwd.starts_with(canonical_root)
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
