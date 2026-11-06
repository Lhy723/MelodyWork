//! Git transport and local cache lifecycle for configured Marketplace sources.
//!
//! This module owns URL/ref validation, deterministic source identities, Git
//! subprocess invocation, and the serialized cache refresh protocol. Plugin
//! metadata scanning and installation state remain with the marketplace
//! catalog owner.

use std::{
    collections::HashMap,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime},
};

use tokio::process::Command;
use uuid::Uuid;

use super::{MarketplaceSource, expand_path, melody_home};

const MARKETPLACE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

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

pub(super) fn source_identity(source: &MarketplaceSource, cwd: &Path) -> Result<String, String> {
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

pub(super) fn validate_git_url(url: &str) -> Result<&str, String> {
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

pub(super) fn validate_git_ref(git_ref: &str) -> Result<&str, String> {
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

pub(super) fn validate_git_sha(sha: &str) -> Result<&str, String> {
    let sha = sha.trim();
    if (sha.len() == 40 || sha.len() == 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        Err("Remote plugin SHA must be a full 40- or 64-character hexadecimal commit".to_string())
    }
}

fn stable_cache_name(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
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

pub(super) async fn clone_repository(
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

pub(super) async fn sync_marketplace_source(
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
