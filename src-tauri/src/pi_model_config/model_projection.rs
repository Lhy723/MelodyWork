//! Pure projection of scoped Melody model configuration into Pi providers/models and credential references.
//!
//! This module owns config merge precedence, remote model overlay, schema normalization, policy
//! projection and generated environment references. The parent remains responsible for file IO,
//! remote catalog acquisition and injecting resolved credentials into the worker environment.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::{
    DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS,
    model_policy::{self, PiModelPolicy},
    remote_model_catalog::RemoteModel,
};

const GENERATED_SECRET_PREFIX: &str = "MELODY_PI_MODEL_";

#[derive(Default)]
pub(super) struct Projection {
    pub(super) providers: Map<String, Value>,
    pub(super) default_policy: Option<PiModelPolicy>,
    pub(super) policies: BTreeMap<String, PiModelPolicy>,
    pub(super) provider_ids: Vec<String>,
    pub(super) credentials: Vec<(String, String)>,
}

pub(super) fn remote_alias(
    model_id: &str,
    base_url: &str,
    models: &BTreeMap<String, toml::Table>,
) -> String {
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

/// Project the user/project configs without a remote catalog.
///
/// Test-only: production always goes through `project_projection_with_remote`,
/// which applies the remote-model policy before writing the catalog.

pub(super) fn project_projection_with_remote(
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
    projection.default_policy = Some(model_policy::project_policy(
        &toml::Table::new(),
        &global,
        &session,
        "default",
    )?);
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
        if let Some(secret) = resolve_api_key(model) {
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
        let policy = model_policy::project_policy(model, &global, &session, alias)?;
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
                super::positive_value(model, "context_window")
                    .or_else(|| super::positive_value(&global, "context_window"))
                    .unwrap_or(DEFAULT_CONTEXT_WINDOW),
            )),
        );
        pi_model.insert(
            "maxTokens".into(),
            Value::Number(json_number(
                super::positive_value(model, "max_completion_tokens")
                    .or_else(|| super::positive_value(&global, "max_completion_tokens"))
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
        projection
            .policies
            .insert(format!("{provider_id}/{model_id}"), policy);
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
pub(super) fn provider_id(alias: &str) -> String {
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

fn resolve_api_key(model: &toml::Table) -> Option<String> {
    string_value(model, "api_key").filter(|value| !value.trim().is_empty())
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
