//! Projection of Melody's model configuration into Pi's `models.json` format.
//!
//! Melody and Pi intentionally keep different configuration formats.  The
//! renderer continues to edit `.melody/config.toml`; the Pi worker receives a
//! generated, app-owned catalog at launch.  Secrets are never written to that
//! catalog.  They are resolved once by the Host and injected into the worker
//! under short-lived, generated environment variable names instead.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::config_io::TextFileStore;

mod model_policy;
mod model_projection;
#[path = "pi_remote_model_catalog.rs"]
mod remote_model_catalog;

use self::model_projection::Projection;
use crate::config_core::MAX_CONFIG_BYTES;

pub(super) const PI_MODELS_LIMIT_BYTES: u64 = 1024 * 1024;
pub(super) const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
pub(super) const DEFAULT_MAX_TOKENS: u64 = 16_384;
const GENERATED_MODELS_FILE: &str = "melody-models.json";
const GENERATED_POLICIES_FILE: &str = "melody-model-policies.json";

/// Host-side values that must be added after the worker environment is
/// cleared.  This type deliberately does not implement `Debug` so a future
/// diagnostic cannot accidentally print model credentials.
pub(crate) struct PreparedPiModels {
    pub(crate) path: PathBuf,
    pub(crate) policies_path: PathBuf,
    pub(crate) provider_ids: Vec<String>,
    pub(crate) credentials: Vec<(String, String)>,
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
    let remote_catalog =
        remote_model_catalog::resolve_remote_catalog(&user, &project, home).await?;
    let projection = model_projection::project_projection_with_remote(
        &user,
        &project,
        &remote_catalog.models,
        remote_catalog.api_key.as_deref(),
    )?;
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

fn positive_value(table: &toml::Table, key: &str) -> Option<u64> {
    table
        .get(key)
        .and_then(toml::Value::as_integer)
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
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
