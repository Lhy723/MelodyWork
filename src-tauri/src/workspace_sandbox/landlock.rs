//! Linux Landlock enforcement for Host-run workspace commands.

use std::path::{Path, PathBuf};

use super::{DEVICE_DIRS, DEVICE_FILES, SandboxProfile, canonical, melody_state_dir};

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LandlockRules {
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
    Ok(())
}

/// Check whether this profile can be represented by the available Landlock
/// ABI, then keep only the path rules needed to install that confinement.
pub(super) fn preflight(profile: &SandboxProfile) -> Result<LandlockRules, String> {
    validate_landlock_paths(profile)?;
    let abi = landlock_abi_version()?;
    if abi < 3 {
        return Err(format!(
            "Landlock ABI {abi} is too old; ABI 3 or newer is required"
        ));
    }
    Ok(LandlockRules {
        read_write: profile.read_write.clone(),
        read_only: profile.read_only.clone(),
    })
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

/// Attach the prepared ruleset to a child process. Only the irreversible
/// `restrict_self` operation runs after fork, before the shell executes.
pub(super) fn install(
    process: &mut std::process::Command,
    rules: &LandlockRules,
) -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let mut prepared = prepare_landlock(rules)
        .map_err(|error| format!("could not prepare Landlock sandbox: {error}"))?;
    unsafe {
        process.pre_exec(move || restrict_landlock(&mut prepared));
    }
    Ok(())
}
