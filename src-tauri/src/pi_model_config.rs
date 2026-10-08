//! Projection of Melody's model configuration into Pi's `models.json` format.
//!
//! Melody and Pi intentionally keep different configuration formats.  The
//! renderer continues to edit `.melody/config.toml`; the Pi worker receives a
//! generated, app-owned catalog at launch.  Secrets are never written to that
//! catalog.  They are resolved once by the Host and injected into the worker
//! under short-lived, generated environment variable names instead.

use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::config_io::TextFileStore;
use crate::config_runtime::MAX_CONFIG_BYTES;
use reqwest::{Client, Url, redirect::Policy};

const PI_MODELS_LIMIT_BYTES: u64 = 1024 * 1024;
const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
const DEFAULT_MAX_TOKENS: u64 = 16_384;
const GENERATED_MODELS_FILE: &str = "melody-models.json";
const GENERATED_POLICIES_FILE: &str = "melody-model-policies.json";
const GENERATED_REMOTE_CATALOG_FILE: &str = "melody-remote-models.json";
const GENERATED_SECRET_PREFIX: &str = "MELODY_PI_MODEL_";
const MAX_PI_IDLE_TIMEOUT_SECS: u64 = 2_147_483;
const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT: u8 = 85;
const REMOTE_CATALOG_TIMEOUT_SECS: u64 = 15;
const REMOTE_CATALOG_MAX_BYTES: usize = 4 * 1024 * 1024;
const REMOTE_CATALOG_MAX_MODELS: usize = 1024;
const MAX_ENDPOINT_URL_BYTES: usize = 4096;

/// Host-side values that must be added after the worker environment is
/// cleared.  This type deliberately does not implement `Debug` so a future
/// diagnostic cannot accidentally print model credentials.
pub(crate) struct PreparedPiModels {
    pub(crate) path: PathBuf,
    pub(crate) policies_path: PathBuf,
    pub(crate) provider_ids: Vec<String>,
    pub(crate) credentials: Vec<(String, String)>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct RemoteModel {
    id: String,
    name: String,
    base_url: String,
    api_backend: String,
    context_window: u64,
    max_completion_tokens: u64,
    reasoning: bool,
    input: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct RemoteCatalogCache {
    version: u8,
    origin: String,
    fetched_at: u64,
    models: Vec<RemoteModel>,
}

#[derive(Default)]
struct Projection {
    providers: Map<String, Value>,
    default_policy: Option<PiModelPolicy>,
    policies: BTreeMap<String, PiModelPolicy>,
    provider_ids: Vec<String>,
    credentials: Vec<(String, String)>,
}

/// Per-model request policy that Pi's public `SettingsManager` can apply to a
/// session.  It deliberately contains no credentials or arbitrary request
/// fields; the Host validates the values before writing the snapshot.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiModelPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) max_retries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) inference_idle_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) auto_compact_threshold_percent: Option<u8>,
}

/// Build and persist the worker catalog from user and project config.
///
/// The generated file is always rewritten when Pi is started.  This matters
/// when a user removes the last custom model: leaving an old file in place
/// would make a deleted model reappear in the Pi picker.  An explicit
/// `MELODY_PI_MODELS_PATH` remains a development/managed override and skips
pub(crate) async fn prepare_pi_models_with_remote(
    cwd: &Path,
    home: &Path,
) -> Result<PreparedPiModels, String> {
    let (user, project) = read_model_configs(cwd, home)?;
    let mut remote_models = Vec::new();
    let mut remote_api_key = None;
    if remote_fetch_enabled(&user, &project) {
        if let Some(endpoint) = remote_catalog_url(&user, &project)? {
            let default_base_url = remote_inference_base_url(&user, &project, &endpoint)?;
            remote_api_key = remote_catalog_api_key(&user, &project);
            match fetch_remote_catalog(&endpoint, &default_base_url, remote_api_key.as_deref())
                .await
            {
                Ok(models) => {
                    persist_remote_catalog_cache(home, &endpoint, &models);
                    remote_models = models;
                }
                Err(_) => {
                    remote_models = load_remote_catalog_cache(home, &endpoint);
                }
            }
        }
    }
    let projection =
        project_projection_with_remote(&user, &project, &remote_models, remote_api_key.as_deref())?;
    write_projection(home, projection)
}

fn read_model_configs(cwd: &Path, home: &Path) -> Result<(toml::Table, toml::Table), String> {
    let user = read_config(&home.join("config.toml"), "Melody user config")?;
    let project = read_config(
        &cwd.join(".melody").join("config.toml"),
        "Melody project config",
    )?;
    Ok((user, project))
}

fn write_projection(home: &Path, projection: Projection) -> Result<PreparedPiModels, String> {
    let path = home.join("pi").join(GENERATED_MODELS_FILE);
    let content = serde_json::to_string_pretty(&json!({
        "providers": projection.providers,
    }))
    .map_err(|error| format!("Failed to encode Pi model catalog: {error}"))?;
    let store = TextFileStore::with_limit_description(
        &path,
        PI_MODELS_LIMIT_BYTES,
        "the 1 MB Pi model catalog limit",
    );
    store.write_text(&content, "Pi model catalog")?;
    let policies_path = home.join("pi").join(GENERATED_POLICIES_FILE);
    let mut policy_document = Map::new();
    policy_document.insert("version".into(), Value::from(1));
    if let Some(default_policy) = projection.default_policy {
        policy_document.insert(
            "default".into(),
            serde_json::to_value(default_policy)
                .map_err(|error| format!("Failed to encode Pi model default policy: {error}"))?,
        );
    }
    policy_document.insert(
        "models".into(),
        serde_json::to_value(projection.policies)
            .map_err(|error| format!("Failed to encode Pi model policies: {error}"))?,
    );
    let policies_content = serde_json::to_string_pretty(&Value::Object(policy_document))
        .map_err(|error| format!("Failed to encode Pi model policies: {error}"))?;
    let policy_store = TextFileStore::with_limit_description(
        &policies_path,
        PI_MODELS_LIMIT_BYTES,
        "the 1 MB Pi model policy limit",
    );
    policy_store.write_text(&policies_content, "Pi model policies")?;
    Ok(PreparedPiModels {
        path,
        policies_path,
        provider_ids: projection.provider_ids,
        credentials: projection.credentials,
    })
}

fn read_config(path: &Path, label: &str) -> Result<toml::Table, String> {
    let store =
        TextFileStore::with_limit_description(path, MAX_CONFIG_BYTES, "the 1 MB editor limit");
    let Some(content) = store.read_text(label)? else {
        return Ok(toml::Table::new());
    };
    if content.trim().is_empty() {
        return Ok(toml::Table::new());
    }
    let value = toml::from_str::<toml::Value>(&content)
        .map_err(|error| format!("{label} contains invalid TOML: {error}"))?;
    value
        .as_table()
        .cloned()
        .ok_or_else(|| format!("{label} must contain a TOML table"))
}

fn remote_fetch_enabled(user: &toml::Table, project: &toml::Table) -> bool {
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

fn remote_catalog_url(user: &toml::Table, project: &toml::Table) -> Result<Option<String>, String> {
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

fn parse_remote_models(value: &Value, default_base_url: &str) -> Result<Vec<RemoteModel>, String> {
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

fn remote_alias(model_id: &str, base_url: &str, models: &BTreeMap<String, toml::Table>) -> String {
    let mut slug = String::from("remote-");
    for character in model_id.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            slug.push(character.to_ascii_lowercase());
        } else {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    slug.push('-');
    slug.push_str(&format!(
        "{:016x}",
        fnv1a(format!("{base_url}\0{model_id}").as_bytes())
    ));
    if !models.contains_key(&slug) {
        return slug;
    }
    let mut index = 2;
    loop {
        let candidate = format!("{slug}-{index}");
        if !models.contains_key(&candidate) {
            return candidate;
        }
        index += 1;
    }
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

/// Project the user/project configs without a remote catalog.
///
/// Test-only: production always goes through `project_projection_with_remote`,
/// which applies the remote-model policy before writing the catalog.
#[cfg(test)]
fn project_projection(user: &toml::Table, project: &toml::Table) -> Result<Projection, String> {
    project_projection_with_remote(user, project, &[], None)
}

fn project_projection_with_remote(
    user: &toml::Table,
    project: &toml::Table,
    remote_models: &[RemoteModel],
    remote_api_key: Option<&str>,
) -> Result<Projection, String> {
    let mut models: BTreeMap<String, toml::Table> = BTreeMap::new();
    let mut global = toml::Table::new();
    let mut session = toml::Table::new();
    for scope in [user, project] {
        if let Some(table) = scope.get("models").and_then(toml::Value::as_table) {
            merge_table(&mut global, table);
        }
        if let Some(table) = scope.get("session").and_then(toml::Value::as_table) {
            merge_table(&mut session, table);
        }
        if let Some(table) = scope.get("model").and_then(toml::Value::as_table) {
            for (alias, value) in table {
                let Some(model) = value.as_table() else {
                    return Err(format!("[model.{alias}] must be a TOML table"));
                };
                merge_table(models.entry(alias.clone()).or_default(), model);
            }
        }
    }

    // Local user/project models are authoritative.  A remote model that
    // resolves to an existing model id is therefore ignored instead of
    // shadowing a configured endpoint or credential.  The generated alias
    // includes a stable endpoint/model hash so a provider rename does not
    // orphan an existing Pi session binding.
    let local_model_ids = models
        .values()
        .filter_map(|model| string_value(model, "model"))
        .collect::<std::collections::HashSet<_>>();
    for remote in remote_models {
        if local_model_ids.contains(&remote.id) {
            continue;
        }
        let alias = remote_alias(&remote.id, &remote.base_url, &models);
        let mut model = toml::Table::new();
        model.insert("model".into(), toml::Value::String(remote.id.clone()));
        model.insert("name".into(), toml::Value::String(remote.name.clone()));
        model.insert(
            "base_url".into(),
            toml::Value::String(remote.base_url.clone()),
        );
        model.insert(
            "api_backend".into(),
            toml::Value::String(remote.api_backend.clone()),
        );
        model.insert(
            "context_window".into(),
            toml::Value::Integer(remote.context_window as i64),
        );
        model.insert(
            "max_completion_tokens".into(),
            toml::Value::Integer(remote.max_completion_tokens as i64),
        );
        model.insert("reasoning".into(), toml::Value::Boolean(remote.reasoning));
        model.insert(
            "input".into(),
            toml::Value::Array(
                remote
                    .input
                    .iter()
                    .cloned()
                    .map(toml::Value::String)
                    .collect(),
            ),
        );
        if let Some(api_key) = remote_api_key.filter(|value| !value.is_empty()) {
            model.insert("api_key".into(), toml::Value::String(api_key.to_string()));
        }
        models.insert(alias, model);
    }

    let mut projection = Projection::default();
    projection.default_policy = model_policy(&toml::Table::new(), &global, &session, "default")?;
    for (credential_index, (alias, model)) in models.iter().enumerate() {
        let provider_id = provider_id(alias);
        let api = api_for(model, alias)?;
        let base_url = required_string(model, "base_url", alias)?;
        let mut provider = Map::new();
        provider.insert("name".into(), Value::String(display_name(model, alias)));
        provider.insert("baseUrl".into(), Value::String(base_url));
        provider.insert("api".into(), Value::String(api.clone()));

        // Pi resolves authentication and provider-wide headers through the
        // provider entry.  Keeping these at model level would make the
        // generated catalog fail validation (and, for API keys, would never
        // reach the request adapter).  References point to short-lived Host
        // environment variables; the JSON file itself never contains a
        // credential value.
        let mut credentials = CredentialWriter::new(credential_index);
        if let Some(secret) = resolve_api_key(alias, model) {
            provider.insert(
                "apiKey".into(),
                Value::String(credentials.reference("KEY", secret, &mut projection.credentials)),
            );
        }

        let headers = merged_headers(
            global.get("extra_headers").and_then(toml::Value::as_table),
            model.get("extra_headers").and_then(toml::Value::as_table),
        )?;
        if !headers.is_empty() {
            let mut header_values = Map::new();
            for (header, value) in headers {
                let reference = credentials.reference("HEADER", value, &mut projection.credentials);
                header_values.insert(header, Value::String(reference));
            }
            provider.insert("headers".into(), Value::Object(header_values));
        }

        let model_id = string_value(model, "model").unwrap_or_else(|| alias.to_string());
        if model_id.is_empty() {
            return Err(format!("[model.{alias}] 的 model 不能为空"));
        }
        let input = input_modalities(model, &global, alias)?;
        let policy = model_policy(model, &global, &session, alias)?;
        let mut pi_model = Map::new();
        pi_model.insert("id".into(), Value::String(model_id.clone()));
        pi_model.insert("name".into(), Value::String(display_name(model, alias)));
        pi_model.insert(
            "reasoning".into(),
            Value::Bool(bool_value(model, "reasoning").unwrap_or(false)),
        );
        pi_model.insert(
            "input".into(),
            Value::Array(input.into_iter().map(Value::String).collect()),
        );
        pi_model.insert(
            "contextWindow".into(),
            Value::Number(json_number(
                positive_value(model, "context_window")
                    .or_else(|| positive_value(&global, "context_window"))
                    .unwrap_or(DEFAULT_CONTEXT_WINDOW),
            )),
        );
        pi_model.insert(
            "maxTokens".into(),
            Value::Number(json_number(
                positive_value(model, "max_completion_tokens")
                    .or_else(|| positive_value(&global, "max_completion_tokens"))
                    .unwrap_or(DEFAULT_MAX_TOKENS),
            )),
        );
        if let Some(sampling_params) = sampling_params(model, &global) {
            pi_model.insert("samplingParams".into(), Value::Object(sampling_params));
        }
        pi_model.insert(
            "cost".into(),
            json!({
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
            }),
        );

        if api == "openai-completions" || api == "openai-responses" {
            provider.insert("authHeader".into(), Value::Bool(true));
        }
        provider.insert("models".into(), Value::Array(vec![Value::Object(pi_model)]));
        if let Some(policy) = policy {
            projection
                .policies
                .insert(format!("{provider_id}/{model_id}"), policy);
        }
        projection.provider_ids.push(provider_id.clone());
        projection
            .providers
            .insert(provider_id, Value::Object(provider));
    }
    Ok(projection)
}

fn merge_table(target: &mut toml::Table, source: &toml::Table) {
    for (key, value) in source {
        if let (Some(existing), Some(incoming)) = (target.get_mut(key), value.as_table()) {
            if let Some(existing_table) = existing.as_table_mut() {
                merge_table(existing_table, incoming);
                continue;
            }
        }
        target.insert(key.clone(), value.clone());
    }
}

fn string_value(table: &toml::Table, key: &str) -> Option<String> {
    table
        .get(key)
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn required_string(table: &toml::Table, key: &str, alias: &str) -> Result<String, String> {
    string_value(table, key)
        .ok_or_else(|| format!("[model.{alias}] 缺少 {key}；Pi 需要明确的接口地址"))
}

fn bool_value(table: &toml::Table, key: &str) -> Option<bool> {
    table.get(key).and_then(toml::Value::as_bool)
}

fn positive_value(table: &toml::Table, key: &str) -> Option<u64> {
    table
        .get(key)
        .and_then(toml::Value::as_integer)
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn nonnegative_value(table: &toml::Table, key: &str) -> Option<u64> {
    table
        .get(key)
        .and_then(toml::Value::as_integer)
        .and_then(|value| u64::try_from(value).ok())
}

fn percentage_value(table: &toml::Table, key: &str, alias: &str) -> Result<Option<u8>, String> {
    let Some(value) = table.get(key) else {
        return Ok(None);
    };
    let Some(raw) = value.as_integer() else {
        return Err(format!("[model.{alias}] 的 {key} 必须是 0 到 100 的整数"));
    };
    u8::try_from(raw)
        .ok()
        .filter(|value| *value <= 100)
        .map(Some)
        .ok_or_else(|| format!("[model.{alias}] 的 {key} 必须是 0 到 100 的整数"))
}

/// Resolve the request policy with the same model-over-global precedence used
/// for sampling and token limits.  Pi's HTTP timeout is an `i32`-compatible
/// duration internally, so reject values that cannot be represented instead
/// of silently wrapping or changing the user's configured timeout.
fn model_policy(
    model: &toml::Table,
    global: &toml::Table,
    session: &toml::Table,
    alias: &str,
) -> Result<Option<PiModelPolicy>, String> {
    let max_retries = nonnegative_value(model, "max_retries")
        .or_else(|| nonnegative_value(global, "max_retries"));
    let timeout_secs = positive_value(model, "inference_idle_timeout_secs")
        .or_else(|| positive_value(global, "inference_idle_timeout_secs"));
    let inference_idle_timeout_ms = match timeout_secs {
        Some(seconds) if seconds <= MAX_PI_IDLE_TIMEOUT_SECS => Some(seconds * 1000),
        Some(seconds) => {
            return Err(format!(
                "[model.{alias}] 的 inference_idle_timeout_secs={seconds} 不能超过 {MAX_PI_IDLE_TIMEOUT_SECS} 秒"
            ));
        }
        None => None,
    };
    let auto_compact_threshold_percent =
        percentage_value(model, "auto_compact_threshold_percent", alias)?
            .or(percentage_value(
                session,
                "auto_compact_threshold_percent",
                alias,
            )?)
            .or(Some(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT));
    let policy = PiModelPolicy {
        max_retries,
        inference_idle_timeout_ms,
        auto_compact_threshold_percent,
    };
    (policy.max_retries.is_some()
        || policy.inference_idle_timeout_ms.is_some()
        || policy.auto_compact_threshold_percent.is_some())
    .then_some(policy)
    .map(Ok)
    .transpose()
}

fn finite_number(table: &toml::Table, key: &str) -> Option<f64> {
    let value = table.get(key)?;
    let number = match value {
        toml::Value::Float(value) => *value,
        toml::Value::Integer(value) => *value as f64,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// Melody exposes these two sampling controls in both the global and
/// per-model settings. Pi treats them as arbitrary provider request fields;
/// preserving them in `samplingParams` keeps OpenAI-compatible endpoints
/// behaviorally aligned while APIs that do not support them simply ignore the
/// extra fields in their adapter.
fn sampling_params(model: &toml::Table, global: &toml::Table) -> Option<Map<String, Value>> {
    let mut result = Map::new();
    for key in ["temperature", "top_p"] {
        if let Some(value) = finite_number(model, key).or_else(|| finite_number(global, key)) {
            result.insert(key.to_owned(), Value::from(value));
        }
    }
    (!result.is_empty()).then_some(result)
}

/// Project the product's explicit input-modality declaration into Pi's model
/// schema.  Custom models historically defaulted to text-only; keep that
/// behavior when the field is absent, but reject malformed declarations
/// rather than silently dropping image support (or claiming a model can
/// process text when it cannot).
fn input_modalities(
    model: &toml::Table,
    global: &toml::Table,
    alias: &str,
) -> Result<Vec<String>, String> {
    let Some(value) = model.get("input").or_else(|| global.get("input")) else {
        return Ok(vec!["text".into()]);
    };
    let Some(values) = value.as_array() else {
        return Err(format!(
            "[model.{alias}] 的 input 必须是字符串数组（text/image）"
        ));
    };
    let mut result = Vec::with_capacity(values.len());
    for item in values {
        let Some(value) = item.as_str().map(str::trim) else {
            return Err(format!("[model.{alias}] 的 input 只能包含 text 或 image"));
        };
        if value != "text" && value != "image" {
            return Err(format!(
                "[model.{alias}] 的 input 不支持 {value}，只能使用 text 或 image"
            ));
        }
        if !result.iter().any(|entry| entry == value) {
            result.push(value.to_owned());
        }
    }
    if result.is_empty() || !result.iter().any(|entry| entry == "text") {
        return Err(format!("[model.{alias}] 的 input 必须至少包含 text"));
    }
    Ok(result)
}

fn display_name(table: &toml::Table, alias: &str) -> String {
    string_value(table, "name").unwrap_or_else(|| alias.to_owned())
}

fn api_for(table: &toml::Table, alias: &str) -> Result<String, String> {
    match string_value(table, "api_backend")
        .as_deref()
        .unwrap_or("chat_completions")
    {
        "chat_completions" => Ok("openai-completions".into()),
        "responses" => Ok("openai-responses".into()),
        "messages" => Ok("anthropic-messages".into()),
        value => Err(format!("[model.{alias}] 不支持的 api_backend：{value}")),
    }
}

/// Keep the provider identity stable when another model is added or removed.
/// An ordinal looks convenient in a generated file, but deleting an earlier
/// alias would otherwise renumber every later provider and orphan its Pi
/// credential/session binding.  The short FNV-1a suffix also disambiguates
/// aliases that sanitize to the same ASCII prefix.
fn provider_id(alias: &str) -> String {
    let mut result = String::from("melody-");
    for character in alias.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            result.push(character.to_ascii_lowercase());
        } else {
            result.push('-');
        }
        if result.len() >= 48 {
            break;
        }
    }
    if result == "melody-" {
        result.push_str("model");
    }
    result.push('-');
    result.push_str(&format!("{:016x}", fnv1a(alias.as_bytes())));
    result
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn merged_headers(
    global: Option<&toml::Table>,
    model: Option<&toml::Table>,
) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    let mut keys = BTreeMap::<String, String>::new();
    for table in [global, model].into_iter().flatten() {
        for (key, value) in table {
            let Some(value) = value.as_str() else {
                return Err(format!("extra_headers 的 {key} 必须是字符串"));
            };
            let normalized = key.to_ascii_lowercase();
            if let Some(previous) = keys.insert(normalized.clone(), key.clone()) {
                result.remove(&previous);
            }
            result.insert(key.clone(), value.to_owned());
        }
    }
    Ok(result)
}

fn resolve_api_key(alias: &str, model: &toml::Table) -> Option<String> {
    if let Some(value) = string_value(model, "api_key") {
        return Some(value);
    }
    let names = match model.get("env_key") {
        Some(toml::Value::String(value)) => vec![value.clone()],
        Some(toml::Value::Array(values)) => values
            .iter()
            .filter_map(toml::Value::as_str)
            .map(ToOwned::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    let configured = names
        .into_iter()
        .filter_map(|name| env::var(name.trim()).ok())
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty());
    if configured.is_some() {
        return configured;
    }

    // The legacy ACP adapter exposed ambient xAI credentials as a convenience
    // for the built-in xAI provider.  Do not carry that fallback over to every
    // arbitrary custom endpoint: doing so would silently attach an unrelated
    // user's xAI key to a third-party model.  Keep the compatibility fallback
    // only when the alias or endpoint explicitly identifies xAI.
    let alias = alias.trim().to_ascii_lowercase();
    let endpoint = string_value(model, "base_url")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_xai = alias == "xai"
        || alias.starts_with("xai-")
        || endpoint.contains("api.x.ai")
        || endpoint.contains("api.xai.com");
    if !is_xai {
        return None;
    }
    env::var("XAI_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("MELODY_CODE_XAI_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

struct CredentialWriter {
    index: usize,
    next: usize,
}

impl CredentialWriter {
    fn new(index: usize) -> Self {
        Self { index, next: 0 }
    }

    fn reference(
        &mut self,
        kind: &str,
        value: String,
        credentials: &mut Vec<(String, String)>,
    ) -> String {
        let name = format!(
            "{GENERATED_SECRET_PREFIX}{kind}_{}_{}",
            self.index, self.next
        );
        self.next += 1;
        credentials.push((name.clone(), value));
        format!("${name}")
    }
}

fn json_number(value: u64) -> serde_json::Number {
    serde_json::Number::from(value)
}

#[cfg(test)]
mod tests {
    use super::{
        PiModelPolicy, parse_remote_models, project_projection, provider_id, read_config,
        remote_alias, remote_catalog_url, remote_fetch_enabled,
    };
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        env, fs,
        sync::{Mutex, OnceLock},
    };

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn reads_document_level_tables_from_config() {
        let root = env::temp_dir().join(format!("melody-pi-model-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        fs::write(&path, "[cli]\nenabled = true\n").unwrap();

        let config = read_config(&path, "Melody user config");
        fs::remove_dir_all(root).unwrap();

        let config = config.unwrap();
        assert_eq!(
            config
                .get("cli")
                .and_then(toml::Value::as_table)
                .and_then(|cli| cli.get("enabled"))
                .and_then(toml::Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn projects_scoped_models_without_writing_credentials() {
        let _guard = env_lock().lock().unwrap();
        unsafe {
            env::set_var("MELODY_TEST_MODEL_KEY", "secret-value");
        }
        let user = toml::from_str::<toml::Table>(
            r#"
            [models]
            max_completion_tokens = 4096
            temperature = 0.7
            top_p = 0.9
            extra_headers = { X-Org = "team" }

            [model.demo]
            model = "demo-v1"
            name = "Demo"
            base_url = "https://example.test/v1"
            env_key = "MELODY_TEST_MODEL_KEY"
            extra_headers = { x-org = "project" }
            "#,
        )
        .unwrap();
        let project = toml::Table::new();
        let projection = project_projection(&user, &project).unwrap();
        let provider = projection.providers.get(&provider_id("demo")).unwrap();
        let encoded = serde_json::to_string(provider).unwrap();
        assert!(encoded.contains("$MELODY_PI_MODEL_KEY_0_0"));
        assert!(encoded.contains("$MELODY_PI_MODEL_HEADER_0_1"));
        assert!(encoded.contains("\"temperature\":0.7"));
        assert!(encoded.contains("\"top_p\":0.9"));
        assert!(!encoded.contains("secret-value"));
        assert!(!encoded.contains("team"));
        assert!(provider.get("apiKey").is_some());
        assert!(provider.get("headers").is_some());
        assert!(provider["models"][0].get("apiKey").is_none());
        assert!(provider["models"][0].get("headers").is_none());
        assert_eq!(projection.credentials.len(), 2);
        unsafe {
            env::remove_var("MELODY_TEST_MODEL_KEY");
        }
    }

    #[test]
    fn project_scope_overlays_user_model_and_headers_case_insensitively() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            model = "user-model"
            base_url = "https://user.test/v1"
            extra_headers = { X-Org = "user", X-Trace = "trace" }
            "#,
        )
        .unwrap();
        let project = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            model = "project-model"
            extra_headers = { x-org = "project" }
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &project).unwrap();
        let provider = projection.providers.get(&provider_id("demo")).unwrap();
        let model = &provider["models"][0];
        assert_eq!(model["id"], "project-model");
        assert_eq!(provider["baseUrl"], "https://user.test/v1");
        let headers = provider["headers"].as_object().unwrap();
        assert_eq!(headers.len(), 2);
        assert!(headers.contains_key("x-org"));
        assert!(headers.contains_key("X-Trace"));
        assert!(model.get("headers").is_none());
    }

    #[test]
    fn projects_explicit_image_input_and_preserves_text_default() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [models]
            input = ["text", "image"]

            [model.vision]
            model = "vision-v1"
            base_url = "https://vision.example.test/v1"

            [model.text]
            model = "text-v1"
            base_url = "https://text.example.test/v1"
            input = ["text"]
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &toml::Table::new()).unwrap();
        let vision = projection.providers.get(&provider_id("vision")).unwrap();
        let text = projection.providers.get(&provider_id("text")).unwrap();
        assert_eq!(vision["models"][0]["input"], json!(["text", "image"]));
        assert_eq!(text["models"][0]["input"], json!(["text"]));
    }

    #[test]
    fn rejects_invalid_input_modalities() {
        for declaration in [
            "input = \"text\"",
            "input = [\"image\"]",
            "input = [\"text\", \"audio\"]",
        ] {
            let user = format!(
                "[model.demo]\nmodel = \"demo\"\nbase_url = \"https://example.test/v1\"\n{declaration}\n"
            );
            let table = toml::from_str::<toml::Table>(&user).unwrap();
            let result = project_projection(&table, &toml::Table::new());
            assert!(result.is_err(), "declaration should fail: {declaration}");
        }
    }

    #[test]
    fn rejects_missing_endpoint_instead_of_silently_routing_to_openai() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            model = "demo"
            "#,
        )
        .unwrap();
        let result = project_projection(&user, &toml::Table::new());
        assert!(matches!(result, Err(error) if error.contains("base_url")));
    }

    #[test]
    fn provider_identity_is_stable_and_disambiguates_sanitized_aliases() {
        assert_eq!(provider_id("Demo"), provider_id("Demo"));
        assert_ne!(provider_id("Demo"), provider_id("demo"));
        assert_ne!(provider_id("a/b"), provider_id("a-b"));
        assert!(provider_id("a very long model alias that keeps going").len() <= 80);
    }

    #[test]
    fn does_not_borrow_ambient_xai_key_for_unrelated_custom_provider() {
        let _guard = env_lock().lock().unwrap();
        unsafe {
            env::set_var("XAI_API_KEY", "ambient-xai-secret");
            env::set_var("MELODY_CODE_XAI_API_KEY", "legacy-xai-secret");
        }
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.open-code]
            model = "open-code-v1"
            base_url = "https://open.example.test/v1"
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &toml::Table::new()).unwrap();
        let provider = projection.providers.get(&provider_id("open-code")).unwrap();
        assert!(provider.get("apiKey").is_none());
        assert!(projection.credentials.is_empty());
        unsafe {
            env::remove_var("XAI_API_KEY");
            env::remove_var("MELODY_CODE_XAI_API_KEY");
        }
    }

    #[test]
    fn keeps_ambient_xai_key_for_explicit_xai_provider() {
        let _guard = env_lock().lock().unwrap();
        unsafe {
            env::set_var("XAI_API_KEY", "ambient-xai-secret");
        }
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.xai]
            model = "grok-4"
            base_url = "https://api.x.ai/v1"
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &toml::Table::new()).unwrap();
        let provider = projection.providers.get(&provider_id("xai")).unwrap();
        assert!(provider.get("apiKey").is_some());
        assert_eq!(projection.credentials.len(), 1);
        assert_eq!(projection.credentials[0].1, "ambient-xai-secret");
        unsafe {
            env::remove_var("XAI_API_KEY");
        }
    }

    #[test]
    fn projects_all_supported_api_backends() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.completions]
            model = "completion-v1"
            base_url = "https://example.test/v1"
            api_backend = "chat_completions"

            [model.responses]
            model = "response-v1"
            base_url = "https://example.test/v1"
            api_backend = "responses"

            [model.messages]
            model = "message-v1"
            base_url = "https://example.test/v1"
            api_backend = "messages"
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &toml::Table::new()).unwrap();
        assert_eq!(
            projection.providers[&provider_id("completions")]["api"],
            "openai-completions"
        );
        assert_eq!(
            projection.providers[&provider_id("responses")]["api"],
            "openai-responses"
        );
        assert_eq!(
            projection.providers[&provider_id("messages")]["api"],
            "anthropic-messages"
        );
    }

    #[test]
    fn projects_model_retry_policy_with_model_precedence() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [models]
            max_retries = 8
            inference_idle_timeout_secs = 600

            [session]
            auto_compact_threshold_percent = 70

            [model.demo]
            model = "demo-v1"
            base_url = "https://example.test/v1"
            max_retries = 2
            "#,
        )
        .unwrap();
        let project = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            inference_idle_timeout_secs = 90
            auto_compact_threshold_percent = 85
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &project).unwrap();
        assert_eq!(
            projection.default_policy,
            Some(PiModelPolicy {
                max_retries: Some(8),
                inference_idle_timeout_ms: Some(600_000),
                auto_compact_threshold_percent: Some(70),
            })
        );
        assert_eq!(
            projection.policies[&format!("{}/demo-v1", provider_id("demo"))],
            PiModelPolicy {
                max_retries: Some(2),
                inference_idle_timeout_ms: Some(90_000),
                auto_compact_threshold_percent: Some(85),
            }
        );
    }

    #[test]
    fn uses_session_threshold_for_all_models_and_keeps_default_when_unset() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            model = "demo-v1"
            base_url = "https://example.test/v1"
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &toml::Table::new()).unwrap();
        assert_eq!(
            projection.default_policy,
            Some(PiModelPolicy {
                max_retries: None,
                inference_idle_timeout_ms: None,
                auto_compact_threshold_percent: Some(85),
            })
        );
        assert_eq!(
            projection.policies[&format!("{}/demo-v1", provider_id("demo"))],
            PiModelPolicy {
                max_retries: None,
                inference_idle_timeout_ms: None,
                auto_compact_threshold_percent: Some(85),
            }
        );

        let user = toml::from_str::<toml::Table>(
            r#"
            [session]
            auto_compact_threshold_percent = 70

            [model.demo]
            model = "demo-v1"
            base_url = "https://example.test/v1"
            "#,
        )
        .unwrap();
        let projection = project_projection(&user, &toml::Table::new()).unwrap();
        assert_eq!(
            projection
                .default_policy
                .as_ref()
                .unwrap()
                .auto_compact_threshold_percent,
            Some(70)
        );
        assert_eq!(
            projection.policies[&format!("{}/demo-v1", provider_id("demo"))]
                .auto_compact_threshold_percent,
            Some(70)
        );
    }

    #[test]
    fn rejects_unrepresentable_model_idle_timeout() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            model = "demo-v1"
            base_url = "https://example.test/v1"
            inference_idle_timeout_secs = 2147484
            "#,
        )
        .unwrap();
        let error = match project_projection(&user, &toml::Table::new()) {
            Ok(_) => panic!("timeout should be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("inference_idle_timeout_secs"));
    }

    #[test]
    fn rejects_invalid_model_compaction_threshold() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [model.demo]
            model = "demo-v1"
            base_url = "https://example.test/v1"
            auto_compact_threshold_percent = 101
            "#,
        )
        .unwrap();
        let error = match project_projection(&user, &toml::Table::new()) {
            Ok(_) => panic!("compaction threshold should be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("auto_compact_threshold_percent"));
    }

    #[test]
    fn parses_remote_catalog_and_filters_unsafe_or_unusable_models() {
        let value = json!({
            "data": [
                {
                    "id": "vision-v1",
                    "name": "Vision V1",
                    "base_url": "https://models.example.test/v1",
                    "api_backend": "responses",
                    "context_window": 200000,
                    "max_tokens": 8192,
                    "reasoning": true,
                    "input": ["text", "image"]
                },
                {
                    "id": "unsafe",
                    "base_url": "http://127.0.0.1/v1"
                },
                {
                    "id": "image-only",
                    "input": ["image"]
                },
                { "name": "missing-id" }
            ]
        });
        let models = parse_remote_models(&value, "https://fallback.example.test/v1").unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "vision-v1");
        assert_eq!(models[0].api_backend, "responses");
        assert_eq!(models[0].context_window, 200000);
        assert_eq!(models[0].max_completion_tokens, 8192);
        assert!(models[0].reasoning);
        assert_eq!(models[0].input, vec!["text", "image"]);
    }

    #[test]
    fn remote_catalog_uses_project_endpoint_and_stable_aliases() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [endpoints]
            models_base_url = "https://user.example.test/v1"
            "#,
        )
        .unwrap();
        let project = toml::from_str::<toml::Table>(
            r#"
            [endpoints]
            models_list_url = "https://project.example.test/catalog"
            "#,
        )
        .unwrap();
        assert_eq!(
            remote_catalog_url(&user, &project).unwrap().as_deref(),
            Some("https://project.example.test/catalog")
        );
        let models = BTreeMap::new();
        let first = remote_alias("vision/v1", "https://models.example.test/v1", &models);
        let second = remote_alias("vision/v1", "https://models.example.test/v1", &models);
        assert_eq!(first, second);
        assert!(first.starts_with("remote-vision-v1-"));
    }

    #[test]
    fn remote_fetch_defaults_to_enabled_but_respects_scoped_opt_out() {
        let user = toml::from_str::<toml::Table>(
            r#"
            [features]
            remote_fetch = true
            "#,
        )
        .unwrap();
        let project = toml::from_str::<toml::Table>(
            r#"
            [features]
            remote_fetch = false
            "#,
        )
        .unwrap();
        assert!(!remote_fetch_enabled(&user, &project));
    }
}
