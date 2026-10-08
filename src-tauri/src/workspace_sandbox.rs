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

use crate::config_runtime::user_home;

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

/// The resolved filesystem rules for one workspace.
#[derive(Clone, Debug)]
pub(crate) struct SandboxProfile {
    pub(crate) name: String,
    /// Subtrees the child may read and write.
    pub(crate) read_write: Vec<PathBuf>,
    /// Paths the child may read but not write.
    pub(crate) read_only: Vec<PathBuf>,
    /// Paths denied for both read and write.
    pub(crate) deny: Vec<PathBuf>,
    /// Glob-style deny entries, which Seatbelt would need anchored regexes for.
    pub(crate) deny_globs: Vec<String>,
    /// Whether the profile also restricts child networking.
    pub(crate) restrict_network: bool,
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Temporary directories a child may write to, mirroring Melody's table.
fn temp_writable_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/tmp"), PathBuf::from("/var/tmp")];
    if cfg!(target_os = "macos") {
        for candidate in ["/private/tmp", "/private/var/tmp", "/private/var/folders"] {
            let path = PathBuf::from(candidate);
            if path.is_dir() {
                paths.push(path);
            }
        }
    }
    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let path = PathBuf::from(&tmpdir);
        if path.is_dir() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

/// Melody's state directory, always writable so agent bookkeeping keeps working.
fn melody_state_dir() -> PathBuf {
    std::env::var_os("MELODY_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            user_home()
                .unwrap_or_else(|_| PathBuf::from("/tmp"))
                .join(".melody")
        })
}

/// Split deny entries: exact paths are enforced directly, globs need a matcher
/// this module does not implement.
fn split_deny(entries: &[String], workspace: &Path) -> (Vec<PathBuf>, Vec<String>) {
    let mut exact = Vec::new();
    let mut globs = Vec::new();
    for entry in entries {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('*') || trimmed.contains('?') || trimmed.contains('[') {
            globs.push(trimmed.to_string());
            continue;
        }
        let expanded = match trimmed.strip_prefix("~/") {
            Some(relative) => user_home()
                .unwrap_or_else(|_| PathBuf::from("/"))
                .join(relative),
            None => {
                let path = PathBuf::from(trimmed);
                if path.is_absolute() {
                    path
                } else {
                    workspace.join(path)
                }
            }
        };
        exact.push(canonical(&expanded));
    }
    (exact, globs)
}

fn path_strings(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths.iter().map(|path| canonical(path)).collect()
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct LandlockRules {
    /// Trees that receive the filesystem write rights in the child.
    read_write: Vec<PathBuf>,
    /// Trees that are explicitly read-only. The root read rule already grants
    /// their read access; retaining the list lets us reject an overlapping
    /// write rule instead of silently weakening the profile.
    read_only: Vec<PathBuf>,
}

#[cfg(target_os = "linux")]
const LANDLOCK_CREATE_RULESET_VERSION: libc::c_int = 1;

#[cfg(target_os = "linux")]
const LANDLOCK_RULE_TYPE_PATH_BENEATH: libc::c_int = 1;

#[cfg(target_os = "linux")]
// libc does not expose this prctl operation on every supported Linux target.
const PR_SET_NO_NEW_PRIVS: libc::c_int = 38;

#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 13;
#[cfg(target_os = "linux")]
const LANDLOCK_ACCESS_FS_TRUNCATE: u64 = 1 << 14;

#[cfg(target_os = "linux")]
const LANDLOCK_READ_ACCESS: u64 =
    LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;

#[cfg(target_os = "linux")]
const LANDLOCK_WRITE_ACCESS: u64 = LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_MAKE_CHAR
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_SOCK
    | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER
    | LANDLOCK_ACCESS_FS_TRUNCATE;

#[cfg(target_os = "linux")]
#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: libc::c_int,
}

#[cfg(target_os = "linux")]
fn landlock_syscall_error(operation: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Other,
        format!("{operation}: {}", std::io::Error::last_os_error()),
    )
}

/// Return the Landlock ABI version, or a stable reason suitable for the
/// capability preflight. ABI 3 is required because it covers path references
/// and truncation; older kernels would otherwise permit a write operation that
/// the profile says must be blocked.
#[cfg(target_os = "linux")]
fn landlock_abi_version() -> Result<u32, String> {
    let version = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<LandlockRulesetAttr>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if version < 0 {
        return Err(format!(
            "Landlock is unavailable on this Linux kernel: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(version as u32)
}

#[cfg(target_os = "linux")]
fn path_is_within(path: &Path, parent: &Path) -> bool {
    path == parent || path.starts_with(parent)
}

#[cfg(target_os = "linux")]
fn validate_landlock_paths(profile: &SandboxProfile) -> Result<(), String> {
    if !profile.deny.is_empty() {
        return Err(
            "custom deny paths cannot be represented by Landlock's allow-only hierarchy"
                .to_string(),
        );
    }
    let state_dir = canonical(&melody_state_dir());
    for path in &profile.read_write {
        if !path.exists() {
            if path != &state_dir {
                return Err(format!(
                    "sandbox writable path '{}' does not exist and cannot be opened before exec",
                    path.display()
                ));
            }
            std::fs::create_dir_all(path).map_err(|error| {
                format!(
                    "sandbox state path '{}' does not exist and could not be created: {error}",
                    path.display()
                )
            })?;
        }
    }
    for path in &profile.read_only {
        if !path.exists() {
            return Err(format!(
                "sandbox path '{}' does not exist and cannot be opened before exec",
                path.display()
            ));
        }
    }
    if profile.read_write.iter().any(|write| {
        profile
            .read_only
            .iter()
            .any(|read| path_is_within(write, read) || path_is_within(read, write))
    }) {
        return Err(
            "sandbox read-only and read-write paths overlap and cannot be enforced safely"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn supported_landlock_access(abi: u32) -> u64 {
    // ABI 1 has all rights except REFER; ABI 2 adds REFER and ABI 3 adds
    // TRUNCATE. `sandbox_decision` requires ABI 3 before this is called.
    let mut access =
        LANDLOCK_WRITE_ACCESS & !LANDLOCK_ACCESS_FS_REFER & !LANDLOCK_ACCESS_FS_TRUNCATE;
    if abi >= 2 {
        access |= LANDLOCK_ACCESS_FS_REFER;
    }
    if abi >= 3 {
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }
    LANDLOCK_READ_ACCESS | access
}

#[cfg(target_os = "linux")]
fn add_landlock_path_rule(
    ruleset_fd: libc::c_int,
    path: &Path,
    allowed_access: u64,
) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sandbox path contains NUL: {}", path.display()),
        )
    })?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_PATH | libc::O_CLOEXEC,
            libc::O_RDONLY,
        )
    };
    if fd < 0 {
        return Err(landlock_syscall_error("open sandbox path"));
    }
    let rule = LandlockPathBeneathAttr {
        allowed_access,
        parent_fd: fd,
    };
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_add_rule,
            ruleset_fd,
            LANDLOCK_RULE_TYPE_PATH_BENEATH,
            &rule,
            0u32,
        )
    };
    let close_result = unsafe { libc::close(fd) };
    if result < 0 {
        return Err(landlock_syscall_error("landlock_add_rule"));
    }
    if close_result < 0 {
        return Err(landlock_syscall_error("close sandbox path"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
struct PreparedLandlock {
    ruleset_fd: libc::c_int,
}

#[cfg(target_os = "linux")]
impl PreparedLandlock {
    fn close(&mut self) -> std::io::Result<()> {
        if self.ruleset_fd < 0 {
            return Ok(());
        }
        let fd = self.ruleset_fd;
        self.ruleset_fd = -1;
        let result = unsafe { libc::close(fd) };
        if result < 0 {
            return Err(landlock_syscall_error("close landlock ruleset"));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Drop for PreparedLandlock {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// Build a ruleset in the Host before forking. Only the irreversible
/// `restrict_self` operation runs in the child; the successful `pre_exec`
/// path therefore performs no filesystem opens or heap allocations.
#[cfg(target_os = "linux")]
fn prepare_landlock(rules: &LandlockRules) -> std::io::Result<PreparedLandlock> {
    let version = landlock_abi_version().map_err(std::io::Error::other)?;
    if version < 3 {
        return Err(std::io::Error::other(format!(
            "Landlock ABI {version} is too old; ABI 3 or newer is required"
        )));
    }
    let handled_access_fs = supported_landlock_access(version);
    let attr = LandlockRulesetAttr { handled_access_fs };
    let ruleset_fd = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr,
            std::mem::size_of::<LandlockRulesetAttr>(),
            0u32,
        )
    };
    if ruleset_fd < 0 {
        return Err(landlock_syscall_error("landlock_create_ruleset"));
    }
    let ruleset_fd = ruleset_fd as libc::c_int;
    let result = (|| -> std::io::Result<PreparedLandlock> {
        // Read/execute access is intentionally granted to the filesystem root,
        // matching the existing macOS `(allow default)` read semantics. Write
        // rights are only granted to the explicit read-write subtrees below.
        add_landlock_path_rule(ruleset_fd, Path::new("/"), LANDLOCK_READ_ACCESS)?;
        for path in &rules.read_only {
            add_landlock_path_rule(ruleset_fd, path, LANDLOCK_READ_ACCESS)?;
        }
        for path in &rules.read_write {
            add_landlock_path_rule(ruleset_fd, path, handled_access_fs)?;
        }
        for path in DEVICE_FILES.iter().chain(DEVICE_DIRS.iter()).map(Path::new) {
            if path.exists() {
                add_landlock_path_rule(ruleset_fd, path, handled_access_fs)?;
            }
        }
        Ok(PreparedLandlock { ruleset_fd })
    })();
    match result {
        Ok(prepared) => Ok(prepared),
        Err(error) => {
            let _ = unsafe { libc::close(ruleset_fd) };
            Err(error)
        }
    }
}

#[cfg(target_os = "linux")]
fn restrict_landlock(prepared: &mut PreparedLandlock) -> std::io::Result<()> {
    let no_new_privs = unsafe { libc::syscall(libc::SYS_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if no_new_privs < 0 {
        let error = landlock_syscall_error("prctl(PR_SET_NO_NEW_PRIVS)");
        let _ = prepared.close();
        return Err(error);
    }
    let restricted =
        unsafe { libc::syscall(libc::SYS_landlock_restrict_self, prepared.ruleset_fd, 0u32) };
    if restricted < 0 {
        let error = landlock_syscall_error("landlock_restrict_self");
        let _ = prepared.close();
        return Err(error);
    }
    prepared.close()
}

/// Resolve the effective profile for a workspace.
///
/// `requested` is the configured profile name (`sandbox.profile` in Melody
/// config or the `MELODY_SANDBOX` environment override). Built-ins mirror
/// Melody's profiles; a custom name is accepted only when this module can
/// express its rules.
pub(crate) fn resolve_profile(
    workspace: &Path,
    requested: Option<&str>,
) -> Result<Option<SandboxProfile>, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let workspace = canonical(workspace);
    let name = requested.to_ascii_lowercase();
    if matches!(name.as_str(), "off" | "none") {
        return Ok(None);
    }
    let mut read_write = vec![melody_state_dir()];
    read_write.extend(temp_writable_paths());
    let (read_write, read_only, deny, deny_globs, restrict_network) = match name.as_str() {
        "workspace" => {
            let mut read_write = read_write.clone();
            read_write.push(workspace.clone());
            (read_write, Vec::new(), Vec::new(), Vec::new(), false)
        }
        "devbox" => {
            let mut read_write = read_write.clone();
            read_write.push(workspace.clone());
            (read_write, Vec::new(), Vec::new(), Vec::new(), false)
        }
        // These two profiles also restrict child networking, which this module
        // does not implement; the caller must keep the compatibility engine.
        "read-only" | "readonly" | "strict" => {
            (read_write.clone(), Vec::new(), Vec::new(), Vec::new(), true)
        }
        custom => {
            let entry = load_custom_profile(workspace.as_path(), custom)?;
            let (deny_paths, glows) = split_deny(&entry.deny, &workspace);
            let mut read_write = read_write.clone();
            for path in entry.read_write.iter() {
                let candidate = PathBuf::from(path);
                read_write.push(if candidate.is_absolute() {
                    canonical(&candidate)
                } else {
                    canonical(&workspace.join(candidate))
                });
            }
            let read_only_paths = entry
                .read_only
                .iter()
                .map(|path| {
                    let candidate = PathBuf::from(path);
                    if candidate.is_absolute() {
                        canonical(&candidate)
                    } else {
                        canonical(&workspace.join(candidate))
                    }
                })
                .collect::<Vec<_>>();
            (
                read_write,
                read_only_paths,
                deny_paths,
                glows,
                entry.restrict_network.unwrap_or(false),
            )
        }
    };
    Ok(Some(SandboxProfile {
        name: requested.to_string(),
        read_write: path_strings(&read_write),
        read_only: path_strings(&read_only),
        deny,
        deny_globs,
        restrict_network,
    }))
}

#[derive(Debug, Default, serde::Deserialize)]
struct CustomProfileEntry {
    #[serde(default)]
    read_only: Vec<String>,
    #[serde(default)]
    read_write: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default)]
    restrict_network: Option<bool>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct SandboxConfigFile {
    #[serde(default)]
    profiles: std::collections::HashMap<String, CustomProfileEntry>,
}

fn load_config_file(path: &Path) -> Option<SandboxConfigFile> {
    let content = std::fs::read_to_string(path).ok()?;
    toml::from_str(&content).ok()
}

/// Load a custom profile from `~/.melody/sandbox.toml` and the workspace's
/// `.melody/sandbox.toml`.
///
/// The project file may only *add* names: Melody refuses to let a workspace
/// redefine a user/enterprise profile, because a hollowed-out `deny` list would
/// keep the trusted name while removing its rules. The same rule applies here.
fn load_custom_profile(workspace: &Path, name: &str) -> Result<CustomProfileEntry, String> {
    let user_config =
        load_config_file(&melody_state_dir().join("sandbox.toml")).unwrap_or_default();
    if let Some(entry) = user_config.profiles.get(name) {
        return Ok(entry_clone(entry));
    }
    let project_config =
        load_config_file(&workspace.join(".melody").join("sandbox.toml")).unwrap_or_default();
    if let Some(entry) = project_config.profiles.get(name) {
        return Ok(entry_clone(entry));
    }
    Err(format!(
        "sandbox profile '{name}' is not defined by sandbox.toml and is not a built-in profile"
    ))
}

fn entry_clone(entry: &CustomProfileEntry) -> CustomProfileEntry {
    CustomProfileEntry {
        read_only: entry.read_only.clone(),
        read_write: entry.read_write.clone(),
        deny: entry.deny.clone(),
        restrict_network: entry.restrict_network,
    }
}

/// Escape a path for a Seatbelt string literal.
fn seatbelt_literal(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Build the Seatbelt (SBPL) profile for the resolved rules.
pub(crate) fn seatbelt_profile(profile: &SandboxProfile) -> String {
    let mut rules = String::from("(version 1)\n(allow default)\n");
    // Writes are denied by default and re-allowed per subtree, so a command can
    // only touch the workspace, Melody's state and temp directories.
    rules.push_str("(deny file-write*)\n");
    for path in &profile.read_write {
        rules.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            seatbelt_literal(path)
        ));
    }
    // Device files are write sinks, not directories.
    for device in DEVICE_FILES {
        rules.push_str(&format!("(allow file-write* (literal \"{device}\"))\n"));
    }
    for device in DEVICE_DIRS {
        rules.push_str(&format!("(allow file-write* (subpath \"{device}\"))\n"));
    }
    for path in &profile.read_only {
        rules.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            seatbelt_literal(path)
        ));
    }
    // The deny list is applied last so it wins over the allow rules above.
    for path in &profile.deny {
        rules.push_str(&format!(
            "(deny file-read* file-write* (subpath \"{}\"))\n",
            seatbelt_literal(path)
        ));
    }
    rules
}

/// Decide how a terminal command must run for this workspace.
pub(crate) fn sandbox_decision(
    workspace: &Path,
    requested: Option<&str>,
) -> Result<SandboxDecision, String> {
    let Some(profile) = resolve_profile(workspace, requested)? else {
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
    if cfg!(target_os = "macos") {
        if !Path::new("/usr/bin/sandbox-exec").exists() {
            return Ok(SandboxDecision::Unsupported(
                SandboxUnsupportedCode::PlatformBroken,
                "sandbox-exec is unavailable on this macOS install".to_string(),
            ));
        }
        return Ok(SandboxDecision::Enforced(SandboxCommand {
            profile: profile.name.clone(),
            program: PathBuf::from("/usr/bin/sandbox-exec"),
            prefix: vec!["-p".to_string(), seatbelt_profile(&profile)],
            writable: profile.read_write.clone(),
        }));
    }
    #[cfg(target_os = "linux")]
    {
        if let Err(reason) = validate_landlock_paths(&profile) {
            return Ok(SandboxDecision::Unsupported(
                SandboxUnsupportedCode::PlatformBroken,
                reason,
            ));
        }
        let abi = match landlock_abi_version() {
            Ok(abi) => abi,
            Err(reason) => {
                return Ok(SandboxDecision::Unsupported(
                    SandboxUnsupportedCode::PlatformBroken,
                    reason,
                ));
            }
        };
        if abi < 3 {
            return Ok(SandboxDecision::Unsupported(
                SandboxUnsupportedCode::PlatformBroken,
                format!("Landlock ABI {abi} is too old; ABI 3 or newer is required"),
            ));
        }
        return Ok(SandboxDecision::Enforced(SandboxCommand {
            profile: profile.name.clone(),
            // Landlock is installed in a pre-exec hook, so the shell itself is
            // the command program rather than a separate wrapper executable.
            program: PathBuf::from("/bin/sh"),
            prefix: Vec::new(),
            writable: profile.read_write.clone(),
            landlock: LandlockRules {
                read_write: profile.read_write.clone(),
                read_only: profile.read_only.clone(),
            },
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
                use std::os::unix::process::CommandExt;

                let mut prepared = prepare_landlock(&sandbox.landlock)
                    .map_err(|error| format!("could not prepare Landlock sandbox: {error}"))?;
                // `pre_exec` runs after fork and before exec, which is the only
                // safe point to install an irreversible Landlock ruleset
                // without also restricting the long-lived Tauri Host.
                unsafe {
                    process.pre_exec(move || restrict_landlock(&mut prepared));
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("melody-sandbox-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn every_execution_path_shares_one_sandbox_decision() {
        // The terminal (login shell) and the monitor (plain shell) must both be
        // confined; a path that builds its own shell would silently escape.
        let root = workspace("paths");
        let terminal = sandboxed_shell_command(&root, Some("workspace"), "echo hi", true).unwrap();
        let monitor = sandboxed_shell_command(&root, Some("workspace"), "echo hi", false).unwrap();
        for process in [&terminal, &monitor] {
            let program = format!("{:?}", process);
            #[cfg(target_os = "macos")]
            assert!(
                program.contains("sandbox-exec"),
                "both paths must run under the OS sandbox: {program}"
            );
            #[cfg(target_os = "linux")]
            assert!(
                program.contains("/bin/sh"),
                "both paths must use the Landlock shell path: {program}"
            );
        }
        // A profile that cannot be enforced is refused for both paths.
        assert!(
            sandboxed_shell_command(&root, Some("strict"), "echo hi", false).is_err(),
            "a monitor must not run unconfined either"
        );
        // Without a profile both keep their previous shell form.
        let plain_terminal = format!(
            "{:?}",
            sandboxed_shell_command(&root, None, "echo hi", true).unwrap()
        );
        assert!(plain_terminal.contains("\"/bin/sh\""), "{plain_terminal}");
        assert!(plain_terminal.contains("\"-lc\""), "{plain_terminal}");
        let plain_monitor = format!(
            "{:?}",
            sandboxed_shell_command(&root, None, "echo hi", false).unwrap()
        );
        assert!(plain_monitor.contains("\"-c\""), "{plain_monitor}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_profile_means_no_sandbox() {
        let root = workspace("off");
        assert_eq!(
            sandbox_decision(&root, None).unwrap(),
            SandboxDecision::Disabled
        );
        assert_eq!(
            sandbox_decision(&root, Some("off")).unwrap(),
            SandboxDecision::Disabled
        );
        assert_eq!(
            sandbox_decision(&root, Some("none")).unwrap(),
            SandboxDecision::Disabled
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_workspace_profile_confines_writes_to_expected_subtrees() {
        let root = workspace("workspace");
        let decision = sandbox_decision(&root, Some("workspace")).unwrap();
        let SandboxDecision::Enforced(command) = decision else {
            panic!("the workspace profile must be enforceable on this platform");
        };
        assert!(command.writable.contains(&root));
        // Melody always keeps its own state directory writable.
        assert!(
            command
                .writable
                .iter()
                .any(|path| path.ends_with(".melody"))
        );
        let profile =
            seatbelt_profile(&resolve_profile(&root, Some("workspace")).unwrap().unwrap());
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains(&seatbelt_literal(&root)));
        assert!(profile.contains("/dev/null"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_landlock_confines_the_child_to_read_write_subtrees() {
        let root = workspace("landlock");
        let outside = user_home()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(format!(".melody-landlock-outside-{}", uuid::Uuid::new_v4()));
        let Some(abi) = landlock_abi_version().ok() else {
            std::fs::remove_dir_all(root).unwrap();
            return;
        };
        if abi < 3 {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }

        let mut inside =
            sandboxed_shell_command(&root, Some("workspace"), "touch inside.txt", false).unwrap();
        let status = inside.current_dir(&root).status().unwrap();
        assert!(
            status.success(),
            "workspace writes should be allowed: {status}"
        );
        assert!(root.join("inside.txt").is_file());

        let mut login_shell =
            sandboxed_shell_command(&root, Some("workspace"), "touch login.txt", true).unwrap();
        let status = login_shell.current_dir(&root).status().unwrap();
        assert!(
            status.success(),
            "the terminal login shell should share the same Landlock policy: {status}"
        );
        assert!(root.join("login.txt").is_file());

        let command = format!("touch '{}'", outside.display());
        let mut outside_process =
            sandboxed_shell_command(&root, Some("workspace"), &command, false).unwrap();
        let status = outside_process.current_dir(&root).status().unwrap();
        assert!(
            !status.success(),
            "writes outside the workspace must be denied"
        );
        assert!(!outside.exists());

        std::fs::remove_file(root.join("inside.txt")).unwrap();
        std::fs::remove_file(root.join("login.txt")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profiles_with_network_restriction_are_refused_instead_of_weakened() {
        let root = workspace("readonly");
        for profile in ["read-only", "strict"] {
            match sandbox_decision(&root, Some(profile)).unwrap() {
                SandboxDecision::Unsupported(code, reason) => {
                    assert_eq!(code, SandboxUnsupportedCode::ProfileNetworkRestriction);
                    assert!(reason.contains("network"), "{reason}");
                }
                other => panic!("{profile} must not be silently weakened: {other:?}"),
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glob_deny_entries_are_refused() {
        let root = workspace("glob");
        std::fs::create_dir_all(root.join(".melody")).unwrap();
        std::fs::write(
            root.join(".melody/sandbox.toml"),
            "[profiles.locked]\ndeny = [\"**/.env\", \"secrets/*\"]\n",
        )
        .unwrap();
        match sandbox_decision(&root, Some("locked")).unwrap() {
            SandboxDecision::Unsupported(code, reason) => {
                assert_eq!(code, SandboxUnsupportedCode::ProfileGlobDeny);
                assert!(reason.contains("glob"), "{reason}");
            }
            other => panic!("glob denies must not be silently dropped: {other:?}"),
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_custom_profile_denies_paths_and_unknown_names_are_rejected() {
        let root = workspace("custom");
        std::fs::create_dir_all(root.join(".melody")).unwrap();
        std::fs::write(
            root.join(".melody/sandbox.toml"),
            "[profiles.locked]\nread_write = [\"build\"]\ndeny = [\"src/locked.rs\"]\n",
        )
        .unwrap();
        let profile = resolve_profile(&root, Some("locked")).unwrap().unwrap();
        assert!(
            profile.read_write.contains(
                &root
                    .join("build")
                    .canonicalize()
                    .unwrap_or(root.join("build"))
            )
        );
        assert_eq!(profile.deny.len(), 1);
        assert!(profile.deny[0].ends_with("locked.rs"));
        let rules = seatbelt_profile(&profile);
        assert!(rules.contains("deny file-read* file-write*"));
        assert!(resolve_profile(&root, Some("missing")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deny_paths_are_canonicalized_so_seatbelt_can_match_them() {
        let root = workspace("canonical");
        std::fs::create_dir_all(root.join(".melody")).unwrap();
        // `~`-relative and workspace-relative entries must resolve to real paths:
        // Seatbelt matches the resolved path, so an unresolved rule never fires.
        std::fs::write(
            root.join(".melody/sandbox.toml"),
            "[profiles.strictish]\ndeny = [\"secrets\", \"~/.ssh\"]\n",
        )
        .unwrap();
        let profile = resolve_profile(&root, Some("strictish")).unwrap().unwrap();
        assert_eq!(profile.deny.len(), 2);
        assert_eq!(profile.deny[0], root.join("secrets"));
        assert!(profile.deny[1].ends_with(".ssh"));
        assert!(profile.deny[1].is_absolute());
        std::fs::remove_dir_all(root).unwrap();
    }
}
