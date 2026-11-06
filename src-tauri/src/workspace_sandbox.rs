//! OS-level confinement for Host-run terminal children.
//!
//! Melody-build applies its sandbox once at agent-process startup (`nono`:
//! Seatbelt on macOS, Landlock on Linux), which covers the process and
//! everything it spawns. The desktop Host cannot do that: it is a long-lived
//! GUI process that must keep full access to the user's machine. So the same
//! rules are applied to **each terminal child** instead — the command the model
//! runs is confined even though the Host is not.
//!
//! Scope and honesty rules:
//!
//! * Only filesystem confinement is implemented. Melody's `read-only`/`strict`
//!   profiles also restrict child networking (seccomp/bwrap), so they resolve to
//!   [`SandboxDecision::Unsupported`] rather than running with weaker isolation.
//! * A profile whose rules cannot be enforced on this platform (globs, network
//!   restriction, Linux deny paths, old Linux kernels, Windows) is reported as
//!   unsupported; the caller must refuse the command instead of running it
//!   unsandboxed.
//! * Allow/deny paths are canonicalized before they reach the kernel: Seatbelt
//!   matches the *resolved* path, so a rule written for `/tmp/...` silently
//!   never matches on macOS where `/tmp` is `/private/tmp`.

use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod landlock;
mod profile;
#[cfg(target_os = "macos")]
mod seatbelt;

pub(crate) use profile::{SandboxProfile, resolve_profile};
#[cfg(target_os = "linux")]
use profile::{canonical, melody_state_dir};

#[cfg(target_os = "linux")]
use landlock::LandlockRules;

/// Device files a CLI needs as a write sink. Without these, common tools break
/// because they cannot open `/dev/null`, allocate a PTY or seed an RNG.
const DEVICE_FILES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/ptmx",
];

/// Device directories a CLI needs write access to (PTY slaves, fd table).
const DEVICE_DIRS: &[&str] = &["/dev/pts", "/dev/fd"];

/// Environment override Melody reads for the sandbox profile. Exposed so the
/// config layer and the sandbox layer cannot disagree about the variable name.
pub(crate) const PROFILE_ENV_VAR: &str = "MELODY_SANDBOX";

/// How the Host must run a terminal command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SandboxDecision {
    /// No profile is configured; run the command normally.
    Disabled,
    /// Run the command through this wrapper.
    Enforced(SandboxCommand),
    /// The configured profile cannot be enforced here. The caller must not run
    /// the command without isolation.
    /// Enforcement is impossible. The code distinguishes a platform without
    /// any implementation (the renderer degrades with a prominent warning)
    /// from a profile asking for isolation the Host cannot express (the
    /// renderer refuses to open the session).
    Unsupported(SandboxUnsupportedCode, String),
}

/// Machine-readable reasons why sandbox enforcement is unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SandboxUnsupportedCode {
    /// This OS has no enforcement implementation at all (currently Windows).
    PlatformUnsupported,
    /// The profile restricts child networking, which the Host cannot express.
    ProfileNetworkRestriction,
    /// The profile uses glob deny entries, which the Host cannot express.
    ProfileGlobDeny,
    /// The platform implementation exists but this machine cannot run it.
    PlatformBroken,
}

impl SandboxUnsupportedCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SandboxUnsupportedCode::PlatformUnsupported => "platform-unsupported",
            SandboxUnsupportedCode::ProfileNetworkRestriction => "profile-network-restriction",
            SandboxUnsupportedCode::ProfileGlobDeny => "profile-glob-deny",
            SandboxUnsupportedCode::PlatformBroken => "platform-broken",
        }
    }
}

/// A wrapped command line: `program` plus the arguments that carry the sandbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SandboxCommand {
    pub(crate) profile: String,
    pub(crate) program: PathBuf,
    /// Arguments placed before the user's command. On macOS this contains the
    /// Seatbelt profile and the shell; Linux installs Landlock in a pre-exec
    /// hook and uses `program` as the shell directly.
    pub(crate) prefix: Vec<String>,
    /// Directory subtrees the child may write to, for diagnostics.
    pub(crate) writable: Vec<PathBuf>,
    #[cfg(target_os = "linux")]
    landlock: LandlockRules,
}

/// These path sets must be disjoint so every supported platform can enforce
/// the profile without an allow rule weakening a read-only subtree.
fn has_read_only_read_write_overlap(profile: &SandboxProfile) -> bool {
    let overlaps_profile_write = profile.read_write.iter().any(|write| {
        profile
            .read_only
            .iter()
            .any(|read| write.starts_with(read) || read.starts_with(write))
    });
    let overlaps_device_write = profile.read_only.iter().any(|read| {
        DEVICE_FILES
            .iter()
            .any(|device| Path::new(device).starts_with(read))
            || DEVICE_DIRS.iter().any(|device| {
                let device = Path::new(device);
                device.starts_with(read) || read.starts_with(device)
            })
    });
    overlaps_profile_write || overlaps_device_write
}

/// Decide how a terminal command must run for this workspace.
pub(crate) fn sandbox_decision(
    workspace: &Path,
    requested: Option<&str>,
) -> Result<SandboxDecision, String> {
    let profile = resolve_profile(workspace, requested)?;
    sandbox_decision_for_profile(profile)
}

fn sandbox_decision_for_profile(
    profile: Option<SandboxProfile>,
) -> Result<SandboxDecision, String> {
    let Some(profile) = profile else {
        return Ok(SandboxDecision::Disabled);
    };
    if profile.restrict_network {
        return Ok(SandboxDecision::Unsupported(
            SandboxUnsupportedCode::ProfileNetworkRestriction,
            format!(
                "profile '{}' also restricts child networking, which the Host sandbox does not implement",
                profile.name
            ),
        ));
    }
    if !profile.deny_globs.is_empty() {
        return Ok(SandboxDecision::Unsupported(
            SandboxUnsupportedCode::ProfileGlobDeny,
            format!(
                "profile '{}' uses glob deny entries ({}) that the Host sandbox cannot enforce",
                profile.name,
                profile.deny_globs.join(", ")
            ),
        ));
    }
    if has_read_only_read_write_overlap(&profile) {
        return Ok(SandboxDecision::Unsupported(
            SandboxUnsupportedCode::PlatformBroken,
            "sandbox read-only and read-write paths overlap and cannot be enforced safely"
                .to_string(),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        return match seatbelt::command(&profile) {
            Ok(command) => Ok(SandboxDecision::Enforced(command)),
            Err(reason) => Ok(SandboxDecision::Unsupported(
                SandboxUnsupportedCode::PlatformBroken,
                reason,
            )),
        };
    }
    #[cfg(target_os = "linux")]
    {
        let landlock = match landlock::preflight(&profile) {
            Ok(rules) => rules,
            Err(reason) => {
                return Ok(SandboxDecision::Unsupported(
                    SandboxUnsupportedCode::PlatformBroken,
                    reason,
                ));
            }
        };
        return Ok(SandboxDecision::Enforced(SandboxCommand {
            profile: profile.name.clone(),
            // Landlock is installed in a pre-exec hook, so the shell itself is
            // the command program rather than a separate wrapper executable.
            program: PathBuf::from("/bin/sh"),
            prefix: Vec::new(),
            writable: profile.read_write.clone(),
            landlock,
        }));
    }
    #[allow(unreachable_code)]
    Ok(SandboxDecision::Unsupported(
        SandboxUnsupportedCode::PlatformUnsupported,
        format!(
            "OS sandbox enforcement is not implemented for {} yet",
            std::env::consts::OS
        ),
    ))
}

/// Host-side answer to "can this workspace run under the OS sandbox?".
///
/// The capability preflight needs this from the Host rather than guessing from
/// config: only the Host knows the platform mechanism, whether the wrapper
/// binary exists, and whether the profile's rules are expressible.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSandboxPlan {
    /// Configured profile name, absent when no sandbox applies.
    pub(crate) profile: Option<String>,
    /// Whether terminal children would actually be confined.
    pub(crate) enforceable: bool,
    /// Why enforcement is unavailable, when it is.
    pub(crate) reason: Option<String>,
    /// Machine-readable reason (`platform-unsupported` means the OS has no
    /// enforcement implementation and the session degrades to unsandboxed with
    /// a prominent warning; every other code refuses to open).
    pub(crate) reason_code: Option<String>,
}

#[tauri::command]
pub fn read_workspace_sandbox_plan(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<WorkspaceSandboxPlan, String> {
    let cwd = registry.authorize(&cwd)?;
    let requested = crate::config_runtime::pi_sandbox_profile(&cwd.to_string_lossy());
    let Some(requested) = requested else {
        return Ok(WorkspaceSandboxPlan::default());
    };
    let decision = sandbox_decision(&cwd, Some(&requested))?;
    Ok(match decision {
        SandboxDecision::Disabled => WorkspaceSandboxPlan::default(),
        SandboxDecision::Enforced(_) => WorkspaceSandboxPlan {
            profile: Some(requested),
            enforceable: true,
            reason: None,
            reason_code: None,
        },
        SandboxDecision::Unsupported(code, reason) => WorkspaceSandboxPlan {
            profile: Some(requested),
            enforceable: false,
            reason: Some(reason),
            reason_code: Some(code.as_str().to_string()),
        },
    })
}

/// The shell program and flag for a command, per platform and shell mode.
fn shell_argv(login: bool) -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("cmd.exe", "/C")
    } else if login {
        ("/bin/sh", "-lc")
    } else {
        ("/bin/sh", "-c")
    }
}

/// Build the shell command that runs `command` for a workspace.
///
/// This is the single place that turns a model-supplied command into a process,
/// so every execution path (foreground terminal, background terminal, monitor)
/// is confined by the same decision. A profile that cannot be enforced fails
/// closed here: returning a plain shell would silently bypass the isolation the
/// user configured.
///
/// `login` selects an interactive login shell (`-lc`, terminals) versus a plain
/// command shell (`-c`, monitors), matching what each tool did before.
pub(crate) fn sandboxed_shell_command(
    workspace: &Path,
    requested: Option<&str>,
    command: &str,
    login: bool,
) -> Result<std::process::Command, String> {
    let (shell, flag) = shell_argv(login);
    let mut process = match sandbox_decision(workspace, requested)
        .map_err(|error| format!("sandbox profile could not be resolved: {error}"))?
    {
        SandboxDecision::Disabled => std::process::Command::new(shell),
        SandboxDecision::Unsupported(_, reason) => {
            return Err(format!(
                "the configured OS sandbox cannot be enforced by the Host: {reason}"
            ));
        }
        SandboxDecision::Enforced(sandbox) => {
            let mut process = std::process::Command::new(&sandbox.program);
            process.args(&sandbox.prefix);
            #[cfg(target_os = "linux")]
            {
                landlock::install(&mut process, &sandbox.landlock)?;
            }
            #[cfg(not(target_os = "linux"))]
            process.arg(shell);
            process
        }
    };
    // The command is one argv element: it is a shell command by contract, never
    // concatenated into a wrapper string.
    process.arg(flag).arg(command);
    Ok(process)
}
