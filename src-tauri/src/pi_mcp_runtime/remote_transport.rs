//! Bounded HTTP/SSE JSON-RPC transport and the remote MCP connection state machine.

use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use reqwest::{Client, Method, Url, header};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, oneshot, watch},
    time::timeout,
};

use super::{
    INITIALIZE_TIMEOUT, MAX_DESCRIPTION_BYTES, MAX_FRAME_BYTES, MAX_LIST_PAGES,
    MAX_TOOL_NAME_BYTES, MAX_TOOL_SCHEMA_BYTES, MAX_TOOLS, McpToolSummary, REQUEST_TIMEOUT,
    bounded_json, bounded_text, mcp_result_text,
};

const MAX_REMOTE_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum McpTransport {
    Http,
    Sse,
}

impl McpTransport {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Sse => "sse",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct McpRemoteSpec {
    pub(super) name: String,
    pub(super) transport: McpTransport,
    pub(super) url: String,
    pub(super) headers: Vec<(String, String)>,
}

pub(super) struct RemoteResponse {
    pub(super) status: u16,
    pub(super) content_type: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) body: Vec<u8>,
}

pub(super) struct RemoteMcpConnection {
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

pub(super) fn remote_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("melody-work/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Failed to create MCP remote client: {error}"))
}

pub(super) async fn execute_remote_request(
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

pub(super) async fn run_remote_operation<T, F>(
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
pub(super) fn remote_http_error(method: &str, status: u16, body: &[u8]) -> String {
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

pub(super) fn remote_error_code(message: &str) -> Option<&'static str> {
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

pub(super) fn parse_sse_rpc_response(
    body: &[u8],
    expected_id: u64,
    method: &str,
) -> Result<Value, String> {
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
pub(super) fn resolve_sse_endpoint(base: &Url, advertised: &str) -> Result<Url, String> {
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

pub(super) fn parse_remote_rpc_response(
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
    pub(super) fn start(root: PathBuf, spec: McpRemoteSpec) -> Result<Arc<Self>, String> {
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

    pub(super) async fn initialize(&self) -> Result<(), String> {
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

    pub(super) async fn call_tool(
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

    pub(super) async fn stop(&self) {
        self.stop_signal.send_replace(true);
        *self.tools.lock().await = None;
        *self.session_id.lock().await = None;
    }

    pub(super) fn matches_spec(&self, spec: &McpRemoteSpec) -> bool {
        self.spec == *spec
    }

    pub(super) fn is_rooted_at_or_below(&self, canonical_root: &Path) -> bool {
        let connection_root = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        connection_root == canonical_root || connection_root.starts_with(canonical_root)
    }
}
