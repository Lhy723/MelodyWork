//! Host-controlled Pi worker executable discovery and child environment assembly.
//!
//! This module owns the packaging boundary and the scrubbed environment handed
//! to the worker. Process lifecycle, protocol dispatch, and restart decisions
//! remain with `PiWorkerRuntime`.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

use crate::{
    agent_runtime::melody_home,
    config_runtime::{pi_prompt_paths, pi_resource_manifest, pi_skill_paths},
    pi_model_config::PreparedPiModels,
};

/// The worker deliberately starts from an empty environment so ambient
/// secrets, package-manager settings and arbitrary process flags cannot leak
/// into the Pi sidecar.  Network transports and custom provider certificates
/// are the small set of user/system integration points that still need to
/// cross that boundary for an otherwise identical model configuration to
/// work (corporate proxies, air-gapped gateways, and private CAs).
pub(super) const INHERITED_WORKER_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "MELODY_AUTO_COMPACT_THRESHOLD_PERCENT",
    "MELODY_RESPECT_GITIGNORE",
    "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
    "MELODY_PI_GOAL_POLICY_JSON",
];

fn worker_executable_names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["melody-agent-worker.exe", "agent-worker.exe"]
    } else {
        ["melody-agent-worker", "agent-worker"]
    }
}

fn runtime_target_triples() -> &'static [&'static str] {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &["aarch64-apple-darwin"]
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        &["x86_64-apple-darwin"]
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        &["aarch64-pc-windows-msvc"]
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        &["x86_64-pc-windows-msvc"]
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        &["aarch64-unknown-linux-gnu"]
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        &["x86_64-unknown-linux-gnu"]
    } else {
        &[]
    }
}

fn worker_target_names() -> Vec<String> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let mut names = Vec::new();
    if let Some(target) = option_env!("MELODY_TARGET_TRIPLE") {
        names.push(format!("melody-agent-worker-{target}{extension}"));
    }
    for target in runtime_target_triples() {
        let name = format!("melody-agent-worker-{target}{extension}");
        if !names.iter().any(|candidate| candidate == &name) {
            names.push(name);
        }
    }
    names
}

fn add_worker_candidates(candidates: &mut Vec<PathBuf>, directory: &Path) {
    let names = worker_executable_names();
    candidates.extend(names.iter().map(|name| directory.join(name)));
    for target_name in worker_target_names() {
        candidates.push(directory.join(target_name));
    }
    // Tauri's `externalBin` may place a target-suffixed resource beside the
    // app executable without preserving the compile-time target environment
    // variable.  Restrict discovery to the exact platform names above; never
    // execute an arbitrary file merely because it starts with our prefix.
    if let Ok(entries) = fs::read_dir(directory) {
        let known_names = worker_target_names();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if known_names.iter().any(|candidate| candidate == name)
                && path.is_file()
                && !candidates.iter().any(|candidate| candidate == &path)
            {
                candidates.push(path);
            }
        }
    }
}

pub(super) fn resolve_worker_binary(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = env::var_os("MELODY_PI_WORKER_PATH") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(current_exe) = env::current_exe()
        && let Some(directory) = current_exe.parent()
    {
        add_worker_candidates(&mut candidates, directory);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        add_worker_candidates(&mut candidates, &resource_dir);
        add_worker_candidates(&mut candidates, &resource_dir.join("binaries"));
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for target_name in worker_target_names() {
        candidates.push(manifest.join("binaries").join(target_name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub(super) fn configure_worker_command(
    command: &mut Command,
    cwd: &Path,
    prepared_models: Option<&PreparedPiModels>,
    envrc: &[(String, String)],
    model_network_policy: Option<&(bool, Option<String>)>,
) {
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear();
    for key in INHERITED_WORKER_ENV {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    if let Some(home) = melody_home() {
        command.env("MELODY_HOME", &home);
        // Pi's native JSONL is kept in an app-owned directory. The worker
        // never falls back to ~/.pi, and the renderer cannot choose this
        // location; this keeps migration data separate from user Pi data.
        command.env("MELODY_PI_SESSION_ROOT", home.join("pi-sessions"));
        // Model credentials/catalogs follow the same app-owned boundary. An
        // explicit environment value is preserved as a deliberate dev or
        // managed-credential override; otherwise never inherit Pi's ambient
        // ~/.pi/agent files.
        command.env(
            "MELODY_PI_AUTH_PATH",
            env::var_os("MELODY_PI_AUTH_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("pi").join("auth.json")),
        );
        let models_path = prepared_models
            .map(|prepared| prepared.path.clone())
            .or_else(|| {
                env::var_os("MELODY_PI_MODELS_PATH")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| home.join("pi").join("models.json"));
        command.env("MELODY_PI_MODELS_PATH", models_path);
        if let Some((enabled, catalog_base_url)) = model_network_policy {
            command.env(
                "MELODY_PI_ALLOW_MODEL_NETWORK",
                if *enabled { "1" } else { "0" },
            );
            if let Some(url) = catalog_base_url {
                command.env("MELODY_PI_CATALOG_BASE_URL", url);
            }
        }
        if let Some(prepared) = prepared_models {
            command.env("MELODY_PI_MODEL_POLICIES_PATH", &prepared.policies_path);
        } else if let Some(path) =
            env::var_os("MELODY_PI_MODEL_POLICIES_PATH").filter(|value| !value.is_empty())
        {
            command.env("MELODY_PI_MODEL_POLICIES_PATH", path);
        }
        if let Ok(skill_paths) = pi_skill_paths(&cwd.to_string_lossy())
            && !skill_paths.is_empty()
        {
            command.env(
                "MELODY_PI_SKILL_PATHS_JSON",
                serde_json::to_string(&skill_paths).unwrap_or_else(|_| "[]".to_string()),
            );
        }
        let resource_manifest = pi_resource_manifest(&cwd.to_string_lossy())
            .ok()
            .or_else(|| {
                // Keep the worker usable when an optional config file is malformed,
                // but fail closed for delegation rather than silently restoring
                // every custom subagent policy.
                Some(json!({
                    "cwd": cwd.to_string_lossy(),
                    "skillRoots": [],
                    "promptRoots": [],
                    "respectGitignore": false,
                    "subagentPolicies": {
                        "enabled": false,
                        "models": {},
                        "toggle": {},
                        "roles": [],
                        "personas": [],
                        "agents": [],
                    },
                }))
            });
        if let Some(manifest) = resource_manifest.as_ref() {
            command.env(
                "MELODY_RESPECT_GITIGNORE",
                if manifest
                    .get("respectGitignore")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "1"
                } else {
                    "0"
                },
            );
            if let Some(policy) = manifest
                .get("questionTimeoutPolicy")
                .filter(|value| value.is_object())
            {
                command.env(
                    "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
                    serde_json::to_string(policy).unwrap_or_else(|_| "".to_string()),
                );
            }
            if let Some(policy) = manifest.get("goalPolicy").filter(|value| value.is_object()) {
                command.env(
                    "MELODY_PI_GOAL_POLICY_JSON",
                    serde_json::to_string(policy).unwrap_or_else(|_| "".to_string()),
                );
            }
            command.env(
                "MELODY_PI_SKILL_ROOTS_JSON",
                serde_json::to_string(
                    manifest
                        .get("skillRoots")
                        .unwrap_or(&Value::Array(Vec::new())),
                )
                .unwrap_or_else(|_| "[]".to_string()),
            );
            command.env(
                "MELODY_PI_SUBAGENT_POLICIES_JSON",
                serde_json::to_string(manifest.get("subagentPolicies").unwrap_or(&json!({
                    "enabled": true,
                    "models": {},
                    "toggle": {},
                    "roles": [],
                    "personas": [],
                })))
                .unwrap_or_else(|_| {
                    "{\"enabled\":false,\"models\":{},\"toggle\":{},\"roles\":[],\"personas\":[]}"
                        .to_string()
                }),
            );
        }
        if let Ok(prompt_paths) = pi_prompt_paths(&cwd.to_string_lossy())
            && !prompt_paths.is_empty()
        {
            command.env(
                "MELODY_PI_PROMPT_PATHS_JSON",
                serde_json::to_string(&prompt_paths).unwrap_or_else(|_| "[]".to_string()),
            );
        }
        if let Some(manifest) = resource_manifest.as_ref() {
            command.env(
                "MELODY_PI_PROMPT_ROOTS_JSON",
                serde_json::to_string(
                    manifest
                        .get("promptRoots")
                        .unwrap_or(&Value::Array(Vec::new())),
                )
                .unwrap_or_else(|_| "[]".to_string()),
            );
        }
        // `.envrc` is evaluated by the Host under a scrubbed environment.
        // Inject it before generated model credentials so a project file
        // cannot shadow the short-lived values used by the model catalog.
        for (name, value) in envrc {
            command.env(name, value);
        }
        if let Some(prepared) = prepared_models {
            for (name, value) in &prepared.credentials {
                command.env(name, value);
            }
        }
    } else {
        // Keep explicit paths available for development even when the Host
        // cannot derive an application data root.
        for key in [
            "MELODY_PI_AUTH_PATH",
            "MELODY_PI_MODELS_PATH",
            "MELODY_PI_MODEL_POLICIES_PATH",
            "MELODY_PI_SKILL_PATHS_JSON",
            "MELODY_PI_SKILL_ROOTS_JSON",
            "MELODY_PI_PROMPT_PATHS_JSON",
            "MELODY_PI_PROMPT_ROOTS_JSON",
            "MELODY_RESPECT_GITIGNORE",
            "MELODY_PI_QUESTION_TIMEOUT_POLICY_JSON",
            "MELODY_PI_GOAL_POLICY_JSON",
            "MELODY_PI_ALLOW_MODEL_NETWORK",
            "MELODY_PI_CATALOG_BASE_URL",
        ] {
            if let Some(value) = env::var_os(key).filter(|value| !value.is_empty()) {
                command.env(key, value);
            }
        }
    }
}
