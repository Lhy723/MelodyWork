//! macOS Seatbelt adapter for an already resolved Host sandbox profile.
//! Common profile and fail-closed policy decisions stay in the parent; this
//! module verifies the local executor and turns those authorized path sets
//! into the complete wrapped command.

use std::path::{Path, PathBuf};

use super::{DEVICE_DIRS, DEVICE_FILES, SandboxCommand, SandboxProfile};

const EXECUTOR: &str = "/usr/bin/sandbox-exec";

/// Escape a path for a Seatbelt string literal.
fn literal(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Build the Seatbelt profile for the resolved rules.
fn profile_rules(profile: &SandboxProfile) -> String {
    let mut rules = String::from("(version 1)\n(allow default)\n");
    // Writes are denied by default and re-allowed per subtree, so a command can
    // only touch the workspace, Melody's state and temp directories.
    rules.push_str("(deny file-write*)\n");
    for path in &profile.read_write {
        rules.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            literal(path)
        ));
    }
    // Device files are write sinks, not directories.
    for device in DEVICE_FILES {
        rules.push_str(&format!("(allow file-write* (literal \"{device}\"))\n"));
    }
    for device in DEVICE_DIRS {
        rules.push_str(&format!("(allow file-write* (subpath \"{device}\"))\n"));
    }
    // Preserve the established output ordering without assuming rule precedence.
    for path in &profile.deny {
        rules.push_str(&format!(
            "(deny file-read* file-write* (subpath \"{}\"))\n",
            literal(path)
        ));
    }
    rules
}

/// Produce the complete Seatbelt command or a reason the Host must fail closed.
pub(super) fn command(profile: &SandboxProfile) -> Result<SandboxCommand, String> {
    if !Path::new(EXECUTOR).exists() {
        return Err("sandbox-exec is unavailable on this macOS install".to_string());
    }

    Ok(SandboxCommand {
        profile: profile.name.clone(),
        program: PathBuf::from(EXECUTOR),
        prefix: vec!["-p".to_string(), profile_rules(profile)],
        writable: profile.read_write.clone(),
    })
}
