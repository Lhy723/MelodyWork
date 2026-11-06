//! Host-owned MCP bridge for the opt-in Pi worker.
//!
//! Pi intentionally does not receive an MCP client or a raw process API.  The
//! Host reads the trusted Melody configuration, starts only local stdio
//! servers or sends requests through a bounded HTTP/SSE client, speaks
//! JSON-RPC, and exposes the result through the normal Pi ToolGateway.  Pi
//! never receives raw process or network capabilities.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, oneshot};

use crate::pi_tool_output_archive::{MCP_ARCHIVE_FILE_PREFIX, archive_tool_output};

mod mcp_config;
mod remote_transport;
mod stdio_transport;

use mcp_config::{McpServerSpec, load_mcp_entries};
pub(crate) use mcp_config::{McpServerStatus, inspect_mcp_config};
use remote_transport::RemoteMcpConnection;
use stdio_transport::McpConnection;

const MAX_TOOLS: usize = 256;
const MAX_TOOL_NAME_BYTES: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 4 * 1024;
const MAX_TOOL_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_RESULT_BYTES: usize = 512 * 1024;
const MAX_LIST_PAGES: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize)]
struct McpToolSummary {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
    input_schema: Option<Value>,
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
            .filter(|(_, connection)| connection.is_rooted_at_or_below(&canonical))
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
            .filter(|(_, connection)| connection.is_rooted_at_or_below(&canonical))
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
            if connection.is_running().await && connection.matches_spec(&spec) {
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
            if connection.matches_spec(&spec) {
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
                                .and_then(remote_transport::remote_error_code)
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
                                .and_then(remote_transport::remote_error_code)
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
