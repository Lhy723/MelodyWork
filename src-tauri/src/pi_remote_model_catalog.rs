//! Remote model catalog endpoint policy, bounded fetch/parsing, and cache fallback.
//!
//! This module does not project Pi provider configuration or resolve provider
//! credentials. It returns validated catalog records to the Host model
//! projection, which remains the only writer of the worker-facing catalog.

use std::{
    env,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config_io::TextFileStore;

use super::{DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PI_MODELS_LIMIT_BYTES};

const GENERATED_REMOTE_CATALOG_FILE: &str = "melody-remote-models.json";
const REMOTE_CATALOG_TIMEOUT_SECS: u64 = 15;
const REMOTE_CATALOG_MAX_BYTES: usize = 4 * 1024 * 1024;
const REMOTE_CATALOG_MAX_MODELS: usize = 1024;
const MAX_ENDPOINT_URL_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(super) struct RemoteModel {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) base_url: String,
    pub(super) api_backend: String,
    pub(super) context_window: u64,
    pub(super) max_completion_tokens: u64,
    pub(super) reasoning: bool,
    pub(super) input: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct RemoteCatalogCache {
    version: u8,
    origin: String,
    fetched_at: u64,
    models: Vec<RemoteModel>,
}

#[derive(Default)]
pub(super) struct ResolvedRemoteCatalog {
    pub(super) models: Vec<RemoteModel>,
    // Deliberately no Debug implementation: this may contain a remote API key.
    pub(super) api_key: Option<String>,
}

pub(super) async fn resolve_remote_catalog(
    user: &toml::Table,
    project: &toml::Table,
    home: &Path,
) -> Result<ResolvedRemoteCatalog, String> {
    let mut resolved = ResolvedRemoteCatalog::default();
    if !remote_fetch_enabled(user, project) {
        return Ok(resolved);
    }
    let Some(endpoint) = remote_catalog_url(user, project)? else {
        return Ok(resolved);
    };

    let default_base_url = remote_inference_base_url(user, project, &endpoint)?;
    resolved.api_key = remote_catalog_api_key(user, project);
    match fetch_remote_catalog(&endpoint, &default_base_url, resolved.api_key.as_deref()).await {
        Ok(models) => {
            persist_remote_catalog_cache(home, &endpoint, &models);
            resolved.models = models;
        }
        Err(_) => {
            resolved.models = load_remote_catalog_cache(home, &endpoint);
        }
    }
    Ok(resolved)
}

pub(super) fn remote_fetch_enabled(user: &toml::Table, project: &toml::Table) -> bool {
    let mut enabled = true;
    for scope in [user, project] {
        if let Some(value) = scope
            .get("features")
            .and_then(toml::Value::as_table)
            .and_then(|features| features.get("remote_fetch"))
            .and_then(toml::Value::as_bool)
        {
            enabled = value;
        }
    }
    if let Ok(value) = env::var("MELODY_PI_ALLOW_MODEL_NETWORK") {
        match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => enabled = true,
            "0" | "false" | "no" | "off" => enabled = false,
            _ => {}
        }
    }
    enabled
}

fn endpoint_string(user: &toml::Table, project: &toml::Table, key: &str) -> Option<String> {
    let mut result = env::var(match key {
        "models_list_url" => "MELODY_MODELS_LIST_URL",
        "models_base_url" => "MELODY_MODELS_BASE_URL",
        _ => return None,
    })
    .ok()
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty());
    for scope in [user, project] {
        if let Some(value) = scope
            .get("endpoints")
            .and_then(toml::Value::as_table)
            .and_then(|endpoints| endpoints.get(key))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            result = Some(value.to_owned());
        }
    }
    result
}

pub(super) fn remote_catalog_url(
    user: &toml::Table,
    project: &toml::Table,
) -> Result<Option<String>, String> {
    let explicit = endpoint_string(user, project, "models_list_url");
    let base = endpoint_string(user, project, "models_base_url");
    let Some(candidate) =
        explicit.or_else(|| base.map(|value| format!("{}/models", value.trim_end_matches('/'))))
    else {
        // With no custom endpoint, Pi's native signed catalog is the source of
        // truth. Do not make a second request to an inferred public URL.
        return Ok(None);
    };
    validate_public_https_url(&candidate, "在线模型目录地址")?;
    Ok(Some(candidate))
}

fn remote_inference_base_url(
    user: &toml::Table,
    project: &toml::Table,
    endpoint: &str,
) -> Result<String, String> {
    if let Some(base) = endpoint_string(user, project, "models_base_url") {
        validate_public_https_url(&base, "模型接口地址")?;
        return Ok(base.trim_end_matches('/').to_string());
    }
    let mut url = Url::parse(endpoint).map_err(|error| format!("在线模型目录地址无效：{error}"))?;
    let path = url.path().trim_end_matches('/').to_string();
    let path = path.strip_suffix("/models").unwrap_or(&path).to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn remote_catalog_api_key(user: &toml::Table, project: &toml::Table) -> Option<String> {
    // A remote catalog is an arbitrary configured endpoint. Never reuse a
    // provider-specific ambient key (for example XAI_API_KEY) for it; only an
    // explicit catalog key may cross this request boundary.
    for name in ["MELODY_MODELS_API_KEY"] {
        if let Ok(value) = env::var(name).map(|value| value.trim().to_owned())
            && !value.is_empty()
        {
            return Some(value);
        }
    }
    for scope in [user, project] {
        let endpoint_key = scope
            .get("endpoints")
            .and_then(toml::Value::as_table)
            .and_then(|endpoints| endpoints.get("models_api_key"))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if endpoint_key.is_some() {
            return endpoint_key.map(ToOwned::to_owned);
        }
    }
    None
}

fn validate_public_https_url(candidate: &str, label: &str) -> Result<Url, String> {
    if candidate.len() > MAX_ENDPOINT_URL_BYTES {
        return Err(format!("{label}超过 4 KB 限制。"));
    }
    let url = Url::parse(candidate.trim()).map_err(|error| format!("{label}无效：{error}"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(format!("{label}必须是无凭据/片段的 HTTPS 地址。"));
    }
    Ok(url)
}

async fn fetch_remote_catalog(
    endpoint: &str,
    default_base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<RemoteModel>, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(REMOTE_CATALOG_TIMEOUT_SECS))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法创建在线模型目录客户端：{error}"))?;
    let mut request = client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(api_key) = api_key.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("在线模型目录请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("在线模型目录返回 HTTP {}。", response.status()));
    }
    let bytes = bounded_response_bytes(&mut response, REMOTE_CATALOG_MAX_BYTES).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("在线模型目录不是有效 JSON：{error}"))?;
    parse_remote_models(&value, default_base_url)
}

async fn bounded_response_bytes(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "在线模型目录响应超过 {} MB 限制。",
            limit / 1024 / 1024
        ));
    }
    let mut result = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取在线模型目录响应失败：{error}"))?
    {
        if result.len().saturating_add(chunk.len()) > limit {
            return Err(format!(
                "在线模型目录响应超过 {} MB 限制。",
                limit / 1024 / 1024
            ));
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}

fn remote_field<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

fn remote_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    remote_field(object, keys)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn remote_u64(object: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    remote_field(object, keys).and_then(Value::as_u64)
}

pub(super) fn parse_remote_models(
    value: &Value,
    default_base_url: &str,
) -> Result<Vec<RemoteModel>, String> {
    let values = match value {
        Value::Array(values) => values,
        Value::Object(object) => remote_field(object, &["data", "models"])
            .and_then(Value::as_array)
            .ok_or_else(|| "在线模型目录缺少 data/models 数组。".to_string())?,
        _ => return Err("在线模型目录根节点必须是对象或数组。".to_string()),
    };
    if values.len() > REMOTE_CATALOG_MAX_MODELS {
        return Err(format!(
            "在线模型目录包含超过 {REMOTE_CATALOG_MAX_MODELS} 个模型。"
        ));
    }
    let mut models = Vec::with_capacity(values.len());
    for value in values {
        let Some(object) = value.as_object() else {
            continue;
        };
        if remote_field(object, &["hidden", "isHidden"])
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(id) = remote_string(object, &["model", "modelId", "id"]) else {
            continue;
        };
        if id.len() > 512 {
            continue;
        }
        let base_url = remote_string(
            object,
            &["baseUrl", "base_url", "apiBaseUrl", "api_base_url"],
        )
        .unwrap_or_else(|| default_base_url.to_string());
        if validate_public_https_url(&base_url, "远程模型接口地址").is_err() {
            continue;
        }
        let api_backend =
            match remote_string(object, &["apiBackend", "api_backend", "api"]).as_deref() {
                Some("responses") | Some("openai-responses") => "responses",
                Some("messages") | Some("anthropic-messages") => "messages",
                Some("chat_completions") | Some("openai-completions") | None => "chat_completions",
                Some(_) => continue,
            };
        let input = match remote_field(object, &["input", "modalities"]).and_then(Value::as_array) {
            Some(values) => {
                let mut input = Vec::new();
                for value in values {
                    if let Some(value) = value.as_str().map(str::trim)
                        && (value == "text" || value == "image")
                        && !input.iter().any(|item| item == value)
                    {
                        input.push(value.to_string());
                    }
                }
                if !input.iter().any(|value| value == "text") {
                    continue;
                }
                input
            }
            None => vec!["text".to_string()],
        };
        let context_window = remote_u64(object, &["contextWindow", "context_window"])
            .filter(|value| *value > 0 && *value <= i64::MAX as u64)
            .unwrap_or(DEFAULT_CONTEXT_WINDOW);
        let max_completion_tokens = remote_u64(
            object,
            &[
                "maxCompletionTokens",
                "max_completion_tokens",
                "maxTokens",
                "max_tokens",
            ],
        )
        .filter(|value| *value > 0 && *value <= i64::MAX as u64)
        .unwrap_or(DEFAULT_MAX_TOKENS);
        let reasoning = remote_field(
            object,
            &[
                "reasoning",
                "supportsReasoningEffort",
                "supports_reasoning_effort",
            ],
        )
        .and_then(Value::as_bool)
        .unwrap_or(false);
        models.push(RemoteModel {
            id: id.clone(),
            name: remote_string(object, &["name", "displayName", "display_name"]).unwrap_or(id),
            base_url,
            api_backend: api_backend.to_string(),
            context_window,
            max_completion_tokens,
            reasoning,
            input,
        });
    }
    if models.is_empty() {
        return Err("在线模型目录没有可用模型。".to_string());
    }
    Ok(models)
}

fn remote_cache_path(home: &Path) -> PathBuf {
    home.join("pi").join(GENERATED_REMOTE_CATALOG_FILE)
}

fn persist_remote_catalog_cache(home: &Path, origin: &str, models: &[RemoteModel]) {
    let cache = RemoteCatalogCache {
        version: 1,
        origin: origin.to_string(),
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
        models: models.to_vec(),
    };
    let path = remote_cache_path(home);
    let Ok(content) = serde_json::to_string_pretty(&cache) else {
        return;
    };
    if content.len() > PI_MODELS_LIMIT_BYTES as usize {
        return;
    }
    let store = TextFileStore::with_limit_description(
        &path,
        PI_MODELS_LIMIT_BYTES,
        "the 1 MB remote model catalog cache limit",
    );
    let _ = store.write_text(&content, "Pi remote model catalog cache");
}

fn load_remote_catalog_cache(home: &Path, origin: &str) -> Vec<RemoteModel> {
    let path = remote_cache_path(home);
    let store = TextFileStore::with_limit_description(
        &path,
        PI_MODELS_LIMIT_BYTES,
        "the 1 MB remote model catalog cache limit",
    );
    let Ok(Some(content)) = store.read_text("Pi remote model catalog cache") else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_str::<RemoteCatalogCache>(&content) else {
        return Vec::new();
    };
    if cache.version != 1
        || cache.origin != origin
        || cache.models.len() > REMOTE_CATALOG_MAX_MODELS
    {
        return Vec::new();
    }
    cache.models
}
