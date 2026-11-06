//! Host-owned web tools for the Pi worker.
//!
//! The worker only receives the two declarative tools from `pi_tool_gateway`.
//! This module owns all network I/O so a prompt cannot turn an arbitrary URL,
//! redirect, response body, or model credential into an ambient capability.
//! The implementation intentionally mirrors Melody-build's Responses API
//! search contract while keeping the transport independent of ACP.

use std::{env, net::IpAddr, path::Path, time::Duration};

use reqwest::{Client, Proxy, StatusCode, Url, header};
use serde_json::{Map, Value, json};

use crate::{
    config_core::read_melody_config_inner,
    pi_tool_gateway::{self, WEB_FETCH, WEB_SEARCH},
};

mod projection;

use projection::{bounded_text, format_search_output, html_to_text};

const MAX_QUERY_BYTES: usize = 2_000;
const MAX_URL_BYTES: usize = 4_096;
const MAX_ALLOWED_DOMAINS: usize = 32;
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_FETCH_MAX_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_FETCH_MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_FETCH_TIMEOUT_SECS: u64 = 120;
const DEFAULT_FETCH_TIMEOUT_SECS: u64 = 25;
const MAX_SEARCH_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug)]
struct WebSearchSpec {
    endpoint: Url,
    api_key: String,
    model: String,
    headers: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
struct WebFetchPolicy {
    enabled: bool,
    allowed_domains: Vec<String>,
    proxy_endpoint: Option<Url>,
    timeout: Duration,
    max_content_bytes: usize,
    max_text_bytes: usize,
    allow_local: bool,
}

fn string_value(object: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    object
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn bool_value(object: Option<&Map<String, Value>>, key: &str) -> Option<bool> {
    object
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
}

fn positive_u64(object: Option<&Map<String, Value>>, key: &str) -> Option<u64> {
    object
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
}

fn merge_json(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        if let (Some(Value::Object(existing)), Value::Object(incoming)) =
            (target.get_mut(key), value)
        {
            merge_json(existing, incoming);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn merged_config(root: &Path) -> Result<Map<String, Value>, String> {
    let cwd = root.to_string_lossy().into_owned();
    let mut merged = Map::new();
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.clone())?;
        if let Some(error) = document.parse_error {
            return Err(format!("无法解析 {scope} Melody 配置：{error}"));
        }
        let Some(values) = document.values.as_object() else {
            continue;
        };
        merge_json(&mut merged, values);
    }
    Ok(merged)
}

fn invalid_header_name(name: &str) -> bool {
    name.is_empty()
        || name.len() > MAX_HEADER_NAME_BYTES
        || header::HeaderName::from_bytes(name.as_bytes()).is_err()
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization"
                | "content-type"
                | "content-length"
                | "connection"
                | "host"
                | "transfer-encoding"
        )
}

fn collect_headers(
    global: Option<&Map<String, Value>>,
    model: Option<&Map<String, Value>>,
) -> Result<Vec<(String, String)>, String> {
    let mut merged = std::collections::BTreeMap::<String, String>::new();
    for object in [global, model].into_iter().flatten() {
        let Some(values) = object.get("extra_headers").and_then(Value::as_object) else {
            continue;
        };
        if values.len() > MAX_HEADERS {
            return Err("联网工具的自定义请求头数量超过限制。".to_string());
        }
        for (name, value) in values {
            let Some(value) = value.as_str() else {
                return Err(format!("联网工具请求头 {name} 的值必须是字符串。"));
            };
            if invalid_header_name(name) || value.len() > MAX_HEADER_VALUE_BYTES {
                return Err(format!("联网工具请求头 {name} 无效或超过大小限制。"));
            }
            header::HeaderValue::from_str(value)
                .map_err(|_| format!("联网工具请求头 {name} 的值无效。"))?;
            merged.insert(name.clone(), value.to_string());
        }
    }
    Ok(merged.into_iter().collect())
}

fn resolve_key(model: Option<&Map<String, Value>>) -> Option<String> {
    string_value(model, "api_key").filter(|value| !value.trim().is_empty())
}

fn public_https_url(candidate: &str, label: &str) -> Result<Url, String> {
    if candidate.len() > MAX_URL_BYTES {
        return Err(format!("{label} 超过 4 KB 限制。"));
    }
    let url = Url::parse(candidate.trim()).map_err(|error| format!("{label} 无效：{error}"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(format!("{label} 必须是无凭据/片段的 HTTPS 地址。"));
    }
    Ok(url)
}

fn web_search_spec(root: &Path) -> Result<Option<WebSearchSpec>, String> {
    let config = merged_config(root)?;
    let models = config.get("models").and_then(Value::as_object);
    let alias = match models.and_then(|value| value.get("web_search")) {
        Some(Value::String(value)) if !value.trim().is_empty() => value.trim().to_string(),
        Some(Value::Bool(true)) => "web_search".to_string(),
        _ => return Ok(None),
    };
    let model_table = config
        .get("model")
        .and_then(Value::as_object)
        .and_then(|value| value.get(&alias))
        .and_then(Value::as_object);
    let api_key = resolve_key(model_table).ok_or_else(|| {
        "已启用 web_search，但所选模型没有 API Key；请在模型设置中直接填写 API Key。".to_string()
    })?;
    let base_url = string_value(model_table, "base_url")
        .or_else(|| env::var("MELODY_WEB_SEARCH_BASE_URL").ok())
        .unwrap_or_else(|| "https://api.x.ai/v1".to_string());
    let base_url = public_https_url(&base_url, "web_search base_url")?;
    let endpoint = Url::parse(&format!(
        "{}/responses",
        base_url.as_str().trim_end_matches('/')
    ))
    .map_err(|error| format!("web_search endpoint 无效：{error}"))?;
    let model = string_value(model_table, "model")
        .or_else(|| env::var("MELODY_WEB_SEARCH_MODEL").ok())
        .unwrap_or(alias);
    if model.len() > 512 {
        return Err("web_search 模型标识超过 512 字节限制。".to_string());
    }
    let global = models;
    Ok(Some(WebSearchSpec {
        endpoint,
        api_key,
        model,
        headers: collect_headers(global, model_table)?,
    }))
}

fn domain_pattern(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if value.is_empty() || value.len() > 253 || value.contains('/') || value.contains(':') {
        return None;
    }
    if value.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return None;
    }
    Some(value)
}

fn configured_domains(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(domain_pattern)
        .take(MAX_ALLOWED_DOMAINS)
        .collect()
}

fn web_fetch_policy(root: &Path) -> Result<WebFetchPolicy, String> {
    let config = merged_config(root)?;
    let features = config.get("features").and_then(Value::as_object);
    let toolset = config.get("toolset").and_then(Value::as_object);
    let fetch = toolset
        .and_then(|value| value.get("web_fetch"))
        .and_then(Value::as_object);
    let enabled = features
        .and_then(|value| value.get("web_fetch"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || fetch.is_some_and(|value| {
            value.get("enabled").and_then(Value::as_bool) != Some(false)
                && (!value.is_empty() || value.get("enabled").is_some())
        });
    if !enabled {
        return Ok(WebFetchPolicy {
            enabled: false,
            allowed_domains: Vec::new(),
            proxy_endpoint: None,
            timeout: Duration::from_secs(DEFAULT_FETCH_TIMEOUT_SECS),
            max_content_bytes: DEFAULT_FETCH_MAX_CONTENT_BYTES,
            max_text_bytes: DEFAULT_FETCH_MAX_TEXT_BYTES,
            allow_local: false,
        });
    }
    let allowed_domains = configured_domains(fetch.and_then(|value| value.get("allowed_domains")));
    let proxy_endpoint = string_value(fetch, "proxy_endpoint")
        .map(|value| public_https_url(&value, "web_fetch proxy_endpoint"))
        .transpose()?;
    let timeout_secs = positive_u64(fetch, "timeout_secs")
        .unwrap_or(DEFAULT_FETCH_TIMEOUT_SECS)
        .min(MAX_FETCH_TIMEOUT_SECS);
    let max_content_bytes = positive_u64(fetch, "max_content_length")
        .unwrap_or(DEFAULT_FETCH_MAX_CONTENT_BYTES as u64)
        .min(MAX_RESPONSE_BYTES as u64) as usize;
    let max_text_bytes = positive_u64(fetch, "max_markdown_length")
        .unwrap_or(DEFAULT_FETCH_MAX_TEXT_BYTES as u64)
        .min(MAX_SEARCH_OUTPUT_BYTES as u64) as usize;
    Ok(WebFetchPolicy {
        enabled: true,
        allowed_domains,
        proxy_endpoint,
        timeout: Duration::from_secs(timeout_secs),
        max_content_bytes,
        max_text_bytes,
        allow_local: bool_value(fetch, "allow_local").unwrap_or(false),
    })
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.octets() == [169, 254, 169, 254]
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.segments()[0] & 0xfe00 == 0xfc00
                || ip.segments()[0] & 0xffc0 == 0xfe80
        }
    }
}

fn validate_fetch_url(
    candidate: &str,
    allow_local: bool,
    allowed_domains: &[String],
) -> Result<Url, String> {
    if candidate.len() > MAX_URL_BYTES {
        return Err("web_fetch URL 超过 4 KB 限制。".to_string());
    }
    let url =
        Url::parse(candidate.trim()).map_err(|error| format!("web_fetch URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("web_fetch 只允许无凭据/片段的 HTTP(S) URL。".to_string());
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host_allowed = allowed_domains.is_empty()
        || allowed_domains
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if !host_allowed {
        return Err(format!("web_fetch 域名不在允许列表中：{host}"));
    }
    let local_name =
        host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local");
    let ip_private = host.parse::<IpAddr>().map(is_private_ip).unwrap_or(false);
    if (local_name || ip_private) && !allow_local {
        return Err("web_fetch 默认拒绝本机、私网、链路本地和云元数据地址。".to_string());
    }
    // Even when a user explicitly enables local access, never permit cloud
    // metadata or multicast targets; those are not useful for a browser-like
    // fetch and are a common SSRF escape hatch.
    if host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(value) => value.octets() == [169, 254, 169, 254] || value.is_multicast(),
        IpAddr::V6(value) => value.is_multicast(),
    }) {
        return Err("web_fetch 拒绝云元数据或组播地址。".to_string());
    }
    Ok(url)
}

fn build_search_body(spec: &WebSearchSpec, query: &str, allowed_domains: &[String]) -> Value {
    let mut tool = json!({"type": "web_search"});
    if !allowed_domains.is_empty() {
        tool["filters"] = json!({"allowed_domains": allowed_domains});
    }
    json!({
        "model": spec.model,
        "input": query,
        "tools": [tool],
        "store": false,
        "temperature": 0.1,
        "top_p": 0.95,
        "max_output_tokens": 8192,
    })
}

async fn search(root: &Path, arguments: &Map<String, Value>) -> Result<String, String> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_QUERY_BYTES)
        .ok_or_else(|| "web_search query 必须是 1 到 2000 字节的文本。".to_string())?;
    let allowed_domains = configured_domains(arguments.get("allowedDomains"));
    let Some(spec) = web_search_spec(root)? else {
        return Err("当前未配置 web_search 模型；请在设置中配置 models.web_search。".to_string());
    };
    let mut request_headers = header::HeaderMap::new();
    for (name, value) in &spec.headers {
        request_headers.insert(
            header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?,
            header::HeaderValue::from_str(value).map_err(|error| error.to_string())?,
        );
    }
    let builder = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("MelodyWork/Pi-web-search")
        .default_headers(request_headers);
    let client = builder
        .build()
        .map_err(|error| format!("无法创建 web_search 客户端：{error}"))?;
    let response = client
        .post(spec.endpoint.clone())
        .bearer_auth(&spec.api_key)
        .json(&build_search_body(&spec, query, &allowed_domains))
        .send()
        .await
        .map_err(|error| format!("web_search 请求失败：{error}"))?;
    read_json_response(response, "web_search")
        .await
        .map(format_search_output)
}

async fn fetch(root: &Path, arguments: &Map<String, Value>) -> Result<String, String> {
    let policy = web_fetch_policy(root)?;
    if !policy.enabled {
        return Err("当前未启用 web_fetch；请在设置中打开网页读取。".to_string());
    }
    let candidate = arguments
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "web_fetch url 必须是非空字符串。".to_string())?;
    let url = validate_fetch_url(candidate, policy.allow_local, &policy.allowed_domains)?;
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(policy.timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("MelodyWork/Pi-web-fetch");
    if let Some(proxy) = policy.proxy_endpoint {
        builder = builder
            .proxy(Proxy::all(proxy).map_err(|error| format!("web_fetch proxy 无效：{error}"))?);
    }
    let client = builder
        .build()
        .map_err(|error| format!("无法创建 web_fetch 客户端：{error}"))?;
    let response = client
        .get(url.clone())
        .header(
            header::ACCEPT,
            "text/html, text/plain, text/markdown, application/xhtml+xml;q=0.9",
        )
        .send()
        .await
        .map_err(|error| format!("web_fetch 请求失败：{error}"))?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = read_bounded_body(response, policy.max_content_bytes, "web_fetch").await?;
    let body =
        String::from_utf8(bytes).map_err(|_| "web_fetch 返回了非 UTF-8 内容。".to_string())?;
    let text = if content_type.contains("html") || content_type.contains("xhtml") {
        html_to_text(&body, policy.max_text_bytes)
    } else {
        bounded_text(body, policy.max_text_bytes)
    };
    Ok(format!("URL: {url}\n\n{text}"))
}

async fn read_bounded_body(
    response: reqwest::Response,
    limit: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "{label} 返回 HTTP {}。",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("{label} 响应超过大小限制。"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 {label} 响应失败：{error}"))?;
    if bytes.len() > limit {
        return Err(format!("{label} 响应超过大小限制。"));
    }
    Ok(bytes.to_vec())
}

async fn read_json_response(response: reqwest::Response, label: &str) -> Result<Value, String> {
    if response.status() == StatusCode::UNAUTHORIZED {
        let body = bounded_text(
            response.text().await.unwrap_or_default(),
            MAX_ERROR_BODY_BYTES,
        );
        return Err(format!("{label} 认证失败（401）：{body}"));
    }
    let bytes = read_bounded_body(response, MAX_RESPONSE_BYTES, label).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析 {label} 响应失败：{error}"))
}

pub(crate) async fn resolve_request(root: &Path, value: &Value) -> Result<String, String> {
    let (tool_name, arguments) = pi_tool_gateway::tool_request_arguments(value)?;
    match tool_name {
        WEB_SEARCH => search(root, arguments).await,
        WEB_FETCH => fetch(root, arguments).await,
        _ => Err(format!("未知 web 工具：{tool_name}")),
    }
}
