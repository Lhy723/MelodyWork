use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn sidecar_name(target: &str) -> String {
    if target.contains("windows") {
        "melody-pager.exe".to_string()
    } else {
        "melody-pager".to_string()
    }
}

fn candidate_sources(manifest_dir: &Path, target: &str, host: &str) -> Vec<PathBuf> {
    let binary = sidecar_name(target);
    let workspace_root = manifest_dir.parent().unwrap_or(manifest_dir);
    let embedded_root = if target == host {
        workspace_root.join("vendor/melody-build/target")
    } else {
        workspace_root
            .join("vendor/melody-build/target")
            .join(target)
    };
    let sibling_root = workspace_root
        .parent()
        .unwrap_or(workspace_root)
        .join("melody-build/target");
    let mut candidates = Vec::new();

    for profile in ["release", "debug"] {
        candidates.push(embedded_root.join(profile).join(&binary));
    }
    for profile in ["release", "debug"] {
        candidates.push(sibling_root.join(profile).join(&binary));
    }

    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let installed_name = if target.contains("windows") {
            "melody.exe"
        } else {
            "melody"
        };
        candidates.push(
            PathBuf::from(&home)
                .join(".melody/bin")
                .join(installed_name),
        );
        candidates.push(PathBuf::from(home).join(".grok/bin").join(installed_name));
    }

    candidates
}

fn prepare_sidecar() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown-target".to_string());
    let host = env::var("HOST").unwrap_or_else(|_| target.clone());
    let binary = format!(
        "melody-pager-{}{}",
        target,
        if target.contains("windows") {
            ".exe"
        } else {
            ""
        }
    );
    let destination = manifest_dir.join("binaries").join(binary);

    println!("cargo:rerun-if-env-changed=MELODY_PAGER_SOURCE");
    println!("cargo:rerun-if-env-changed=HOME");
    println!("cargo:rerun-if-env-changed=USERPROFILE");
    println!("cargo:rerun-if-changed=../vendor/melody-build/target");
    println!("cargo:rerun-if-changed=binaries");

    if destination.is_file() {
        return;
    }

    let mut candidates = Vec::new();
    if let Some(explicit) = env::var_os("MELODY_PAGER_SOURCE") {
        candidates.push(PathBuf::from(explicit));
    }
    candidates.extend(candidate_sources(&manifest_dir, &target, &host));

    let source = candidates.into_iter().find(|path| path.is_file());
    let Some(source) = source else {
        println!(
            "cargo:warning=Melody sidecar is missing for {target}. Run `node scripts/prepare-sidecar.mjs` or set MELODY_PAGER_SOURCE before building."
        );
        return;
    };

    if let Err(error) = fs::create_dir_all(manifest_dir.join("binaries")) {
        println!("cargo:warning=Could not create sidecar directory: {error}");
        return;
    }
    if let Err(error) = fs::copy(&source, &destination) {
        println!(
            "cargo:warning=Could not copy Melody sidecar from {}: {error}",
            source.display()
        );
        return;
    }

    #[cfg(unix)]
    if let Ok(metadata) = fs::metadata(&source) {
        let mut permissions = metadata.permissions();
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
        let _ = fs::set_permissions(&destination, permissions);
    }

    println!(
        "cargo:warning=Prepared Melody sidecar from {}",
        source.display()
    );
}

fn main() {
    prepare_sidecar();

    if let Ok(target) = env::var("TARGET") {
        println!("cargo:rustc-env=MELODY_TARGET_TRIPLE={target}");
    }
    tauri_build::build();
}
