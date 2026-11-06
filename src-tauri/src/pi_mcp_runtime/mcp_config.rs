//! Normalize trusted user/project MCP config into bounded local and remote specs.

use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
};

use reqwest::{Url, header};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::config_core::read_melody_config_inner;

use super::remote_transport::{McpRemoteSpec, McpTransport};

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
pub(super) struct McpServerSpec {
    pub(super) name: String,
    pub(super) command: String,
    pub(super) args: Vec<String>,
    pub(super) env: Vec<(String, String)>,
    pub(super) cwd: PathBuf,
}

#[derive(Clone, Debug)]
pub(super) struct McpServerEntry {
    pub(super) status: McpServerStatus,
    pub(super) spec: Option<McpServerSpec>,
    pub(super) remote: Option<McpRemoteSpec>,
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

pub(super) fn parse_remote_headers(
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

pub(super) fn parse_server_entry(
    name: String,
    object: &Map<String, Value>,
    root: &Path,
) -> McpServerEntry {
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

fn merge_mcp_config_values(
    root: &Path,
    values: &Value,
    merged: &mut BTreeMap<String, McpServerEntry>,
) {
    for key in MCP_ROOT_KEYS {
        let Some(value) = values.get(key) else {
            continue;
        };
        let mut servers = Vec::new();
        collect_server_values(value, None, &mut servers);
        for (name, object) in servers {
            let entry = parse_server_entry(name, &object, root);
            merged.insert(entry.status.name.clone(), entry);
        }
    }
}

pub(super) fn load_mcp_entries(root: &Path) -> Result<BTreeMap<String, McpServerEntry>, String> {
    let cwd = root.to_string_lossy().into_owned();
    let mut merged = BTreeMap::new();
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.clone())?;
        if let Some(error) = document.parse_error.as_ref() {
            return Err(format!("Failed to parse {scope} Melody config: {error}"));
        }
        merge_mcp_config_values(root, &document.values, &mut merged);
    }
    Ok(merged)
}

fn inspect_mcp_documents(
    root: &Path,
    documents: impl IntoIterator<Item = crate::config_core::MelodyConfigDocument>,
) -> Vec<McpServerStatus> {
    let mut merged = BTreeMap::new();
    for document in documents {
        if document.parse_error.is_none() {
            merge_mcp_config_values(root, &document.values, &mut merged);
        }
    }
    merged.into_values().map(|entry| entry.status).collect()
}

/// Inspect the trusted MCP config without starting any process. This is also
/// useful to the Host's capability preflight and keeps unsupported transports
/// visible instead of silently dropping them.
pub(crate) fn inspect_mcp_config(root: &Path) -> Result<Vec<McpServerStatus>, String> {
    let cwd = root.to_string_lossy().into_owned();
    let mut documents = Vec::with_capacity(2);
    for scope in ["user", "project"] {
        documents.push(read_melody_config_inner(scope.to_string(), cwd.clone())?);
    }
    // The caller reports an unreadable config separately. Continue with a
    // readable scope so its MCP degradations remain visible alongside that
    // blocking diagnostic; runtime startup still uses the strict loader.
    Ok(inspect_mcp_documents(root, documents))
}
