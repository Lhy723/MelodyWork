use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime},
};

use semver::Version;
use serde_json::{Map, Value, json};
use tauri::State;
use tokio::process::Command;
use uuid::Uuid;

use crate::{config_io::TextFileStore, workspace_access::WorkspaceRegistry};

use super::{
    super::config_core::{
        MarketplacePlugin, MarketplaceSource, MelodyExtension, PluginInstallResult, melody_home,
        user_home,
    },
    super::config_extensions::PluginEnablement,
    config_marketplace_sources::{marketplace_sources, read_user_config_document},
};

const MARKETPLACE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_MARKETPLACE_INDEX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 4096;
const MAX_COPY_ENTRIES: usize = 20_000;
const MAX_COPY_BYTES: u64 = 256 * 1024 * 1024;
const REGISTRY_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
struct RemotePluginSource {
    url: String,
    git_ref: Option<String>,
    git_sha: Option<String>,
    subdir: Option<String>,
}

#[derive(Clone)]
struct PluginCandidate {
    plugin: MarketplacePlugin,
    relative_path: String,
    local_path: Option<PathBuf>,
    remote: Option<RemotePluginSource>,
}

#[derive(Clone)]
struct InstalledPlugin {
    repo_key: String,
    name: String,
    installed_version: Option<String>,
    marketplace: Option<String>,
    source_identity: Option<String>,
    plugin_subdir: Option<String>,
    plugin_path: PathBuf,
    repo_path: PathBuf,
    repo: Value,
}

enum DirectPluginSource {
    Local {
        path: PathBuf,
    },
    Git {
        url: String,
        git_ref: Option<String>,
        git_sha: Option<String>,
        subdir: Option<String>,
    },
}

struct CleanupDirectory(PathBuf);

impl CleanupDirectory {
    fn create(prefix: &str) -> Result<Self, String> {
        let path = env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path)
            .map_err(|error| format!("Could not create temporary plugin directory: {error}"))?;
        Ok(Self(path))
    }
}

impl Drop for CleanupDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

static CACHE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn cache_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let locks = CACHE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("marketplace cache lock map poisoned");
    locks
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn resolve_install_dir(cwd: &str) -> Result<PathBuf, String> {
    let (_, document) = read_user_config_document()?;
    if let Some(value) = document
        .get("plugins")
        .and_then(|item| item.as_table())
        .and_then(|table| table.get("install_dir"))
        .and_then(|item| item.as_str())
    {
        let value = value.trim();
        if value.is_empty() {
            return Err("[plugins].install_dir cannot be empty".to_string());
        }
        let path = expand_path(value, Path::new(cwd))?;
        return Ok(path);
    }
    Ok(melody_home()?.join("installed-plugins"))
}

fn expand_path(value: &str, relative_to: &Path) -> Result<PathBuf, String> {
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Ok(user_home()?.join(relative));
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        relative_to.join(path)
    })
}

fn source_identity(source: &MarketplaceSource, cwd: &Path) -> Result<String, String> {
    match source.kind.as_str() {
        "git" => validate_git_url(&source.location).map(str::to_string),
        "local" => {
            let path = expand_path(&source.location, cwd)?;
            Ok(path
                .canonicalize()
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned())
        }
        _ => Err(format!(
            "Unsupported Marketplace source kind: {}",
            source.kind
        )),
    }
}

fn validate_git_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() || url.len() > 4096 || url.starts_with('-') || url.contains('\0') {
        return Err("Git source URL is invalid".to_string());
    }
    let allowed = ["https://", "http://", "ssh://", "git://", "git@", "file://"];
    if !allowed.iter().any(|scheme| url.starts_with(scheme)) {
        return Err("Git source must use HTTPS, HTTP, SSH, Git, or file://".to_string());
    }
    Ok(url)
}

fn validate_git_ref(git_ref: &str) -> Result<&str, String> {
    let git_ref = git_ref.trim();
    if git_ref.is_empty()
        || git_ref.len() > 512
        || git_ref.starts_with('-')
        || git_ref.contains('\0')
        || git_ref.contains('\\')
    {
        return Err("Git branch or ref is invalid".to_string());
    }
    Ok(git_ref)
}

fn stable_cache_name(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains(':') {
        return Err("Plugin path must be a non-empty relative path".to_string());
    }
    let mut path = PathBuf::new();
    for component in Path::new(normalized).components() {
        match component {
            Component::Normal(part) => path.push(part),
            _ => return Err("Plugin path must not escape its source directory".to_string()),
        }
    }
    if path.as_os_str().is_empty() {
        return Err("Plugin path must be a non-empty relative path".to_string());
    }
    Ok(path)
}

fn resolve_beneath(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not read source directory: {error}"))?;
    let candidate = canonical_root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Plugin source path is unavailable: {error}"))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_dir() {
        return Err("Plugin source path escapes the marketplace or is not a directory".to_string());
    }
    Ok(canonical)
}

async fn run_git(cwd: Option<&Path>, args: &[String]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("Git is required for Marketplace sources: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed with {}", args.join(" "), output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn clone_repository(
    url: &str,
    git_ref: Option<&str>,
    git_sha: Option<&str>,
    destination: &Path,
) -> Result<String, String> {
    let url = validate_git_url(url)?;
    let mut args = vec!["clone".to_string(), "--depth".to_string(), "1".to_string()];
    args.extend([
        "--no-recurse-submodules".to_string(),
        "--no-tags".to_string(),
    ]);
    if let Some(git_ref) = git_ref.filter(|_| git_sha.is_none()) {
        args.push("--branch".to_string());
        args.push(validate_git_ref(git_ref)?.to_string());
        args.push("--single-branch".to_string());
    }
    args.push("--".to_string());
    args.push(url.to_string());
    args.push(destination.to_string_lossy().into_owned());
    run_git(None, &args).await?;

    if let Some(sha) = git_sha {
        validate_git_sha(sha)?;
        run_git(
            Some(destination),
            &[
                "fetch".to_string(),
                "--depth=1".to_string(),
                "origin".to_string(),
                sha.to_string(),
            ],
        )
        .await?;
        run_git(
            Some(destination),
            &[
                "checkout".to_string(),
                "--detach".to_string(),
                "--force".to_string(),
                "FETCH_HEAD".to_string(),
            ],
        )
        .await?;
    }
    git_head(destination).await
}

async fn git_head(path: &Path) -> Result<String, String> {
    run_git(Some(path), &["rev-parse".to_string(), "HEAD".to_string()]).await
}

async fn sync_marketplace_source(
    source: &MarketplaceSource,
    cwd: &Path,
    refresh: bool,
) -> Result<PathBuf, String> {
    if source.kind == "local" {
        let path = expand_path(&source.location, cwd)?;
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Marketplace '{}' is unavailable: {error}", source.name))?;
        if !canonical.is_dir() {
            return Err(format!("Marketplace '{}' is not a directory", source.name));
        }
        return Ok(canonical);
    }
    let url = validate_git_url(&source.location)?;
    if let Some(branch) = source.branch.as_deref() {
        validate_git_ref(branch)?;
    }

    let cache_root = melody_home()?.join("marketplace-cache");
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Could not create Marketplace cache: {error}"))?;
    let cache_identity = format!(
        "{url}\0{}\0{}",
        source.branch.as_deref().unwrap_or("HEAD"),
        source.name
    );
    let cache = cache_root.join(stable_cache_name(&cache_identity));
    let lock = cache_lock(&cache);
    let _guard = lock.lock().await;

    if cache.join(".git").is_dir() && !refresh && cache_is_fresh(&cache) {
        return Ok(cache);
    }

    if cache.join(".git").is_dir() {
        let mut fetch = vec![
            "fetch".to_string(),
            "--depth=1".to_string(),
            "--no-tags".to_string(),
            "origin".to_string(),
        ];
        if let Some(branch) = source.branch.as_deref() {
            fetch.push(validate_git_ref(branch)?.to_string());
        }
        if run_git(Some(&cache), &fetch).await.is_ok()
            && run_git(
                Some(&cache),
                &[
                    "checkout".to_string(),
                    "--detach".to_string(),
                    "--force".to_string(),
                    "FETCH_HEAD".to_string(),
                ],
            )
            .await
            .is_ok()
        {
            return Ok(cache);
        }
    }

    let temporary = cache_root.join(format!(".sync-{}", Uuid::new_v4()));
    let clone_result = clone_repository(url, source.branch.as_deref(), None, &temporary).await;
    if let Err(error) = clone_result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(format!(
            "Could not refresh Marketplace '{}': {error}",
            source.name
        ));
    }

    if cache.exists() {
        let backup = cache_root.join(format!(".backup-{}", Uuid::new_v4()));
        fs::rename(&cache, &backup)
            .map_err(|error| format!("Could not replace Marketplace cache: {error}"))?;
        if let Err(error) = fs::rename(&temporary, &cache) {
            let _ = fs::rename(&backup, &cache);
            let _ = fs::remove_dir_all(&temporary);
            return Err(format!(
                "Could not install refreshed Marketplace cache: {error}"
            ));
        }
        let _ = fs::remove_dir_all(backup);
    } else {
        fs::rename(&temporary, &cache)
            .map_err(|error| format!("Could not install Marketplace cache: {error}"))?;
    }
    Ok(cache)
}

fn cache_is_fresh(path: &Path) -> bool {
    fs::metadata(path.join(".git").join("FETCH_HEAD"))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < MARKETPLACE_CACHE_TTL)
}

fn read_json_file(path: &Path, limit: u64) -> Option<Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn marketplace_index(root: &Path) -> Option<Value> {
    for path in [
        root.join(".melody-plugin/marketplace.json"),
        root.join(".melody-plugin/plugin.json"),
        root.join(".claude-plugin/marketplace.json"),
        root.join(".claude-plugin/plugin.json"),
    ] {
        if path.exists() {
            return read_json_file(&path, MAX_MARKETPLACE_INDEX_BYTES);
        }
    }
    None
}

fn manifest_value(root: &Path) -> Option<Value> {
    for path in [
        root.join("plugin.json"),
        root.join(".melody-plugin/plugin.json"),
        root.join(".claude-plugin/plugin.json"),
    ] {
        if path.exists() {
            return read_json_file(&path, MAX_PLUGIN_MANIFEST_BYTES);
        }
    }
    None
}

fn safe_manifest_path(root: &Path, value: &str) -> Option<PathBuf> {
    let relative = validate_relative_path(value).ok()?;
    let root = root.canonicalize().ok()?;
    let candidate = root.join(relative);
    let canonical = candidate.canonicalize().ok()?;
    canonical.starts_with(&root).then_some(canonical)
}

fn manifest_paths(
    root: &Path,
    manifest: Option<&Value>,
    field: &str,
    fallback: &str,
) -> Vec<PathBuf> {
    let Some(value) = manifest.and_then(|manifest| manifest.get(field)) else {
        return safe_manifest_path(root, fallback)
            .filter(|path| path.is_dir())
            .into_iter()
            .collect();
    };
    let values = match value {
        Value::String(value) => vec![value.as_str()],
        Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|value| safe_manifest_path(root, value))
        .filter(|path| path.is_dir())
        .collect()
}

fn bounded_skill_count(roots: &[PathBuf]) -> usize {
    let mut stack = roots
        .iter()
        .map(|root| (root.clone(), 0usize))
        .collect::<Vec<_>>();
    let mut count = 0;
    let mut visited = 0;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 8 || visited >= MAX_SCAN_ENTRIES {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= MAX_SCAN_ENTRIES {
                return count;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if path.join("SKILL.md").is_file() {
                    count += 1;
                } else {
                    stack.push((path, depth + 1));
                }
            }
        }
    }
    count
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .is_some_and(|mut entries| entries.next().is_some())
}

fn manifest_component_exists(
    root: &Path,
    manifest: Option<&Value>,
    field: &str,
    fallback: &str,
) -> bool {
    let Some(value) = manifest.and_then(|manifest| manifest.get(field)) else {
        return safe_manifest_path(root, fallback)
            .is_some_and(|path| path.is_file() || path.is_dir());
    };
    if value.is_object() || value.is_array() {
        return !value.is_null();
    }
    value
        .as_str()
        .and_then(|value| safe_manifest_path(root, value))
        .is_some_and(|path| path.is_file() || path.is_dir())
}

fn plugin_metadata(
    root: &Path,
    fallback_name: &str,
) -> (
    String,
    Option<String>,
    Option<String>,
    usize,
    bool,
    bool,
    bool,
) {
    let manifest = manifest_value(root);
    let name = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name)
        .to_string();
    let version = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("description"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let skill_roots = manifest_paths(root, manifest.as_ref(), "skills", "skills");
    let agent_roots = manifest_paths(root, manifest.as_ref(), "agents", "agents");
    let skill_count = bounded_skill_count(&skill_roots);
    let has_hooks = manifest_component_exists(root, manifest.as_ref(), "hooks", "hooks/hooks.json");
    let has_agents = agent_roots.iter().any(|path| directory_has_entries(path));
    let has_mcp = manifest_component_exists(root, manifest.as_ref(), "mcpServers", ".mcp.json");
    (
        name,
        version,
        description,
        skill_count,
        has_hooks,
        has_agents,
        has_mcp,
    )
}

fn candidate_from_local(
    marketplace: &str,
    root: &Path,
    relative_path: &str,
    fallback_name: &str,
    version: Option<String>,
    description: Option<String>,
) -> Option<PluginCandidate> {
    let local_path = resolve_beneath(root, relative_path).ok()?;
    let (name, manifest_version, manifest_description, skill_count, has_hooks, has_agents, has_mcp) =
        plugin_metadata(&local_path, fallback_name);
    Some(PluginCandidate {
        plugin: MarketplacePlugin {
            name,
            marketplace: marketplace.to_string(),
            status: "available".to_string(),
            version: manifest_version.or(version),
            installed_version: None,
            description: manifest_description.or(description),
            update_available: false,
            skill_count,
            has_hooks,
            has_agents,
            has_mcp,
        },
        relative_path: validate_relative_path(relative_path)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/"),
        local_path: Some(local_path),
        remote: None,
    })
}

fn scan_marketplace(root: &Path, marketplace: &str) -> Vec<PluginCandidate> {
    let mut candidates = Vec::new();
    if let Some(index) = marketplace_index(root)
        && let Some(entries) = index.get("plugins").and_then(Value::as_array)
    {
        for entry in entries {
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                continue;
            };
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string);
            let description = entry
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            let source = entry.get("source");
            let remote = source.and_then(|source| {
                let object = source.as_object()?;
                let url = object.get("url")?.as_str()?.to_string();
                Some(RemotePluginSource {
                    url,
                    git_ref: object
                        .get("ref")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    git_sha: object
                        .get("sha")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    subdir: object
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            });
            if let Some(remote) = remote {
                candidates.push(PluginCandidate {
                    plugin: MarketplacePlugin {
                        name: name.to_string(),
                        marketplace: marketplace.to_string(),
                        status: "available".to_string(),
                        version,
                        installed_version: None,
                        description,
                        update_available: false,
                        skill_count: 0,
                        has_hooks: false,
                        has_agents: false,
                        has_mcp: false,
                    },
                    relative_path: name.to_string(),
                    local_path: None,
                    remote: Some(remote),
                });
                continue;
            }
            let relative_path = source
                .and_then(|source| {
                    source
                        .as_str()
                        .or_else(|| source.get("path").and_then(Value::as_str))
                })
                .unwrap_or_else(|| "");
            let relative_path = if relative_path.is_empty() {
                format!("plugins/{name}")
            } else {
                relative_path.to_string()
            };
            if let Some(candidate) = candidate_from_local(
                marketplace,
                root,
                &relative_path,
                name,
                version,
                description,
            ) {
                candidates.push(candidate);
            }
        }
        return candidates;
    }

    let plugins_root = root.join("plugins");
    let Ok(entries) = fs::read_dir(&plugins_root) else {
        return candidates;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let fallback_name = entry.file_name().to_string_lossy().into_owned();
        let relative = format!("plugins/{fallback_name}");
        if let Some(candidate) =
            candidate_from_local(marketplace, root, &relative, &fallback_name, None, None)
        {
            candidates.push(candidate);
        }
    }
    candidates
}

fn read_registry(install_dir: &Path) -> Result<Value, String> {
    let path = install_dir.join("registry.json");
    let store = TextFileStore::with_limit_description(
        &path,
        REGISTRY_MAX_BYTES,
        "the 16 MB plugin registry limit",
    );
    let content = store.read_text("Plugin registry")?;
    let Some(content) = content else {
        return Ok(json!({ "version": 1, "repos": {} }));
    };
    let registry: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Plugin registry contains invalid JSON: {error}"))?;
    if !registry.get("repos").is_some_and(Value::is_object) {
        return Err("Plugin registry does not contain a repos object".to_string());
    }
    Ok(registry)
}

fn save_registry(install_dir: &Path, registry: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("Could not encode plugin registry: {error}"))?;
    TextFileStore::with_limit_description(
        install_dir.join("registry.json"),
        REGISTRY_MAX_BYTES,
        "the 16 MB plugin registry limit",
    )
    .write_text(&content, "Plugin registry")
}

fn registry_repos(registry: &Value) -> Result<&Map<String, Value>, String> {
    registry
        .get("repos")
        .and_then(Value::as_object)
        .ok_or_else(|| "Plugin registry does not contain a repos object".to_string())
}

fn registry_repos_mut(registry: &mut Value) -> Result<&mut Map<String, Value>, String> {
    registry
        .get_mut("repos")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Plugin registry does not contain a repos object".to_string())
}

fn installed_plugins(registry: &Value, install_dir: &Path) -> Result<Vec<InstalledPlugin>, String> {
    let mut installed = Vec::new();
    for (repo_key, repo) in registry_repos(registry)? {
        let Some(repo_path) = registry_repo_path(install_dir, repo_key, repo) else {
            continue;
        };
        let Some(plugins) = repo.get("plugins").and_then(Value::as_object) else {
            continue;
        };
        let marketplace = repo.get("marketplace");
        for (name, plugin) in plugins {
            let subdir = plugin.get("subdir").and_then(Value::as_str);
            let plugin_path = match subdir {
                Some(subdir) => match safe_join_existing(&repo_path, subdir) {
                    Some(path) => path,
                    None => continue,
                },
                None => repo_path.clone(),
            };
            if !plugin_path.is_dir() {
                continue;
            }
            installed.push(InstalledPlugin {
                repo_key: repo_key.clone(),
                name: name.clone(),
                installed_version: plugin
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| plugin_metadata(&plugin_path, name).1),
                marketplace: marketplace
                    .and_then(|value| value.get("source_display_name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source_identity: marketplace
                    .and_then(|value| value.get("source_url_or_path"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                plugin_subdir: marketplace
                    .and_then(|value| value.get("plugin_subdir"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                plugin_path,
                repo_path: repo_path.clone(),
                repo: repo.clone(),
            });
        }
    }
    installed.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.repo_key.cmp(&right.repo_key))
    });
    Ok(installed)
}

fn registry_repo_path(install_dir: &Path, key: &str, repo: &Value) -> Option<PathBuf> {
    let canonical_root = install_dir.canonicalize().ok()?;
    let mut path = repo
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(key));
    if !path.is_absolute() {
        path = canonical_root.join(path);
    }
    let metadata = fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let canonical_path = path.canonicalize().ok()?;
    (canonical_path.parent() == Some(canonical_root.as_path())).then_some(canonical_path)
}

fn safe_join_existing(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = validate_relative_path(relative).ok()?;
    let root = root.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    path.starts_with(root).then_some(path)
}

fn canonical_identity(source: &MarketplaceSource, cwd: &Path) -> Result<String, String> {
    source_identity(source, cwd)
}

fn same_source(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .trim()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

fn is_newer_version(latest: Option<&str>, installed: Option<&str>) -> bool {
    let Some(latest) = latest.and_then(parse_version) else {
        return false;
    };
    let Some(installed) = installed.and_then(parse_version) else {
        return false;
    };
    latest > installed
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches(['v', 'V'])).ok()
}

#[cfg(test)]
pub(crate) fn marketplace_plugins_from_json(
    output: &str,
) -> Result<Vec<MarketplacePlugin>, String> {
    let entries = serde_json::from_str::<Vec<Value>>(output)
        .map_err(|error| format!("Melody returned an invalid Marketplace catalog: {error}"))?;
    let mut plugins = Vec::new();
    for entry in entries {
        let Some(status) = entry.get("status").and_then(Value::as_str) else {
            continue;
        };
        let Some(marketplace) = entry.get("marketplace").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            continue;
        };
        let marketplace = marketplace.to_string();
        let name = name.to_string();
        let version = entry
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string);
        let existing = plugins.iter().position(|plugin: &MarketplacePlugin| {
            plugin.name == name && plugin.marketplace == marketplace
        });
        match status {
            "installed" => {
                let installed_version = entry
                    .get("installed_version")
                    .or_else(|| entry.get("version"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(index) = existing {
                    let plugin = &mut plugins[index];
                    plugin.status = "installed".to_string();
                    plugin.installed_version = installed_version;
                    plugin.update_available = is_newer_version(
                        plugin.version.as_deref(),
                        plugin.installed_version.as_deref(),
                    );
                } else {
                    plugins.push(MarketplacePlugin {
                        name,
                        marketplace,
                        status: "installed".to_string(),
                        version: None,
                        installed_version,
                        description: None,
                        update_available: false,
                        skill_count: 0,
                        has_hooks: false,
                        has_agents: false,
                        has_mcp: false,
                    });
                }
            }
            "available" => {
                let description = entry
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let skill_count = entry
                    .get("skill_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let has_hooks = entry
                    .get("has_hooks")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let has_agents = entry
                    .get("has_agents")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let has_mcp = entry
                    .get("has_mcp")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(index) = existing {
                    let plugin = &mut plugins[index];
                    plugin.version = version;
                    plugin.description = description;
                    plugin.skill_count = skill_count;
                    plugin.has_hooks = has_hooks;
                    plugin.has_agents = has_agents;
                    plugin.has_mcp = has_mcp;
                    plugin.update_available = plugin.status == "installed"
                        && is_newer_version(
                            plugin.version.as_deref(),
                            plugin.installed_version.as_deref(),
                        );
                } else {
                    plugins.push(MarketplacePlugin {
                        name,
                        marketplace,
                        status: "available".to_string(),
                        version,
                        installed_version: None,
                        description,
                        update_available: false,
                        skill_count,
                        has_hooks,
                        has_agents,
                        has_mcp,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(plugins)
}

#[cfg(test)]
pub(crate) fn format_plugin_update_message(name: &str, output: &str) -> String {
    let message = output.trim();
    let lowercase = message.to_ascii_lowercase();
    if message.is_empty() || lowercase.contains("already up to date") {
        return format!("{name} 已是最新版本。");
    }
    if lowercase.contains("updated (? -> ?)") {
        return format!("{name} 已完成同步；插件来源未提供版本号，暂时无法确认是否有版本变化。");
    }
    if lowercase.contains("updated (") {
        return format!("{name} 已更新。");
    }
    message.to_string()
}

#[tauri::command]
pub async fn scan_marketplace_plugins(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    refresh: bool,
) -> Result<Vec<MarketplacePlugin>, String> {
    let cwd = registry.authorize(&cwd)?;
    let (_, document) = read_user_config_document()?;
    let sources = marketplace_sources(&document)?;
    let install_dir = resolve_install_dir(&cwd.to_string_lossy())?;
    let installed_registry = read_registry(&install_dir)?;
    let installed = installed_plugins(&installed_registry, &install_dir)?;
    let mut plugins: BTreeMap<(String, String), MarketplacePlugin> = BTreeMap::new();
    let mut source_error = None;

    for source in &sources {
        let identity = canonical_identity(source, &cwd)?;
        let root = match sync_marketplace_source(source, &cwd, refresh).await {
            Ok(root) => root,
            Err(error) => {
                source_error.get_or_insert_with(|| format!("{}: {error}", source.name));
                continue;
            }
        };
        for candidate in scan_marketplace(&root, &source.name) {
            let current = installed.iter().find(|entry| {
                entry.marketplace.as_deref() == Some(source.name.as_str())
                    && entry
                        .source_identity
                        .as_deref()
                        .is_some_and(|existing| same_source(existing, &identity))
                    && entry.plugin_subdir.as_deref() == Some(candidate.relative_path.as_str())
            });
            let mut plugin = candidate.plugin;
            if let Some(current) = current {
                plugin.status = "installed".to_string();
                plugin.installed_version = current.installed_version.clone();
                plugin.update_available = is_newer_version(
                    plugin.version.as_deref(),
                    plugin.installed_version.as_deref(),
                );
            }
            plugins.insert((plugin.marketplace.clone(), plugin.name.clone()), plugin);
        }
    }

    for installed in installed
        .into_iter()
        .filter(|entry| entry.marketplace.is_some())
    {
        let marketplace = installed.marketplace.unwrap_or_default();
        let key = (marketplace.clone(), installed.name.clone());
        plugins.entry(key).or_insert_with(|| {
            let (name, version, description, skill_count, has_hooks, has_agents, has_mcp) =
                plugin_metadata(&installed.plugin_path, &installed.name);
            MarketplacePlugin {
                name,
                marketplace,
                status: "installed".to_string(),
                version: None,
                installed_version: installed.installed_version.or(version),
                description,
                update_available: false,
                skill_count,
                has_hooks,
                has_agents,
                has_mcp,
            }
        });
    }

    if plugins.is_empty() && !sources.is_empty() {
        if let Some(error) = source_error {
            return Err(error);
        }
    }
    Ok(plugins.into_values().collect())
}

#[tauri::command]
pub fn list_installed_melody_plugins(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let install_dir = resolve_install_dir(&cwd)?;
    let registry = read_registry(&install_dir)?;
    let enablement = PluginEnablement::for_workspace(&cwd)?;
    let mut extensions = installed_plugins(&registry, &install_dir)?
        .into_iter()
        .map(|plugin| MelodyExtension {
            kind: "plugins".to_string(),
            name: plugin.name.clone(),
            path: plugin.plugin_path.to_string_lossy().into_owned(),
            scope: "user".to_string(),
            provider: "melody".to_string(),
            managed: true,
            enabled: enablement.is_enabled("user", &plugin.plugin_path, &plugin.name),
            description: plugin_metadata(&plugin.plugin_path, &plugin.name).2,
            source: Some("plugin".to_string()),
            plugin_name: None,
            user_invocable: None,
            compatibility_status: None,
            deletable: false,
        })
        .collect::<Vec<_>>();
    extensions.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    Ok(extensions)
}

fn registry_install_record(
    kind: Value,
    target: &Path,
    plugin_name: &str,
    version: Option<&str>,
    provenance: Option<(&str, &str, &str)>,
) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let mut plugins = Map::new();
    plugins.insert(plugin_name.to_string(), json!({ "version": version }));
    let mut repo = json!({
        "kind": kind,
        "installed_at": now,
        "updated_at": now,
        "path": target,
        "plugins": plugins
    });
    if let Some((source_identity, source_name, plugin_subdir)) = provenance {
        repo["marketplace"] = json!({
            "source_url_or_path": source_identity,
            "source_display_name": source_name,
            "plugin_subdir": plugin_subdir,
        });
    }
    repo
}

fn repo_key(name: &str, identity: &str) -> String {
    let basename = name
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let digest = sha256_hex(identity.as_bytes());
    format!(
        "{}-{}",
        if basename.is_empty() {
            "plugin"
        } else {
            &basename
        },
        &digest[..8]
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_repo_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 160
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn copy_directory_safely(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect plugin source: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin source must be a real directory, not a symlink".to_string());
    }
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin source: {error}"))?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    copy_directory_contents(&canonical, destination, &mut files, &mut bytes)
}

fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create plugin installation directory: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read plugin source: {error}"))?
        .flatten()
    {
        *files += 1;
        if *files > MAX_COPY_ENTRIES {
            return Err("Plugin source has too many files to install safely".to_string());
        }
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("Could not inspect plugin source entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            copy_directory_contents(&source_path, &destination_path, files, bytes)?;
        } else if metadata.is_file() {
            *bytes = bytes.saturating_add(metadata.len());
            if *bytes > MAX_COPY_BYTES {
                return Err("Plugin source exceeds the 256 MB installation limit".to_string());
            }
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not copy plugin file: {error}"))?;
        }
    }
    Ok(())
}

fn replace_installed_directory(
    install_dir: &Path,
    target: &Path,
    staging: &Path,
) -> Result<Option<PathBuf>, String> {
    let root = install_dir
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin install directory: {error}"))?;
    let target_parent = target
        .parent()
        .ok_or_else(|| "Plugin install path has no parent".to_string())?;
    if target_parent.canonicalize().ok().as_deref() != Some(root.as_path()) {
        return Err(
            "Plugin install path must be a direct child of the install directory".to_string(),
        );
    }
    if target.exists() {
        let backup = install_dir.join(format!(".backup-{}", Uuid::new_v4()));
        fs::rename(target, &backup).map_err(|error| {
            format!("Could not preserve the existing plugin before update: {error}")
        })?;
        if let Err(error) = fs::rename(staging, target) {
            let _ = fs::rename(&backup, target);
            return Err(format!("Could not activate updated plugin files: {error}"));
        }
        Ok(Some(backup))
    } else {
        fs::rename(staging, target)
            .map_err(|error| format!("Could not activate plugin files: {error}"))?;
        Ok(None)
    }
}

fn install_snapshot(
    install_dir: &Path,
    key: &str,
    source_root: &Path,
    plugin_name: &str,
    version: Option<&str>,
    kind: Value,
    provenance: Option<(&str, &str, &str)>,
    replace: bool,
) -> Result<(), String> {
    if !valid_repo_key(key) {
        return Err("Plugin installation key is invalid".to_string());
    }
    fs::create_dir_all(install_dir)
        .map_err(|error| format!("Could not create plugin install directory: {error}"))?;
    let target = install_dir.join(key);
    if target.exists() && !replace {
        return Err(format!("Plugin installation already exists: {plugin_name}"));
    }
    let mut registry = read_registry(install_dir)?;
    let old_record = registry_repos(&registry)?.get(key).cloned();
    let staging = install_dir.join(format!(".staging-{}", Uuid::new_v4()));
    if let Err(error) = copy_directory_safely(source_root, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let record = registry_install_record(kind, &target, plugin_name, version, provenance);
    let repos = registry_repos_mut(&mut registry)?;
    repos.insert(key.to_string(), record);
    let backup = match replace_installed_directory(install_dir, &target, &staging) {
        Ok(backup) => backup,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = save_registry(install_dir, &registry) {
        let _ = fs::remove_dir_all(&target);
        if let Some(backup) = backup.as_ref() {
            let _ = fs::rename(backup, &target);
        }
        if let Some(old_record) = old_record {
            if let Ok(repos) = registry_repos_mut(&mut registry) {
                repos.insert(key.to_string(), old_record);
                let _ = save_registry(install_dir, &registry);
            }
        } else if let Ok(repos) = registry_repos_mut(&mut registry) {
            repos.remove(key);
            let _ = save_registry(install_dir, &registry);
        }
        return Err(error);
    }
    if let Some(backup) = backup {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn require_sha_enabled() -> Result<bool, String> {
    let env_enabled = env::var_os("MELODY_MARKETPLACE_REQUIRE_SHA").is_some_and(|value| {
        matches!(
            value.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    });
    let (_, document) = read_user_config_document()?;
    Ok(env_enabled
        || document
            .get("marketplace")
            .and_then(|item| item.as_table())
            .and_then(|table| table.get("require_sha"))
            .and_then(|item| item.as_bool())
            .unwrap_or(false))
}

fn validate_git_sha(sha: &str) -> Result<&str, String> {
    let sha = sha.trim();
    if (sha.len() == 40 || sha.len() == 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        Err("Remote plugin SHA must be a full 40- or 64-character hexadecimal commit".to_string())
    }
}

fn resolve_marketplace_source<'a>(
    sources: &'a [MarketplaceSource],
    qualifier: &str,
    cwd: &Path,
) -> Result<&'a MarketplaceSource, String> {
    let matches = sources
        .iter()
        .filter(|source| {
            source.name == qualifier
                || source_identity(source, cwd)
                    .ok()
                    .is_some_and(|identity| same_source(&identity, qualifier))
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [source] => Ok(source),
        [] => Err(format!(
            "Marketplace source '{qualifier}' is not configured"
        )),
        _ => Err(format!("Marketplace source '{qualifier}' is ambiguous")),
    }
}

fn parse_marketplace_reference(input: &str) -> Option<(&str, &str)> {
    if input.contains("://")
        || input.starts_with("git@")
        || input.starts_with('/')
        || input.starts_with('\\')
        || input.starts_with('.')
        || input.starts_with('~')
        || input.contains('#')
    {
        return None;
    }
    let (name, qualifier) = input.split_once('@')?;
    if name.trim().is_empty() || qualifier.trim().is_empty() || name.contains('/') {
        return None;
    }
    Some((name.trim(), qualifier.trim()))
}

fn parse_direct_source(input: &str, cwd: &Path) -> Result<DirectPluginSource, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 4096 {
        return Err("Plugin source is empty or too long".to_string());
    }
    let (input, subdir) = match input.rsplit_once('#') {
        Some((input, subdir)) if !subdir.is_empty() => (input, Some(subdir.to_string())),
        _ => (input, None),
    };
    let path_like = input.starts_with('/')
        || input.starts_with("./")
        || input.starts_with("../")
        || input.starts_with("~/")
        || input.starts_with('\\')
        || input.as_bytes().get(1) == Some(&b':');
    if path_like || cwd.join(input).is_dir() {
        let path = expand_path(input, cwd)?
            .canonicalize()
            .map_err(|error| format!("Plugin source path is unavailable: {error}"))?;
        if !path.is_dir() {
            return Err("Plugin source must be a directory".to_string());
        }
        let path = if let Some(subdir) = subdir {
            safe_join_existing(&path, &subdir)
                .ok_or_else(|| "Plugin source subdirectory is invalid".to_string())?
        } else {
            path
        };
        return Ok(DirectPluginSource::Local { path });
    }

    let mut url = input.to_string();
    let mut git_ref = None;
    if !input.starts_with("git@") {
        if let Some((base, reference)) = input.rsplit_once('@')
            && !reference.is_empty()
            && (base.contains("://") || base.matches('/').count() == 1)
        {
            url = base.to_string();
            git_ref = Some(reference.to_string());
        }
    }
    if !url.contains("://") && !url.starts_with("git@") && url.matches('/').count() == 1 {
        url = format!("https://github.com/{}.git", url.trim_end_matches(".git"));
    }
    validate_git_url(&url)?;
    if let Some(git_ref) = git_ref.as_deref() {
        validate_git_ref(git_ref)?;
    }
    let git_sha = git_ref
        .as_deref()
        .filter(|reference| validate_git_sha(reference).is_ok())
        .map(str::to_string);
    Ok(DirectPluginSource::Git {
        url,
        git_ref: if git_sha.is_some() { None } else { git_ref },
        git_sha,
        subdir,
    })
}

fn detect_plugin_directory(root: &Path) -> Result<(PathBuf, String, Option<String>), String> {
    let root_manifest = manifest_value(root);
    if root_manifest.is_some()
        || ["skills", "agents", "hooks", ".mcp.json"]
            .iter()
            .any(|name| root.join(name).exists())
    {
        let fallback = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("plugin");
        let (name, version, ..) = plugin_metadata(root, fallback);
        return Ok((root.to_path_buf(), name, version));
    }
    let candidates = scan_marketplace(root, "local");
    match candidates.as_slice() {
        [candidate] => Ok((
            candidate
                .local_path
                .clone()
                .expect("local scanner candidates always have paths"),
            candidate.plugin.name.clone(),
            candidate.plugin.version.clone(),
        )),
        [] => {
            Err("No plugin was found. Select its directory or append #relative/path.".to_string())
        }
        _ => Err(
            "This source contains multiple plugins. Select one with #relative/path.".to_string(),
        ),
    }
}

fn resolve_direct_git_plugin_path(
    repository_root: &Path,
    requested_subdir: Option<&str>,
) -> Result<(PathBuf, Option<String>), String> {
    if let Some(subdir) = requested_subdir {
        return safe_join_existing(repository_root, subdir)
            .map(|path| (path, Some(subdir.to_string())))
            .ok_or_else(|| "Plugin source subdirectory is invalid".to_string());
    }
    let canonical_root = repository_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin repository: {error}"))?;
    let (plugin_path, _, _) = detect_plugin_directory(&canonical_root)?;
    let detected_subdir = plugin_path
        .strip_prefix(&canonical_root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().replace('\\', "/"));
    Ok((plugin_path, detected_subdir))
}

async fn install_marketplace_candidate(
    candidate: &PluginCandidate,
    source: &MarketplaceSource,
    identity: &str,
    install_dir: &Path,
    replace: bool,
    existing_key: Option<&str>,
) -> Result<String, String> {
    let key = repo_key(
        &candidate.plugin.name,
        &format!("{identity}#{}", candidate.relative_path),
    );
    let key = existing_key.unwrap_or(&key);
    let temp_root = CleanupDirectory::create("melody-plugin")?;
    let (plugin_root, kind) = if let Some(remote) = &candidate.remote {
        if require_sha_enabled()?
            && remote
                .git_sha
                .as_deref()
                .and_then(|sha| validate_git_sha(sha).ok())
                .is_none()
        {
            return Err(format!(
                "Remote plugin '{}' has no pinned full commit SHA; Marketplace require_sha is enabled",
                candidate.plugin.name
            ));
        }
        let clone_root = temp_root.0.join("repo");
        let commit = clone_repository(
            &remote.url,
            remote.git_ref.as_deref(),
            remote.git_sha.as_deref(),
            &clone_root,
        )
        .await?;
        let plugin_root = match remote.subdir.as_deref() {
            Some(subdir) => safe_join_existing(&clone_root, subdir)
                .ok_or_else(|| "Remote plugin subdirectory is invalid".to_string())?,
            None => clone_root.clone(),
        };
        (
            plugin_root,
            json!({
                "type": "Git",
                "url": remote.url,
                "git_ref": remote.git_sha.as_deref().or(remote.git_ref.as_deref()),
                "commit": commit,
                "subdir": remote.subdir,
            }),
        )
    } else {
        let path = candidate
            .local_path
            .clone()
            .ok_or_else(|| "Marketplace plugin source is missing".to_string())?;
        (
            path.clone(),
            json!({ "type": "Local", "source_path": path }),
        )
    };
    let (manifest_name, manifest_version, ..) =
        plugin_metadata(&plugin_root, &candidate.plugin.name);
    let version = manifest_version.or_else(|| candidate.plugin.version.clone());
    let provenance = (
        identity,
        source.name.as_str(),
        candidate.relative_path.as_str(),
    );
    let installed = install_snapshot(
        install_dir,
        &key,
        &plugin_root,
        &manifest_name,
        version.as_deref(),
        kind,
        Some(provenance),
        replace,
    );
    installed?;
    Ok(manifest_name)
}

#[tauri::command]
pub async fn install_melody_plugin(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    source: String,
) -> Result<PluginInstallResult, String> {
    let cwd = registry.authorize(&cwd)?;
    let install_dir = resolve_install_dir(&cwd.to_string_lossy())?;
    let source = source.trim();
    if source.is_empty() || source.len() > 4096 {
        return Err("Plugin source is empty or too long".to_string());
    }

    if let Some((plugin_name, qualifier)) = parse_marketplace_reference(source) {
        let (_, document) = read_user_config_document()?;
        let sources = marketplace_sources(&document)?;
        let marketplace = resolve_marketplace_source(&sources, qualifier, &cwd)?;
        let identity = source_identity(marketplace, &cwd)?;
        let root = sync_marketplace_source(marketplace, &cwd, false).await?;
        let matches = scan_marketplace(&root, &marketplace.name)
            .into_iter()
            .filter(|candidate| candidate.plugin.name.eq_ignore_ascii_case(plugin_name))
            .collect::<Vec<_>>();
        let candidate = match matches.as_slice() {
            [candidate] => candidate,
            [] => {
                return Err(format!(
                    "Plugin '{plugin_name}' was not found in '{qualifier}'"
                ));
            }
            _ => {
                return Err(format!(
                    "Plugin '{plugin_name}' is ambiguous in '{qualifier}'"
                ));
            }
        };
        if installed_plugins(&read_registry(&install_dir)?, &install_dir)?
            .iter()
            .any(|plugin| {
                plugin
                    .source_identity
                    .as_deref()
                    .is_some_and(|existing| same_source(existing, &identity))
                    && plugin.marketplace.as_deref() == Some(marketplace.name.as_str())
                    && plugin.plugin_subdir.as_deref() == Some(candidate.relative_path.as_str())
            })
        {
            return Ok(PluginInstallResult {
                source: source.to_string(),
                message: format!("{} 已安装。", candidate.plugin.name),
            });
        }
        let name = install_marketplace_candidate(
            candidate,
            marketplace,
            &identity,
            &install_dir,
            false,
            None,
        )
        .await?;
        return Ok(PluginInstallResult {
            source: source.to_string(),
            message: format!("已安装插件 {name}。"),
        });
    }

    let direct = parse_direct_source(source, &cwd)?;
    let temp_root = CleanupDirectory::create("melody-plugin-source")?;
    let result = match direct {
        DirectPluginSource::Local { path } => {
            let (plugin_path, name, version) = detect_plugin_directory(&path)?;
            let identity = format!("local:{}", plugin_path.display());
            let key = repo_key(&name, &identity);
            let kind = json!({ "type": "Local", "source_path": plugin_path });
            install_snapshot(
                &install_dir,
                &key,
                &plugin_path,
                &name,
                version.as_deref(),
                kind,
                None,
                false,
            )?;
            name
        }
        DirectPluginSource::Git {
            url,
            git_ref,
            git_sha,
            subdir,
        } => {
            if require_sha_enabled()? && git_sha.is_none() {
                return Err("Remote plugin installs require a full commit SHA while Marketplace require_sha is enabled".to_string());
            }
            let clone_root = temp_root.0.join("repo");
            let commit =
                clone_repository(&url, git_ref.as_deref(), git_sha.as_deref(), &clone_root).await?;
            let (plugin_path, resolved_subdir) =
                resolve_direct_git_plugin_path(&clone_root, subdir.as_deref())?;
            let (name, version, ..) = plugin_metadata(&plugin_path, "plugin");
            let identity = format!("{url}#{}", subdir.as_deref().unwrap_or("."));
            let key = repo_key(&name, &identity);
            let kind = json!({
                "type": "Git",
                "url": url,
                "git_ref": git_sha.as_deref().or(git_ref.as_deref()),
                "commit": commit,
                "subdir": resolved_subdir,
            });
            install_snapshot(
                &install_dir,
                &key,
                &plugin_path,
                &name,
                version.as_deref(),
                kind,
                None,
                false,
            )?;
            name
        }
    };
    Ok(PluginInstallResult {
        source: source.to_string(),
        message: format!("已安装插件 {result}。"),
    })
}

fn find_installed_plugin<'a>(
    installed: &'a [InstalledPlugin],
    name: &str,
    marketplace: Option<&str>,
) -> Result<&'a InstalledPlugin, String> {
    let mut matches = installed.iter().filter(|plugin| {
        plugin.name.eq_ignore_ascii_case(name)
            && marketplace
                .is_none_or(|marketplace| plugin.marketplace.as_deref() == Some(marketplace))
    });
    let Some(plugin) = matches.next() else {
        return Err(format!("Installed plugin '{name}' was not found"));
    };
    if matches.next().is_some() {
        return Err(format!(
            "More than one installed plugin is named '{name}'; specify its Marketplace"
        ));
    }
    Ok(plugin)
}

fn plugin_reference(value: &str) -> (&str, Option<&str>) {
    value
        .split_once('@')
        .map_or((value, None), |(name, marketplace)| {
            (name, Some(marketplace))
        })
}

async fn update_installed_plugin(
    workspace: &Path,
    install_dir: &Path,
    installed: &InstalledPlugin,
) -> Result<String, String> {
    let old_version = installed.installed_version.clone();
    if let Some(stored_identity) = installed.source_identity.as_deref() {
        let (_, document) = read_user_config_document()?;
        let sources = marketplace_sources(&document)?;
        let matching_sources = sources
            .iter()
            .filter(|source| {
                source_identity(source, workspace)
                    .ok()
                    .is_some_and(|identity| same_source(&identity, stored_identity))
            })
            .collect::<Vec<_>>();
        let name_matches = installed
            .marketplace
            .as_deref()
            .map(|name| {
                matching_sources
                    .iter()
                    .copied()
                    .filter(|source| source.name == name)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let source = match name_matches.as_slice() {
            [source] => *source,
            [] => match matching_sources.as_slice() {
                [source] => *source,
                [] => {
                    return Err(
                        "The plugin's Marketplace source is no longer configured".to_string()
                    );
                }
                _ => {
                    return Err(
                        "The plugin's Marketplace source is ambiguous; keep its original source name or remove duplicate URLs".to_string(),
                    );
                }
            },
            _ => {
                return Err(
                    "The plugin's Marketplace source name is duplicated in configuration"
                        .to_string(),
                );
            }
        };
        let identity = source_identity(source, workspace)?;
        let root = sync_marketplace_source(source, workspace, true).await?;
        let plugin_subdir = installed
            .plugin_subdir
            .as_deref()
            .ok_or_else(|| "Installed Marketplace plugin has no source path".to_string())?;
        let candidate = scan_marketplace(&root, &source.name)
            .into_iter()
            .find(|candidate| candidate.relative_path == plugin_subdir)
            .ok_or_else(|| {
                format!(
                    "Plugin '{}' is no longer listed in its Marketplace",
                    installed.name
                )
            })?;
        install_marketplace_candidate(
            &candidate,
            source,
            &identity,
            install_dir,
            true,
            Some(&installed.repo_key),
        )
        .await?;
    } else {
        let kind = installed
            .repo
            .get("kind")
            .ok_or_else(|| "Installed plugin source metadata is missing".to_string())?;
        let type_name = kind.get("type").and_then(Value::as_str).unwrap_or_default();
        let plugin_subdir = kind.get("subdir").and_then(Value::as_str);
        let (source_root, updated_kind) = match type_name {
            "Git" => {
                let url = kind
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Installed Git plugin has no source URL".to_string())?;
                let git_ref = kind.get("git_ref").and_then(Value::as_str);
                let git_sha = git_ref.filter(|reference| validate_git_sha(reference).is_ok());
                if require_sha_enabled()? && git_sha.is_none() {
                    return Err("Remote plugin updates require a full commit SHA while Marketplace require_sha is enabled".to_string());
                }
                let temp_root = CleanupDirectory::create("melody-plugin-update")?;
                let clone_root = temp_root.0.join("repo");
                let commit = clone_repository(
                    url,
                    git_ref.filter(|_| git_sha.is_none()),
                    git_sha,
                    &clone_root,
                )
                .await?;
                let plugin_path = match plugin_subdir {
                    Some(subdir) => safe_join_existing(&clone_root, subdir)
                        .ok_or_else(|| "Installed plugin subdirectory is invalid".to_string())?,
                    None => clone_root.clone(),
                };
                let updated_kind = json!({
                    "type": "Git",
                    "url": url,
                    "git_ref": git_sha.or(git_ref),
                    "commit": commit,
                    "subdir": plugin_subdir,
                });
                let result = install_snapshot(
                    install_dir,
                    &installed.repo_key,
                    &plugin_path,
                    &installed.name,
                    plugin_metadata(&plugin_path, &installed.name).1.as_deref(),
                    updated_kind,
                    None,
                    true,
                );
                result?;
                return Ok(update_message(
                    &installed.name,
                    old_version.as_deref(),
                    installed.plugin_path.as_path(),
                ));
            }
            "Local" => {
                let path = kind
                    .get("source_path")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .ok_or_else(|| "Installed local plugin has no source path".to_string())?;
                let path = match plugin_subdir {
                    Some(subdir) => safe_join_existing(&path, subdir)
                        .ok_or_else(|| "Installed plugin subdirectory is invalid".to_string())?,
                    None => path,
                };
                let kind = json!({ "type": "Local", "source_path": path });
                (path, kind)
            }
            _ => return Err("Installed plugin source type is unsupported".to_string()),
        };
        let (name, version, ..) = plugin_metadata(&source_root, &installed.name);
        install_snapshot(
            install_dir,
            &installed.repo_key,
            &source_root,
            &name,
            version.as_deref(),
            updated_kind,
            None,
            true,
        )?;
    }
    Ok(update_message(
        &installed.name,
        old_version.as_deref(),
        &installed.plugin_path,
    ))
}

fn update_message(name: &str, old_version: Option<&str>, path: &Path) -> String {
    let new_version = plugin_metadata(path, name).1;
    match (old_version, new_version.as_deref()) {
        (Some(old), Some(new)) if old.trim() == new.trim() => {
            format!("{name} 已是最新版本。")
        }
        (Some(old), Some(new))
            if parse_version(old)
                .zip(parse_version(new))
                .is_some_and(|(old, new)| old == new) =>
        {
            format!("{name} 已是最新版本。")
        }
        (Some(_), Some(_)) => format!("{name} 已更新。"),
        _ => format!("{name} 已完成同步；插件来源未提供版本号，暂时无法确认是否有版本变化。"),
    }
}

#[tauri::command]
pub async fn update_melody_plugin(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
) -> Result<PluginInstallResult, String> {
    let workspace = registry.authorize(&cwd)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let (plugin_name, marketplace) = plugin_reference(name);
    let install_dir = resolve_install_dir(&workspace.to_string_lossy())?;
    let registry = read_registry(&install_dir)?;
    let installed = installed_plugins(&registry, &install_dir)?;
    let plugin = find_installed_plugin(&installed, plugin_name, marketplace)?;
    let message = update_installed_plugin(&workspace, &install_dir, plugin).await?;
    Ok(PluginInstallResult {
        source: name.to_string(),
        message,
    })
}

#[tauri::command]
pub fn uninstall_melody_plugin(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    keep_data: bool,
    path: Option<String>,
) -> Result<String, String> {
    let workspace = registry.authorize(&cwd)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let (plugin_name, marketplace) = plugin_reference(name);
    let install_dir = resolve_install_dir(&workspace.to_string_lossy())?;
    let mut registry = read_registry(&install_dir)?;
    let installed = installed_plugins(&registry, &install_dir)?;
    let plugin = if let Some(path) = path {
        let requested_path = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("Installed plugin path is unavailable: {error}"))?;
        installed
            .iter()
            .find(|plugin| {
                plugin.name.eq_ignore_ascii_case(plugin_name)
                    && marketplace.is_none_or(|marketplace| {
                        plugin.marketplace.as_deref() == Some(marketplace)
                    })
                    && plugin.plugin_path.canonicalize().ok().as_ref() == Some(&requested_path)
            })
            .cloned()
            .ok_or_else(|| format!("Installed plugin '{plugin_name}' was not found at that path"))?
    } else {
        find_installed_plugin(&installed, plugin_name, marketplace)?.clone()
    };
    let repos = registry_repos_mut(&mut registry)?;
    let repo = repos
        .get_mut(&plugin.repo_key)
        .ok_or_else(|| "Installed plugin registry entry disappeared".to_string())?;
    let plugins = repo
        .get_mut("plugins")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Installed plugin registry entry is invalid".to_string())?;

    let repo_path = &plugin.repo_path;
    if plugins.len() > 1 {
        let subdir = plugins
            .get(&plugin.name)
            .and_then(|entry| entry.get("subdir"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "This shared installation cannot safely remove one plugin".to_string()
            })?;
        remove_managed_subpath(repo_path, subdir)?;
        plugins.remove(&plugin.name);
    } else {
        repos.remove(&plugin.repo_key);
        remove_managed_path(&install_dir, repo_path)?;
    }
    save_registry(&install_dir, &registry)?;
    if !keep_data {
        remove_plugin_data(&plugin.name)?;
    }
    Ok(format!("Plugin {} was removed", plugin.name))
}

fn remove_managed_path(root: &Path, path: &Path) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin install directory: {error}"))?;
    if path
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .as_deref()
        != Some(canonical_root.as_path())
    {
        return Err("Refusing to remove a plugin path outside its install directory".to_string());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect installed plugin: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        fs::remove_file(path).map_err(|error| format!("Could not remove installed plugin: {error}"))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove installed plugin: {error}"))
    }
}

fn remove_managed_subpath(root: &Path, relative: &str) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin install directory: {error}"))?;
    let relative = validate_relative_path(relative)?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not inspect installed plugin: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return fs::remove_file(path)
            .map_err(|error| format!("Could not remove installed plugin: {error}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve installed plugin: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Refusing to remove a plugin path outside its install directory".to_string());
    }
    fs::remove_dir_all(canonical)
        .map_err(|error| format!("Could not remove installed plugin: {error}"))
}

fn remove_plugin_data(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Ok(());
    }
    let path = melody_home()?.join("plugin-data").join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|error| format!("Could not remove plugin data: {error}"))
        }
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove plugin data: {error}")),
        Ok(_) => {
            fs::remove_file(path).map_err(|error| format!("Could not remove plugin data: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect plugin data: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_plugin_paths_that_escape_marketplace_root() {
        for input in [
            "../secret",
            "/absolute/path",
            "C:\\plugins\\x",
            "plugins/../../x",
        ] {
            assert!(validate_relative_path(input).is_err(), "accepted {input}");
        }
        assert_eq!(
            validate_relative_path("./plugins/review").unwrap(),
            PathBuf::from("plugins/review")
        );
    }

    #[test]
    fn reads_indexed_and_filesystem_marketplace_plugins() {
        let root = env::temp_dir().join(format!("melody-marketplace-test-{}", Uuid::new_v4()));
        let plugin = root.join("plugins/review");
        fs::create_dir_all(plugin.join("skills/review")).unwrap();
        fs::write(
            plugin.join("plugin.json"),
            r#"{"name":"review","version":"1.2.0","description":"Review code","skills":"skills","agents":"agents"}"#,
        )
        .unwrap();
        fs::write(plugin.join("skills/review/SKILL.md"), "# Review").unwrap();
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(
            root.join(".claude-plugin/marketplace.json"),
            r#"{"name":"team","plugins":[{"name":"review","source":"./plugins/review","version":"1.0.0"}]}"#,
        )
        .unwrap();

        let plugins = scan_marketplace(&root, "Team");
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].plugin.version.as_deref(), Some("1.2.0"));
        assert_eq!(plugins[0].plugin.skill_count, 1);
        assert_eq!(plugins[0].relative_path, "plugins/review");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn direct_git_sources_remember_detected_plugin_subdirectories() {
        let root =
            env::temp_dir().join(format!("melody-direct-git-plugin-test-{}", Uuid::new_v4()));
        let nested = root.join("plugins/review");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("plugin.json"),
            r#"{"name":"review","version":"1.0.0"}"#,
        )
        .unwrap();

        let (plugin_path, subdir) = resolve_direct_git_plugin_path(&root, None).unwrap();
        assert_eq!(plugin_path, nested.canonicalize().unwrap());
        assert_eq!(subdir.as_deref(), Some("plugins/review"));
        let (same_path, same_subdir) =
            resolve_direct_git_plugin_path(&root, Some("plugins/review")).unwrap();
        assert_eq!(same_path, plugin_path);
        assert_eq!(same_subdir, subdir);
        assert!(resolve_direct_git_plugin_path(&root, Some("../outside")).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_copy_skips_symlinks_and_enforces_install_identity() {
        let root = env::temp_dir().join(format!("melody-plugin-copy-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("plugin.json"), "{}").unwrap();
        #[cfg(unix)]
        {
            let outside = root.join("outside.txt");
            fs::write(&outside, "secret").unwrap();
            std::os::unix::fs::symlink(outside, source.join("secret.txt")).unwrap();
        }
        copy_directory_safely(&source, &destination).unwrap();
        assert!(destination.join("plugin.json").is_file());
        #[cfg(unix)]
        assert!(!destination.join("secret.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_loader_preserves_marketplace_install_provenance() {
        let root = env::temp_dir().join(format!("melody-plugin-registry-test-{}", Uuid::new_v4()));
        let install_dir = root.join("installed-plugins");
        let plugin_path = install_dir.join("review-12345678");
        fs::create_dir_all(&plugin_path).unwrap();
        fs::write(
            plugin_path.join("plugin.json"),
            r#"{"name":"review","version":"2.0.0"}"#,
        )
        .unwrap();
        fs::create_dir_all(&install_dir).unwrap();
        fs::write(
            install_dir.join("registry.json"),
            json!({
                "version": 1,
                "repos": {
                    "review-12345678": {
                        "path": plugin_path,
                        "plugins": { "review": { "version": "2.0.0" } },
                        "marketplace": {
                            "source_url_or_path": "https://example.test/team.git",
                            "source_display_name": "Team",
                            "plugin_subdir": "plugins/review"
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let registry = read_registry(&install_dir).unwrap();
        let installed = installed_plugins(&registry, &install_dir).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].marketplace.as_deref(), Some("Team"));
        assert_eq!(installed[0].installed_version.as_deref(), Some("2.0.0"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_install_and_update_keep_registry_compatibility() {
        let root = env::temp_dir().join(format!("melody-plugin-install-test-{}", Uuid::new_v4()));
        let install_dir = root.join("installed-plugins");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("plugin.json"),
            r#"{"name":"review","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::create_dir_all(&install_dir).unwrap();
        fs::write(
            install_dir.join("registry.json"),
            r#"{"version":1,"preserved":"value","repos":{}}"#,
        )
        .unwrap();

        let key = repo_key("review", "https://example.test/team.git#plugins/review");
        install_snapshot(
            &install_dir,
            &key,
            &source,
            "review",
            Some("1.0.0"),
            json!({ "type": "Git", "url": "https://example.test/team.git" }),
            Some(("https://example.test/team.git", "Team", "plugins/review")),
            false,
        )
        .unwrap();

        let registry = read_registry(&install_dir).unwrap();
        assert_eq!(registry["preserved"], "value");
        assert_eq!(
            registry["repos"][&key]["plugins"]["review"]["version"],
            "1.0.0"
        );
        assert_eq!(
            registry["repos"][&key]["marketplace"]["source_display_name"],
            "Team"
        );
        let installed = installed_plugins(&registry, &install_dir).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(
            installed[0].plugin_subdir.as_deref(),
            Some("plugins/review")
        );

        fs::write(
            source.join("plugin.json"),
            r#"{"name":"review","version":"2.0.0"}"#,
        )
        .unwrap();
        fs::write(source.join("updated.txt"), "updated").unwrap();
        install_snapshot(
            &install_dir,
            &key,
            &source,
            "review",
            Some("2.0.0"),
            json!({ "type": "Git", "url": "https://example.test/team.git" }),
            Some(("https://example.test/team.git", "Team", "plugins/review")),
            true,
        )
        .unwrap();

        let registry = read_registry(&install_dir).unwrap();
        assert_eq!(
            registry["repos"][&key]["plugins"]["review"]["version"],
            "2.0.0"
        );
        assert!(install_dir.join(&key).join("updated.txt").is_file());
        assert_eq!(installed_plugins(&registry, &install_dir).unwrap().len(), 1);
        assert!(
            fs::read_dir(&install_dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().starts_with(".backup-"))
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_marketplace_candidates_install_and_refresh_through_the_native_path() {
        let root =
            env::temp_dir().join(format!("melody-native-marketplace-test-{}", Uuid::new_v4()));
        let marketplace_root = root.join("marketplace");
        let plugin_root = marketplace_root.join("plugins/review");
        let install_dir = root.join("installed-plugins");
        fs::create_dir_all(&plugin_root).unwrap();
        fs::write(
            plugin_root.join("plugin.json"),
            r#"{"name":"review","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::create_dir_all(&install_dir).unwrap();
        let source = MarketplaceSource {
            name: "Team".to_string(),
            kind: "local".to_string(),
            location: marketplace_root.to_string_lossy().into_owned(),
            branch: None,
        };
        let identity = source_identity(&source, &root).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let mut candidates = scan_marketplace(&marketplace_root, &source.name);
        assert_eq!(candidates.len(), 1);
        let name = runtime
            .block_on(install_marketplace_candidate(
                &candidates[0],
                &source,
                &identity,
                &install_dir,
                false,
                None,
            ))
            .unwrap();
        assert_eq!(name, "review");
        let registry = read_registry(&install_dir).unwrap();
        let installed = installed_plugins(&registry, &install_dir).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].marketplace.as_deref(), Some("Team"));
        assert_eq!(installed[0].installed_version.as_deref(), Some("1.0.0"));

        fs::write(
            plugin_root.join("plugin.json"),
            r#"{"name":"review","version":"2.0.0"}"#,
        )
        .unwrap();
        candidates = scan_marketplace(&marketplace_root, &source.name);
        runtime
            .block_on(install_marketplace_candidate(
                &candidates[0],
                &source,
                &identity,
                &install_dir,
                true,
                Some(&installed[0].repo_key),
            ))
            .unwrap();
        let registry = read_registry(&install_dir).unwrap();
        let refreshed = installed_plugins(&registry, &install_dir).unwrap();
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].installed_version.as_deref(), Some("2.0.0"));
        assert_eq!(refreshed[0].marketplace.as_deref(), Some("Team"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_paths_cannot_read_outside_the_plugin_install_directory() {
        let root = env::temp_dir().join(format!("melody-plugin-path-test-{}", Uuid::new_v4()));
        let install_dir = root.join("installed-plugins");
        let outside = root.join("outside");
        fs::create_dir_all(&install_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("plugin.json"), r#"{"name":"outside-plugin"}"#).unwrap();
        let registry = json!({
            "version": 1,
            "repos": {
                "outside": {
                    "path": outside,
                    "plugins": { "outside-plugin": { "version": "1.0.0" } }
                }
            }
        });

        assert!(
            installed_plugins(&registry, &install_dir)
                .unwrap()
                .is_empty()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_message_does_not_treat_two_invalid_versions_as_equal() {
        let root = env::temp_dir().join(format!("melody-plugin-version-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("plugin.json"),
            r#"{"name":"review","version":"unknown-new"}"#,
        )
        .unwrap();

        assert_eq!(
            update_message("review", Some("unknown-old"), &root),
            "review 已更新。"
        );
        assert_eq!(
            update_message("review", Some("unknown-new"), &root),
            "review 已是最新版本。"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn require_sha_only_accepts_full_hex_commit_ids() {
        assert!(validate_git_sha("0123456789abcdef0123456789abcdef01234567").is_ok());
        assert!(validate_git_sha("abcdef").is_err());
        assert!(validate_git_sha("-0123456789abcdef0123456789abcdef01234567").is_err());
    }
}
