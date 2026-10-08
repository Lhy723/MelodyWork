//! Host-owned, policy-checked tools exposed to the opt-in Pi worker.
//!
//! The worker is intentionally not given a filesystem implementation. It
//! emits a normalized tool.requested event and this module turns the bounded,
//! allowlisted request into a tool.resolve command. Every path is checked
//! against the worker's authorized workspace root before it is read or
//! changed; terminal execution is likewise bounded and audited by the Host.

use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Condvar, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc::{RecvTimeoutError, SyncSender, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};

use ignore::WalkBuilder;
use serde_json::{Map, Value, json};
use tauri::Manager;

use crate::config_runtime::PiTerminalPolicy;
use crate::workspace_runtime::{is_ignored_directory, safe_write_path};

const READ_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// A monitor command is a shell pipeline; keep it comparable to a prompt.
const MONITOR_MAX_COMMAND_BYTES: usize = 16 * 1024;
const TOOL_OUTPUT_READ_MAX_BYTES: u64 = 1024 * 1024;
const TOOL_OUTPUT_READ_DEFAULT_BYTES: u64 = 256 * 1024;
const READ_FILE_DEFAULT_LINES: usize = 400;
const READ_FILE_MAX_LINES: usize = 10_000;
const SEARCH_MAX_QUERY_BYTES: usize = 256;
const SEARCH_MAX_RESULTS: usize = 100;
const SEARCH_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const SEARCH_MAX_FILES: usize = 4_000;
const LIST_DIRECTORY_MAX_ENTRIES: usize = 2_000;
const LIST_DIRECTORY_MAX_DEPTH: usize = 8;
const LIST_DIRECTORY_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const WRITE_FILE_MAX_BYTES: usize = 2 * 1024 * 1024;
const PATCH_MAX_BYTES: usize = 2 * 1024 * 1024;
const TERMINAL_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const TERMINAL_ARCHIVE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const TERMINAL_ARCHIVE_MAX_FILES: usize = 32;
const TERMINAL_ARCHIVE_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const TERMINAL_ARCHIVE_RELATIVE_DIR: &str = ".melody/pi/tool-output";
const TERMINAL_ARCHIVE_FILE_PREFIX: &str = "pi-output-";
pub(crate) const MCP_ARCHIVE_FILE_PREFIX: &str = "mcp-output-";
const TERMINAL_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const TERMINAL_OUTPUT_CHANNEL_CAPACITY: usize = 32;
const GITIGNORED_ERROR_PREFIX: &str = "__melody_gitignored__:";
/// Stable opaque prefix used by worker-side task controls to distinguish a
/// Host-owned background terminal from a Pi child session task.
pub(crate) const PI_BACKGROUND_TERMINAL_TASK_PREFIX: &str = "pi-terminal-task:";
/// Internal worker-to-Host operation. It is never advertised as a model tool;
/// the worker uses it only after a caller explicitly asks for worktree
/// isolation on a subagent.
pub(crate) const CREATE_SUBAGENT_WORKTREE: &str = "workspace_create_subagent_worktree";
/// Internal worker preflight used to load path-scoped project instruction files.
/// It is not a model-facing tool and never authorizes the requested file I/O.
pub(crate) const INSTRUCTION_SCOPE_LOOKUP: &str = "melody_internal_instruction_scope";
const SUBAGENT_WORKTREE_RELATIVE_ROOT: &str = ".melody/pi/worktrees";
const BACKGROUND_TERMINAL_MAX_TASKS: usize = 64;
const BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES: usize = 64 * 1024;
const INSTRUCTION_SCOPE_MAX_PATHS: usize = 64;
const INSTRUCTION_SCOPE_MAX_FILES: usize = 32;
const INSTRUCTION_SCOPE_MAX_FILE_BYTES: u64 = 32 * 1024;
const INSTRUCTION_SCOPE_MAX_TOTAL_BYTES: usize = 64 * 1024;
const BACKGROUND_TASK_POLL_INTERVAL: Duration = Duration::from_millis(20);
// Melody-build's bash tool defaults to a two-minute timeout. Keep the Pi
// gateway default identical; callers may still request a shorter bound.
const TERMINAL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const TERMINAL_MAX_TIMEOUT: Duration = Duration::from_secs(120);

/// Pi may execute tools from different sessions (or child sessions) in
/// parallel.  `executionMode: "sequential"` only orders calls inside one Pi
/// session, so it cannot protect a shared workspace when two sessions edit
/// the same file.  Keep one conservative mutation gate per canonical
/// workspace. Reads remain parallel, while file writes, patches and terminal
/// commands cannot interleave with one another inside the same project.
static WORKSPACE_MUTATION_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();

fn workspace_mutation_lock(root: &Path) -> Arc<Mutex<()>> {
    let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let locks = WORKSPACE_MUTATION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .expect("workspace mutation lock registry must not be poisoned");
    // Do not retain a strong reference for every workspace ever opened. The
    // operation owns the returned `Arc` while it is queued/running; once the
    // last operation finishes, an idle workspace lock can be collected.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

pub(crate) const WORKSPACE_READ_FILE: &str = "workspace_read_file";
pub(crate) const WORKSPACE_READ_TOOL_OUTPUT: &str = "workspace_read_tool_output";
pub(crate) const WORKSPACE_SEARCH: &str = "workspace_search";
pub(crate) const WORKSPACE_LIST_DIRECTORY: &str = "workspace_list_directory";
pub(crate) const WORKSPACE_WRITE_FILE: &str = "workspace_write_file";
pub(crate) const WORKSPACE_EDIT: &str = "workspace_edit";
pub(crate) const WORKSPACE_APPLY_PATCH: &str = "workspace_apply_patch";
pub(crate) const RUN_TERMINAL_COMMAND: &str = "run_terminal_command";
/// Melody-build's streaming monitor tool: every output line becomes a
/// conversation notification. It is Host-owned because it starts a process.
pub(crate) const MONITOR: &str = "monitor";
/// Melody's scheduler tools, kept under their original names so a skill that
/// schedules work keeps working on the Pi path.
pub(crate) const SCHEDULER_CREATE: &str = "scheduler_create";
pub(crate) const SCHEDULER_LIST: &str = "scheduler_list";
pub(crate) const SCHEDULER_DELETE: &str = "scheduler_delete";
pub(crate) const ASK_USER_QUESTION: &str = "ask_user_question";
pub(crate) const UPDATE_PLAN: &str = "update_plan";
pub(crate) const SPAWN_SUBAGENT: &str = "spawn_subagent";
pub(crate) const RUN_BACKGROUND_TASK: &str = "run_background_task";
pub(crate) const GET_COMMAND_OR_SUBAGENT_OUTPUT: &str = "get_command_or_subagent_output";
pub(crate) const WAIT_COMMANDS_OR_SUBAGENTS: &str = "wait_commands_or_subagents";
pub(crate) const KILL_COMMAND_OR_SUBAGENT: &str = "kill_command_or_subagent";
pub(crate) const MCP_LIST_TOOLS: &str = "mcp_list_tools";
pub(crate) const MCP_CALL_TOOL: &str = "mcp_call_tool";
pub(crate) const WEB_SEARCH: &str = "web_search";
pub(crate) const WEB_FETCH: &str = "web_fetch";
pub(crate) const BROWSER_NAVIGATE: &str = "browser_navigate";
pub(crate) const BROWSER_TABS: &str = "browser_tabs";
pub(crate) const BROWSER_SNAPSHOT: &str = "browser_snapshot";
pub(crate) const BROWSER_WAIT: &str = "browser_wait";
pub(crate) const BROWSER_SCREENSHOT: &str = "browser_screenshot";
pub(crate) const BROWSER_CLICK: &str = "browser_click";
pub(crate) const BROWSER_TYPE: &str = "browser_type";
pub(crate) const BROWSER_TAB_OPEN: &str = "browser_tab_open";
pub(crate) const BROWSER_TAB_SELECT: &str = "browser_tab_select";
pub(crate) const BROWSER_TAB_CLOSE: &str = "browser_tab_close";
pub(crate) const MEMORY_SEARCH: &str = "memory_search";
pub(crate) const MEMORY_GET: &str = "memory_get";
pub(crate) const MEMORY_REMEMBER: &str = "memory_remember";

fn mutating_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        WORKSPACE_WRITE_FILE
            | WORKSPACE_EDIT
            | WORKSPACE_APPLY_PATCH
            | RUN_TERMINAL_COMMAND
            // A monitor starts a long-running process, so it is authorized
            // exactly like a terminal command: never silently approved.
            | MONITOR
            // Creating or cancelling a timer changes future autonomous work.
            | SCHEDULER_CREATE
            | SCHEDULER_DELETE
            | MCP_CALL_TOOL
            | BROWSER_NAVIGATE
            | BROWSER_CLICK
            | BROWSER_TYPE
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackgroundTaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl BackgroundTaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug)]
struct BackgroundTaskState {
    status: BackgroundTaskStatus,
    output: String,
}

/// A Host-owned terminal process. The child is deliberately kept inside the
/// collector thread: the cancellation flag is the only cross-thread control
/// surface, so callers never gain a raw process handle or an unbounded output
/// buffer.
struct BackgroundTerminalTask {
    task_id: String,
    owner_session_id: String,
    root: PathBuf,
    cancel: AtomicBool,
    state: Mutex<BackgroundTaskState>,
    changed: Condvar,
}

static BACKGROUND_TERMINAL_TASKS: OnceLock<Mutex<HashMap<String, Arc<BackgroundTerminalTask>>>> =
    OnceLock::new();

fn background_terminal_tasks() -> &'static Mutex<HashMap<String, Arc<BackgroundTerminalTask>>> {
    BACKGROUND_TERMINAL_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn background_task_snapshot(task: &BackgroundTerminalTask) -> Value {
    let state = task
        .state
        .lock()
        .expect("background task state must not be poisoned");
    json!({
        "task_id": task.task_id,
        "status": state.status.as_str(),
        "output": bound_task_output(&state.output),
    })
}

fn bound_task_output(value: &str) -> String {
    if value.len() <= BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES {
        return value.to_string();
    }
    const SUFFIX: &str = "\n[task output truncated]";
    let limit = BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES;
    if limit <= SUFFIX.len() {
        let mut end = limit;
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        return value[..end].to_string();
    }
    let mut end = limit - SUFFIX.len();
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = value[..end].to_string();
    output.push_str(SUFFIX);
    output
}

fn prune_background_terminal_tasks(
    tasks: &mut HashMap<String, Arc<BackgroundTerminalTask>>,
) -> Result<(), String> {
    if tasks.len() < BACKGROUND_TERMINAL_MAX_TASKS {
        return Ok(());
    }
    let completed = tasks
        .iter()
        .filter_map(|(id, task)| {
            let state = task.state.lock().ok()?;
            (state.status != BackgroundTaskStatus::Running).then(|| id.clone())
        })
        .collect::<Vec<_>>();
    for id in completed {
        tasks.remove(&id);
        if tasks.len() < BACKGROUND_TERMINAL_MAX_TASKS {
            return Ok(());
        }
    }
    Err(format!(
        "Too many background terminal tasks are active (maximum {})",
        BACKGROUND_TERMINAL_MAX_TASKS
    ))
}

fn error_value(code: &str, message: impl Into<String>) -> Value {
    let message = message.into();
    json!({
        "code": code,
        "message": message,
        "retriable": false,
        "scope": "tool"
    })
}

pub(crate) fn fail_resolution(
    session_id: &str,
    run_id: Option<&str>,
    tool_call_id: &str,
    code: &str,
    message: impl Into<String>,
) -> Value {
    let mut command = json!({
        "type": "tool.resolve",
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "resolution": {
            "status": "failed",
            "error": error_value(code, message)
        }
    });
    if let Some(run_id) = run_id {
        command["runId"] = Value::String(run_id.to_string());
    }
    command
}

pub(crate) fn success_resolution(
    session_id: &str,
    run_id: Option<&str>,
    tool_call_id: &str,
    output: String,
) -> Value {
    let mut command = json!({
        "type": "tool.resolve",
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "resolution": { "status": "completed", "output": output }
    });
    if let Some(run_id) = run_id {
        command["runId"] = Value::String(run_id.to_string());
    }
    command
}

fn relative_path(value: Option<&Value>, field: &str) -> Result<String, String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be a string"))?;
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("{field} must stay inside the workspace"));
    }
    Ok(value.to_string())
}

fn safe_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {relative}: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Path is outside the authorized workspace".to_string());
    }
    Ok(canonical)
}

fn respect_gitignore(arguments: &serde_json::Map<String, Value>) -> Result<bool, String> {
    arguments
        .get("respectGitignore")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "respectGitignore must be a boolean".to_string())
        })
        .transpose()
        .map(|value| value.unwrap_or(false))
}

fn gitignore_walk_builder(path: &Path, respect: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(path);
    builder
        // Melody's current search/list tools still show dot-files unless the
        // caller explicitly asks the directory tool to hide them. Keep that
        // behavior while delegating the actual ignore matching to the same
        // crate Pi uses for its native file tools.
        .hidden(false)
        .parents(true)
        .ignore(respect)
        .git_ignore(respect)
        .git_global(respect)
        .git_exclude(respect)
        .require_git(false)
        .follow_links(false);
    builder
}

fn gitignored_path(root: &Path, path: &Path) -> bool {
    // Walk the target's parent rather than passing the target itself as the
    // explicit walk root. An explicit root is always yielded by `ignore`,
    // even when its own name matches a pattern, which would make direct
    // reads of an ignored file look allowed. Walking one level below the
    // parent preserves nested/parent `.gitignore` rules without scanning the
    // complete workspace. A missing target cannot be classified reliably (for
    // example when an add-file patch creates it), so callers use this helper
    // for existing read/edit/delete targets only.
    let parent = path.parent().unwrap_or(root);
    let mut walker = gitignore_walk_builder(parent, true);
    walker.max_depth(Some(1));
    let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    for entry in walker.build() {
        if let Ok(entry) = entry {
            let candidate = entry
                .path()
                .canonicalize()
                .unwrap_or_else(|_| entry.path().to_path_buf());
            if entry.depth() == 1 && candidate == target && candidate.starts_with(&canonical_root) {
                return false;
            }
        }
    }
    true
}

fn gitignored_error(relative: &str) -> String {
    format!("{GITIGNORED_ERROR_PREFIX}{relative} is ignored by .gitignore")
}

fn read_file(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_read_file arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let path = safe_existing_path(root, &relative)?;
    if respect_gitignore(arguments)? && gitignored_path(root, &path) {
        return Err(gitignored_error(&relative));
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested workspace path is not a file".to_string());
    }
    if metadata.len() > READ_FILE_MAX_BYTES {
        return Err("The requested file is larger than the 2 MB read limit".to_string());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("File is not valid UTF-8 text: {error}"))?;
    let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(READ_FILE_DEFAULT_LINES)
        .min(READ_FILE_MAX_LINES);
    if limit == 0 {
        return Err("limit must be greater than zero".to_string());
    }
    let mut output = String::new();
    for line in content.lines().skip(offset).take(limit) {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
        if output.len() > SEARCH_MAX_OUTPUT_BYTES {
            output.truncate(SEARCH_MAX_OUTPUT_BYTES);
            output.push_str("\n[output truncated]");
            break;
        }
    }
    Ok(output)
}

fn read_tool_output(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_read_tool_output arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let normalized = relative.replace('\\', "/");
    let archive_prefix = format!("{TERMINAL_ARCHIVE_RELATIVE_DIR}/");
    let file_name = normalized
        .strip_prefix(&archive_prefix)
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| "path must reference a Melody terminal output archive".to_string())?;
    if !is_tool_output_archive_name(file_name) {
        return Err("path must reference a Melody terminal output archive".to_string());
    }

    let candidate = root.join(&relative);
    if fs::symlink_metadata(&candidate)
        .map_err(|error| format!("Failed to inspect terminal output archive: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("Refusing to read a symbolic link as a terminal output archive".to_string());
    }
    let path = safe_existing_path(root, &relative)?;
    let archive_directory = validate_tool_output_directory(root)?;
    if path.parent() != Some(archive_directory.as_path()) {
        return Err("Terminal output archive path is not inside the archive directory".to_string());
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read terminal output archive metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() > TERMINAL_ARCHIVE_MAX_BYTES {
        return Err(
            "The terminal output archive is invalid or exceeds the archive limit".to_string(),
        );
    }

    let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0);
    if offset > metadata.len() {
        return Err("offset is past the end of the terminal output archive".to_string());
    }
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(TOOL_OUTPUT_READ_DEFAULT_BYTES)
        .min(TOOL_OUTPUT_READ_MAX_BYTES);
    if limit == 0 {
        return Err("limit must be greater than zero".to_string());
    }

    let bytes_to_read = limit.min(metadata.len().saturating_sub(offset));
    let mut file = fs::File::open(&path)
        .map_err(|error| format!("Failed to open terminal output archive: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek terminal output archive: {error}"))?;
    let mut bytes = vec![0_u8; bytes_to_read as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Failed to read terminal output archive: {error}"))?;
    let end = offset.saturating_add(bytes_to_read);
    let mut output = String::from_utf8_lossy(&bytes).into_owned();
    if end < metadata.len() {
        output.push_str(&format!(
            "\n[archive chunk: offset={} bytes_read={} total={} use offset={} to continue]",
            offset,
            bytes_to_read,
            metadata.len(),
            end
        ));
    }
    Ok(output)
}

fn search_file(
    root: &Path,
    path: &Path,
    query: &str,
    results: &mut Vec<String>,
    output_bytes: &mut usize,
    files_seen: &mut usize,
) {
    if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
        return;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };
    if metadata.file_type().is_symlink() {
        return;
    }
    if metadata.is_dir() {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if path != root && is_ignored_directory(name) {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        let mut children = entries.filter_map(Result::ok).collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            search_file(
                root,
                &entry.path(),
                query,
                results,
                output_bytes,
                files_seen,
            );
            if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
                break;
            }
        }
        return;
    }
    if !metadata.is_file() || metadata.len() > READ_FILE_MAX_BYTES {
        return;
    }
    *files_seen += 1;
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for (line_number, line) in content.lines().enumerate() {
        if !line.contains(query) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let result = format!("{relative}:{}: {line}", line_number + 1);
        let result_bytes = result.len() + usize::from(!results.is_empty());
        if *output_bytes + result_bytes > SEARCH_MAX_OUTPUT_BYTES {
            return;
        }
        *output_bytes += result_bytes;
        results.push(result);
        if results.len() >= SEARCH_MAX_RESULTS {
            return;
        }
    }
}

fn search_file_with_gitignore(
    root: &Path,
    path: &Path,
    query: &str,
    results: &mut Vec<String>,
    output_bytes: &mut usize,
    files_seen: &mut usize,
) {
    if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
        return;
    }
    let mut files = Vec::new();
    let root_for_filter = root.to_path_buf();
    let mut walker = gitignore_walk_builder(path, true)
        .filter_entry(move |entry| {
            if entry.path() == root_for_filter {
                return true;
            }
            entry.file_type().is_none_or(|file_type| {
                !file_type.is_dir() || !is_ignored_directory(&entry.file_name().to_string_lossy())
            })
        })
        .build();
    while let Some(entry) = walker.next() {
        let Ok(entry) = entry else { continue };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > READ_FILE_MAX_BYTES {
            continue;
        }
        files.push(entry.into_path());
        if files.len() >= SEARCH_MAX_FILES {
            break;
        }
    }
    files.sort_by(|left, right| {
        let left = left.strip_prefix(root).unwrap_or(left).to_string_lossy();
        let right = right.strip_prefix(root).unwrap_or(right).to_string_lossy();
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(&right))
    });
    for path in files {
        if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
            break;
        }
        *files_seen += 1;
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (line_number, line) in content.lines().enumerate() {
            if !line.contains(query) {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let result = format!("{relative}:{}: {line}", line_number + 1);
            let result_bytes = result.len() + usize::from(!results.is_empty());
            if *output_bytes + result_bytes > SEARCH_MAX_OUTPUT_BYTES {
                return;
            }
            *output_bytes += result_bytes;
            results.push(result);
            if results.len() >= SEARCH_MAX_RESULTS {
                return;
            }
        }
    }
}

fn search(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_search arguments must be an object".to_string())?;
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| "query must be a string".to_string())?;
    if query.is_empty() {
        return Err("query must not be empty".to_string());
    }
    if query.len() > SEARCH_MAX_QUERY_BYTES {
        return Err("query is larger than the 256 byte limit".to_string());
    }
    let respect = respect_gitignore(arguments)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let path = match arguments.get("path") {
        Some(value) => safe_existing_path(&canonical_root, &relative_path(Some(value), "path")?)?,
        None => canonical_root.clone(),
    };
    let mut results = Vec::new();
    let mut output_bytes = 0;
    let mut files_seen = 0;
    if respect {
        search_file_with_gitignore(
            &canonical_root,
            &path,
            query,
            &mut results,
            &mut output_bytes,
            &mut files_seen,
        );
    } else {
        search_file(
            &canonical_root,
            &path,
            query,
            &mut results,
            &mut output_bytes,
            &mut files_seen,
        );
    }
    if results.is_empty() {
        return Ok("No matches found".to_string());
    }
    Ok(results.join("\n"))
}

const LIST_DIRECTORY_TRUNCATED_NOTICE: &str =
    "\n[output truncated; narrow the path or lower the requested depth]";

fn display_relative_directory(relative: &str) -> String {
    let normalized = relative.replace('\\', "/");
    let trimmed = normalized.trim().trim_start_matches("./");
    if trimmed.is_empty() || trimmed == "." {
        ".".to_string()
    } else {
        trimmed.trim_end_matches('/').to_string()
    }
}

fn list_directory_entries(
    directory: &Path,
    depth: usize,
    max_depth: usize,
    include_hidden: bool,
    output: &mut String,
    entries_seen: &mut usize,
    truncated: &mut bool,
) -> Result<(), String> {
    if *truncated || depth > max_depth {
        return Ok(());
    }

    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read directory: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        let left_name = left.file_name().to_string_lossy().into_owned();
        let right_name = right.file_name().to_string_lossy().into_owned();
        left_name
            .to_ascii_lowercase()
            .cmp(&right_name.to_ascii_lowercase())
            .then_with(|| left_name.cmp(&right_name))
    });

    for child in children {
        if *entries_seen >= LIST_DIRECTORY_MAX_ENTRIES {
            *truncated = true;
            break;
        }
        let path = child.path();
        let file_type = child
            .file_type()
            .map_err(|error| format!("Failed to inspect directory entry: {error}"))?;
        // Directory listings must not traverse links. This mirrors the
        // workspace tree and prevents a symlink from turning a read request
        // into an ambient filesystem walk.
        if file_type.is_symlink() {
            continue;
        }
        let name = child.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let is_directory = file_type.is_dir();
        if is_directory && is_ignored_directory(&name) {
            continue;
        }

        let mut line = "  ".repeat(depth + 1);
        line.push_str("- ");
        line.push_str(&name);
        if is_directory {
            line.push('/');
        }
        line.push('\n');
        if output
            .len()
            .saturating_add(line.len())
            .saturating_add(LIST_DIRECTORY_TRUNCATED_NOTICE.len())
            > LIST_DIRECTORY_MAX_OUTPUT_BYTES
        {
            *truncated = true;
            break;
        }
        output.push_str(&line);
        *entries_seen += 1;

        if is_directory && depth < max_depth {
            list_directory_entries(
                &path,
                depth + 1,
                max_depth,
                include_hidden,
                output,
                entries_seen,
                truncated,
            )?;
            if *truncated {
                break;
            }
        }
    }
    Ok(())
}

fn list_directory_entries_with_gitignore(
    root: &Path,
    directory: &Path,
    max_depth: usize,
    include_hidden: bool,
    output: &mut String,
    entries_seen: &mut usize,
    truncated: &mut bool,
) -> Result<(), String> {
    let mut entries = Vec::new();
    let directory_for_filter = directory.to_path_buf();
    let mut walker = gitignore_walk_builder(directory, true)
        .hidden(!include_hidden)
        .max_depth(Some(max_depth.saturating_add(1)))
        .filter_entry(move |entry| {
            if entry.path() == directory_for_filter {
                return true;
            }
            entry.file_type().is_none_or(|file_type| {
                !file_type.is_dir() || !is_ignored_directory(&entry.file_name().to_string_lossy())
            })
        })
        .build();
    while let Some(entry) = walker.next() {
        let entry = entry.map_err(|error| format!("Failed to walk directory: {error}"))?;
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        entries.push((entry.into_path(), file_type.is_dir()));
        if entries.len() > LIST_DIRECTORY_MAX_ENTRIES {
            *truncated = true;
            break;
        }
    }
    entries.sort_by(|(left, _), (right, _)| {
        let left = left
            .strip_prefix(directory)
            .unwrap_or(left)
            .to_string_lossy();
        let right = right
            .strip_prefix(directory)
            .unwrap_or(right)
            .to_string_lossy();
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(&right))
    });
    for (path, is_directory) in entries {
        if *entries_seen >= LIST_DIRECTORY_MAX_ENTRIES {
            *truncated = true;
            break;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let depth = path
            .strip_prefix(directory)
            .ok()
            .map(|relative| relative.components().count())
            .unwrap_or(1);
        let mut line = "  ".repeat(depth);
        line.push_str("- ");
        line.push_str(name);
        if is_directory {
            line.push('/');
        }
        line.push('\n');
        if output
            .len()
            .saturating_add(line.len())
            .saturating_add(LIST_DIRECTORY_TRUNCATED_NOTICE.len())
            > LIST_DIRECTORY_MAX_OUTPUT_BYTES
        {
            *truncated = true;
            break;
        }
        output.push_str(&line);
        *entries_seen += 1;
    }
    // `root` is retained in the signature to keep the generated-directory
    // and relative-path policy explicit at this boundary, even though the
    // walker itself starts at the requested directory.
    let _ = root;
    Ok(())
}

fn list_directory(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_list_directory arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let candidate = root.join(&relative);
    let link_metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("Failed to inspect directory: {error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("Refusing to list a symbolic link as a directory".to_string());
    }
    let path = safe_existing_path(root, &relative)?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read directory metadata: {error}"))?;
    if !metadata.is_dir() {
        return Err("The requested workspace path is not a directory".to_string());
    }

    let max_depth = arguments
        .get("depth")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| "depth must be an integer".to_string())
                .map(|depth| (depth as usize).min(LIST_DIRECTORY_MAX_DEPTH))
        })
        .transpose()?
        .unwrap_or(LIST_DIRECTORY_MAX_DEPTH);
    let include_hidden = arguments
        .get("includeHidden")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "includeHidden must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let respect = respect_gitignore(arguments)?;

    let mut output = format!("- {}/\n", display_relative_directory(&relative));
    let mut entries_seen = 0;
    let mut truncated = false;
    if respect {
        list_directory_entries_with_gitignore(
            root,
            &path,
            max_depth,
            include_hidden,
            &mut output,
            &mut entries_seen,
            &mut truncated,
        )?;
    } else {
        list_directory_entries(
            &path,
            0,
            max_depth,
            include_hidden,
            &mut output,
            &mut entries_seen,
            &mut truncated,
        )?;
    }
    if entries_seen == 0 && !truncated {
        output.push_str("  (empty)\n");
    }
    if truncated {
        output.push_str(LIST_DIRECTORY_TRUNCATED_NOTICE);
    }
    Ok(output.trim_end().to_string())
}

fn write_no_follow(path: &Path, content: &str) -> Result<(), String> {
    if content.len() > WRITE_FILE_MAX_BYTES {
        return Err("File content is larger than the 2 MB write limit".to_string());
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open file for writing: {error}"))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to flush file: {error}"))
}

fn write_file(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_write_file arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "content must be a string".to_string())?;
    let path = safe_write_path(root, &relative)?;
    write_no_follow(&path, content)?;
    Ok(format!("Wrote {} ({} bytes)", relative, content.len()))
}

fn edit_file(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_edit arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let old_text = arguments
        .get("oldText")
        .and_then(Value::as_str)
        .ok_or_else(|| "oldText must be a string".to_string())?;
    if old_text.is_empty() {
        return Err("oldText must not be empty".to_string());
    }
    let new_text = arguments
        .get("newText")
        .and_then(Value::as_str)
        .ok_or_else(|| "newText must be a string".to_string())?;
    // Mutation targets must not resolve through a workspace symlink. Read
    // access may safely follow an in-workspace link, but edit/delete/patch
    // must reject the link itself instead of mutating its target.
    let path = safe_write_path(root, &relative)?;
    if respect_gitignore(arguments)? && gitignored_path(root, &path) {
        return Err(gitignored_error(&relative));
    }
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > READ_FILE_MAX_BYTES {
        return Err("The edit target is not a bounded text file".to_string());
    }
    let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let replace_all = arguments
        .get("replaceAll")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let occurrences = original.matches(old_text).count();
    if occurrences == 0 {
        return Err("oldText was not found in the target file".to_string());
    }
    if occurrences > 1 && !replace_all {
        return Err(
            "oldText matched more than once; set replaceAll to edit all matches".to_string(),
        );
    }
    let updated = if replace_all {
        original.replace(old_text, new_text)
    } else {
        original.replacen(old_text, new_text, 1)
    };
    if updated.len() > WRITE_FILE_MAX_BYTES {
        return Err("Edited file is larger than the 2 MB write limit".to_string());
    }
    write_no_follow(&path, &updated)?;
    Ok(format!(
        "Edited {} ({} replacement{})",
        relative,
        occurrences,
        if occurrences == 1 { "" } else { "s" }
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchOperation {
    Add,
    Delete,
    Update,
}

#[derive(Debug)]
struct PatchFile {
    path: String,
    operation: PatchOperation,
    move_path: Option<String>,
    contents: String,
    hunks: Vec<Vec<String>>,
}

fn patch_path(marker: &str, line: &str) -> Option<String> {
    line.trim()
        .strip_prefix(marker)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| path.trim_start_matches("a/").to_string())
}

fn is_patch_header(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("*** Add File: ")
        || line.starts_with("*** Delete File: ")
        || line.starts_with("*** Update File: ")
        || line == "*** Begin Patch"
        || line == "*** End Patch"
}

/// Parse the apply_patch format used by Melody's existing ACP tool. In
/// addition to update hunks, retain add/delete/move operations so Pi can use
/// the same patch vocabulary instead of silently losing file lifecycle
/// changes during migration.
fn patch_files(patch: &str) -> Result<Vec<PatchFile>, String> {
    if patch.len() > PATCH_MAX_BYTES {
        return Err("Patch is larger than the 2 MB limit".to_string());
    }
    let lines = patch.lines().collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let marker = lines[index].trim();
        if marker.is_empty() || marker == "*** Begin Patch" || marker == "*** End Patch" {
            index += 1;
            continue;
        }
        if let Some(path) = patch_path("*** Add File: ", marker) {
            index += 1;
            let mut contents = String::new();
            while index < lines.len() && lines[index].starts_with('+') {
                contents.push_str(&lines[index][1..]);
                contents.push('\n');
                index += 1;
            }
            if contents.is_empty() {
                return Err(format!("Add file hunk for {path} has no contents"));
            }
            files.push(PatchFile {
                path,
                operation: PatchOperation::Add,
                move_path: None,
                contents,
                hunks: Vec::new(),
            });
            continue;
        }
        if let Some(path) = patch_path("*** Delete File: ", marker) {
            files.push(PatchFile {
                path,
                operation: PatchOperation::Delete,
                move_path: None,
                contents: String::new(),
                hunks: Vec::new(),
            });
            index += 1;
            continue;
        }
        if let Some(path) = patch_path("*** Update File: ", marker) {
            index += 1;
            let move_path = if index < lines.len() {
                let candidate = lines[index].trim();
                patch_path("*** Move to: ", candidate).inspect(|_| {
                    index += 1;
                })
            } else {
                None
            };
            let mut hunks = Vec::new();
            let mut hunk: Option<Vec<String>> = None;
            while index < lines.len() {
                let line = lines[index];
                if is_patch_header(line) {
                    break;
                }
                if line.trim_start().starts_with("*** Move to: ") {
                    return Err(format!("Unexpected move marker in update hunk for {path}"));
                }
                if line.starts_with("@@") {
                    if let Some(lines) = hunk.take() {
                        hunks.push(lines);
                    }
                    hunk = Some(Vec::new());
                } else if line == "*** End of File" {
                    if let Some(lines) = hunk.as_mut() {
                        lines.push(line.to_string());
                    }
                } else if line.starts_with(' ') || line.starts_with('+') || line.starts_with('-') {
                    hunk.get_or_insert_with(Vec::new).push(line.to_string());
                } else if line.is_empty() {
                    if let Some(lines) = hunk.as_mut() {
                        lines.push(String::new());
                    }
                } else {
                    return Err(format!("Unexpected line in update hunk for {path}"));
                }
                index += 1;
            }
            if let Some(lines) = hunk {
                hunks.push(lines);
            }
            if hunks.is_empty() {
                return Err(format!("Update file hunk for {path} has no hunks"));
            }
            files.push(PatchFile {
                path,
                operation: PatchOperation::Update,
                move_path,
                contents: String::new(),
                hunks,
            });
            continue;
        }
        return Err(format!("Unexpected patch line: {marker}"));
    }
    if files.is_empty() {
        return Err("Patch must contain at least one file operation".to_string());
    }
    Ok(files)
}

#[derive(Debug)]
enum PlannedPatch {
    Add {
        path: PathBuf,
        contents: String,
    },
    Delete {
        path: PathBuf,
    },
    Update {
        path: PathBuf,
        move_path: Option<(String, PathBuf)>,
        contents: String,
    },
}

fn apply_patch(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_apply_patch arguments must be an object".to_string())?;
    let respect = respect_gitignore(arguments)?;
    let patch = arguments
        .get("patch")
        .and_then(Value::as_str)
        .ok_or_else(|| "patch must be a string".to_string())?;
    let files = patch_files(patch)?;
    let mut planned_paths = std::collections::HashSet::new();
    let mut planned = Vec::with_capacity(files.len());
    let mut changed = Vec::new();
    for file in files {
        let relative = relative_path(Some(&Value::String(file.path.clone())), "path")?;
        if !planned_paths.insert(relative.clone()) {
            return Err(format!("Patch contains the file {relative} more than once"));
        }
        match file.operation {
            PatchOperation::Add => {
                let path = safe_write_path(root, &relative)?;
                if fs::symlink_metadata(&path).is_ok() {
                    return Err(format!("Cannot add {relative}: the path already exists"));
                }
                if file.contents.len() > WRITE_FILE_MAX_BYTES {
                    return Err(format!(
                        "Added file {relative} is larger than the 2 MB limit"
                    ));
                }
                planned.push(PlannedPatch::Add {
                    path,
                    contents: file.contents,
                });
            }
            PatchOperation::Delete => {
                let path = safe_write_path(root, &relative)?;
                let metadata = path
                    .metadata()
                    .map_err(|error| format!("Failed to read patch target metadata: {error}"))?;
                if respect && gitignored_path(root, &path) {
                    return Err(gitignored_error(&relative));
                }
                if !metadata.is_file() {
                    return Err(format!("Patch target {relative} is not a file"));
                }
                planned.push(PlannedPatch::Delete { path });
            }
            PatchOperation::Update => {
                let path = safe_write_path(root, &relative)?;
                let metadata = path
                    .metadata()
                    .map_err(|error| format!("Failed to read patch target metadata: {error}"))?;
                if respect && gitignored_path(root, &path) {
                    return Err(gitignored_error(&relative));
                }
                if !metadata.is_file() || metadata.len() > READ_FILE_MAX_BYTES {
                    return Err(format!(
                        "Patch target {relative} is not a bounded text file"
                    ));
                }
                let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                let mut updated = original;
                for lines in file.hunks {
                    let old = lines
                        .iter()
                        .filter_map(|line| {
                            line.strip_prefix(' ').or_else(|| line.strip_prefix('-'))
                        })
                        .filter(|line| *line != "*** End of File")
                        .collect::<Vec<_>>()
                        .join("\n");
                    let new = lines
                        .iter()
                        .filter_map(|line| {
                            line.strip_prefix(' ').or_else(|| line.strip_prefix('+'))
                        })
                        .filter(|line| *line != "*** End of File")
                        .collect::<Vec<_>>()
                        .join("\n");
                    if old.is_empty() {
                        return Err(format!("Patch hunk for {relative} has no context"));
                    }
                    if !updated.contains(&old) {
                        return Err(format!("Patch context was not found in {relative}"));
                    }
                    updated = updated.replacen(&old, &new, 1);
                }
                if updated.len() > WRITE_FILE_MAX_BYTES {
                    return Err(format!(
                        "Patched file {relative} is larger than the 2 MB limit"
                    ));
                }
                let move_path = if let Some(move_path) = file.move_path {
                    let move_relative = relative_path(Some(&Value::String(move_path)), "movePath")?;
                    if !planned_paths.insert(move_relative.clone()) {
                        return Err(format!(
                            "Patch contains the destination {move_relative} more than once"
                        ));
                    }
                    let move_target = safe_write_path(root, &move_relative)?;
                    if fs::symlink_metadata(&move_target).is_ok() {
                        return Err(format!(
                            "Cannot move {relative} to {move_relative}: the destination exists"
                        ));
                    }
                    Some((move_relative, move_target))
                } else {
                    None
                };
                planned.push(PlannedPatch::Update {
                    path,
                    move_path,
                    contents: updated,
                });
            }
        }
        changed.push(relative);
    }
    for item in planned {
        match item {
            PlannedPatch::Add { path, contents, .. }
            | PlannedPatch::Update {
                path,
                move_path: None,
                contents,
                ..
            } => write_no_follow(&path, &contents)?,
            PlannedPatch::Delete { path, .. } => {
                fs::remove_file(&path)
                    .map_err(|error| format!("Failed to delete file: {error}"))?;
            }
            PlannedPatch::Update {
                path,
                move_path: Some((_, move_path)),
                contents,
                ..
            } => {
                write_no_follow(&path, &contents)?;
                fs::rename(&path, &move_path)
                    .map_err(|error| format!("Failed to move patched file: {error}"))?;
            }
        }
    }
    Ok(format!("Applied patch to {}", changed.join(", ")))
}

#[derive(Debug)]
struct ToolOutputArchive {
    relative_path: String,
    file: fs::File,
    bytes_written: u64,
    truncated: bool,
}

#[derive(Debug)]
struct TerminalOutputCapture {
    root: PathBuf,
    preview_limit: usize,
    preview: Vec<u8>,
    total_bytes: u64,
    archive: Option<ToolOutputArchive>,
    archive_error: Option<String>,
}

impl TerminalOutputCapture {
    /// Test-only constructor for the default policy; production always builds a
    /// capture from the Host-resolved `PiTerminalPolicy`.
    #[cfg(test)]
    fn new(root: &Path) -> Self {
        Self::with_policy(root, None)
    }

    fn with_policy(root: &Path, policy: Option<PiTerminalPolicy>) -> Self {
        let preview_limit = policy
            .map(|policy| policy.output_byte_limit)
            .unwrap_or(TERMINAL_MAX_OUTPUT_BYTES)
            .clamp(1, TERMINAL_MAX_OUTPUT_BYTES);
        Self {
            root: root.to_path_buf(),
            preview_limit,
            preview: Vec::with_capacity(preview_limit.min(64 * 1024)),
            total_bytes: 0,
            archive: None,
            archive_error: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }

        let preview_capacity = self.preview_limit.saturating_sub(self.preview.len());
        let preview_bytes = preview_capacity.min(bytes.len());
        self.preview.extend_from_slice(&bytes[..preview_bytes]);
        self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);

        if self.total_bytes <= self.preview_limit as u64 {
            return;
        }

        let archive_started = self.archive.is_none() && self.archive_error.is_none();
        if archive_started {
            match create_tool_output_archive(&self.root) {
                Ok(mut archive) => {
                    if let Err(error) = archive.file.write_all(&self.preview) {
                        let path = archive.relative_path.clone();
                        self.archive_error =
                            Some(format!("failed to write terminal output archive: {error}"));
                        let _ = fs::remove_file(self.root.join(path));
                    } else {
                        archive.bytes_written = self.preview.len() as u64;
                        self.archive = Some(archive);
                    }
                }
                Err(error) => {
                    self.archive_error = Some(error);
                }
            }
        }

        if let Some(archive) = self.archive.as_mut() {
            // The preview prefix was written when the archive was created;
            // only the overflow portion of this chunk should be appended.
            let overflow = &bytes[preview_bytes..];
            if let Err(error) = append_tool_output_archive(archive, overflow) {
                let path = archive.relative_path.clone();
                self.archive_error = Some(error);
                self.archive = None;
                let _ = fs::remove_file(self.root.join(path));
            }
        }
    }

    fn finish(mut self) -> String {
        if let Some(archive) = self.archive.as_mut() {
            if let Err(error) = archive.file.sync_all() {
                let path = archive.relative_path.clone();
                self.archive_error =
                    Some(format!("failed to flush terminal output archive: {error}"));
                self.archive = None;
                let _ = fs::remove_file(self.root.join(path));
            }
        }

        let mut text = String::from_utf8_lossy(&self.preview).into_owned();
        if self.total_bytes <= self.preview_limit as u64 {
            return text;
        }

        let archive_note = match (self.archive.as_ref(), self.archive_error.as_deref()) {
            (Some(archive), _) if archive.truncated => format!(
                "archive contains the first {} of {} bytes at {}",
                archive.bytes_written, self.total_bytes, archive.relative_path
            ),
            (Some(archive), _) => format!(
                "full output ({} bytes) archived at {}",
                self.total_bytes, archive.relative_path
            ),
            (None, Some(error)) => format!(
                "full output ({} bytes) could not be archived: {}",
                self.total_bytes, error
            ),
            (None, None) => format!(
                "full output ({} bytes) could not be archived",
                self.total_bytes
            ),
        };
        text.push_str("\n[output truncated: ");
        text.push_str(&archive_note);
        text.push(']');
        text
    }
}

fn append_tool_output_archive(archive: &mut ToolOutputArchive, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    let remaining = TERMINAL_ARCHIVE_MAX_BYTES.saturating_sub(archive.bytes_written);
    let writable = remaining.min(bytes.len() as u64) as usize;
    if writable > 0 {
        archive
            .file
            .write_all(&bytes[..writable])
            .map_err(|error| format!("failed to write terminal output archive: {error}"))?;
        archive.bytes_written += writable as u64;
    }
    if writable < bytes.len() {
        archive.truncated = true;
    }
    Ok(())
}

fn ensure_tool_output_directory(root: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut directory = canonical_root.clone();
    for component in [".melody", "pi", "tool-output"] {
        directory.push(component);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Refusing to use symbolic link in terminal output archive path: {}",
                        directory.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "Terminal output archive path is not a directory: {}",
                        directory.display()
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&directory).map_err(|create_error| {
                    format!(
                        "Failed to create terminal output archive directory {}: {create_error}",
                        directory.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect terminal output archive directory {}: {error}",
                    directory.display()
                ));
            }
        }
    }

    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve terminal output archive directory: {error}"))?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err("Terminal output archive directory is outside the workspace".to_string());
    }
    Ok(canonical_directory)
}

fn validate_tool_output_directory(root: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut directory = canonical_root.clone();
    for component in [".melody", "pi", "tool-output"] {
        directory.push(component);
        let metadata = fs::symlink_metadata(&directory).map_err(|error| {
            format!(
                "Failed to inspect terminal output archive directory {}: {error}",
                directory.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing to use symbolic link in terminal output archive path: {}",
                directory.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Terminal output archive path is not a directory: {}",
                directory.display()
            ));
        }
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve terminal output archive directory: {error}"))?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err("Terminal output archive directory is outside the workspace".to_string());
    }
    Ok(canonical_directory)
}

fn prune_tool_output_archives(directory: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Failed to read terminal output archive directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect terminal output archive: {error}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("Failed to read terminal output archive metadata: {error}"))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !metadata.is_file() || !is_tool_output_archive_name(&file_name) {
            continue;
        }
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((modified, metadata.len(), entry.path()));
    }
    entries.sort_by_key(|(modified, _, _)| *modified);

    let mut total_bytes = entries.iter().map(|(_, size, _)| *size).sum::<u64>();
    while entries.len() >= TERMINAL_ARCHIVE_MAX_FILES
        || total_bytes.saturating_add(TERMINAL_ARCHIVE_MAX_BYTES) > TERMINAL_ARCHIVE_MAX_TOTAL_BYTES
    {
        let Some((_, size, path)) = entries.first().cloned() else {
            break;
        };
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Failed to prune terminal output archive {}: {error}",
                path.display()
            )
        })?;
        entries.remove(0);
        total_bytes = total_bytes.saturating_sub(size);
    }
    if entries.len() >= TERMINAL_ARCHIVE_MAX_FILES
        || total_bytes.saturating_add(TERMINAL_ARCHIVE_MAX_BYTES) > TERMINAL_ARCHIVE_MAX_TOTAL_BYTES
    {
        return Err("Terminal output archive retention limit has been reached".to_string());
    }
    Ok(())
}

fn create_tool_output_archive(root: &Path) -> Result<ToolOutputArchive, String> {
    create_tool_output_archive_with_prefix(root, TERMINAL_ARCHIVE_FILE_PREFIX)
}

fn is_tool_output_archive_name(file_name: &str) -> bool {
    (file_name.starts_with(TERMINAL_ARCHIVE_FILE_PREFIX)
        || file_name.starts_with(MCP_ARCHIVE_FILE_PREFIX))
        && file_name.ends_with(".log")
}

fn create_tool_output_archive_with_prefix(
    root: &Path,
    prefix: &str,
) -> Result<ToolOutputArchive, String> {
    if !matches!(
        prefix,
        TERMINAL_ARCHIVE_FILE_PREFIX | MCP_ARCHIVE_FILE_PREFIX
    ) {
        return Err("Unknown terminal output archive prefix".to_string());
    }
    let directory = ensure_tool_output_directory(root)?;
    prune_tool_output_archives(&directory)?;
    let file_name = format!("{}{}.log", prefix, uuid::Uuid::new_v4().simple());
    let relative_path = format!("{TERMINAL_ARCHIVE_RELATIVE_DIR}/{file_name}");
    let path = safe_write_path(root, &relative_path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("Failed to create terminal output archive: {error}"))?;
    Ok(ToolOutputArchive {
        relative_path,
        file,
        bytes_written: 0,
        truncated: false,
    })
}

pub(crate) fn archive_tool_output(
    root: &Path,
    bytes: &[u8],
    prefix: &str,
) -> Result<(String, u64, bool), String> {
    let mut archive = create_tool_output_archive_with_prefix(root, prefix)?;
    if let Err(error) = append_tool_output_archive(&mut archive, bytes) {
        let path = archive.relative_path.clone();
        drop(archive);
        let _ = fs::remove_file(root.join(&path));
        return Err(error);
    }
    if let Err(error) = archive.file.sync_all() {
        let path = archive.relative_path.clone();
        drop(archive);
        let _ = fs::remove_file(root.join(&path));
        return Err(format!("failed to flush terminal output archive: {error}"));
    }
    Ok((
        archive.relative_path,
        archive.bytes_written,
        archive.truncated,
    ))
}

enum TerminalOutputMessage {
    Chunk(Vec<u8>),
    Finished(Option<String>),
}

fn spawn_terminal_output_reader<R>(mut reader: R, sender: SyncSender<TerminalOutputMessage>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = vec![0_u8; TERMINAL_OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(TerminalOutputMessage::Finished(None));
                    return;
                }
                Ok(bytes_read) => {
                    if sender
                        .send(TerminalOutputMessage::Chunk(buffer[..bytes_read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(TerminalOutputMessage::Finished(Some(error.to_string())));
                    return;
                }
            }
        }
    });
}

fn collect_terminal_output(
    root: &Path,
    child: &mut std::process::Child,
    timeout_ms: u64,
    policy: Option<PiTerminalPolicy>,
) -> Result<(std::process::ExitStatus, String), String> {
    let (status, output, _) =
        collect_terminal_output_controlled(root, child, Some(timeout_ms), policy, None)?;
    Ok((status, output))
}

fn collect_terminal_output_controlled(
    root: &Path,
    child: &mut std::process::Child,
    timeout_ms: Option<u64>,
    policy: Option<PiTerminalPolicy>,
    cancel: Option<&AtomicBool>,
) -> Result<(std::process::ExitStatus, String, bool), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Terminal command stdout pipe is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Terminal command stderr pipe is unavailable".to_string())?;
    let (sender, receiver) = sync_channel(TERMINAL_OUTPUT_CHANNEL_CAPACITY);
    spawn_terminal_output_reader(stdout, sender.clone());
    spawn_terminal_output_reader(stderr, sender);

    let deadline = timeout_ms.map(|timeout_ms| Instant::now() + Duration::from_millis(timeout_ms));
    let mut capture = TerminalOutputCapture::with_policy(root, policy);
    let mut finished_readers = 0_usize;
    let mut reader_errors = Vec::new();
    let mut status = None;
    let mut timed_out = false;
    let mut cancelled = false;
    let mut drain_deadline = None;

    while finished_readers < 2 {
        if status.is_none() {
            if let Some(child_status) = child
                .try_wait()
                .map_err(|error| format!("Failed to poll terminal command: {error}"))?
            {
                status = Some(child_status);
                drain_deadline = Some(Instant::now() + Duration::from_secs(1));
            } else if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
                cancelled = true;
                let _ = child.kill();
                status = Some(child.wait().map_err(|error| {
                    format!("Failed to stop cancelled terminal command: {error}")
                })?);
                // A command can leave a grandchild holding the pipe open;
                // keep a short drain window, then detach the reader threads.
                drain_deadline = Some(Instant::now() + Duration::from_millis(250));
            } else if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
                let _ = child.kill();
                status = Some(child.wait().map_err(|error| {
                    format!("Failed to stop timed-out terminal command: {error}")
                })?);
                // A command can leave a grandchild holding the pipe open;
                // keep a short drain window, then detach the reader threads.
                drain_deadline = Some(Instant::now() + Duration::from_millis(250));
            }
        }

        if let Some(drain_deadline) = drain_deadline {
            if Instant::now() >= drain_deadline {
                break;
            }
        }

        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(TerminalOutputMessage::Chunk(bytes)) => capture.push(&bytes),
            Ok(TerminalOutputMessage::Finished(error)) => {
                finished_readers += 1;
                if let Some(error) = error {
                    reader_errors.push(error);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let status = match status {
        Some(status) => status,
        None => child
            .wait()
            .map_err(|error| format!("Failed to wait for terminal command: {error}"))?,
    };
    let mut output = capture.finish();
    if !reader_errors.is_empty() {
        output.push_str("\n[terminal output read warning: ");
        output.push_str(&reader_errors.join("; "));
        output.push(']');
    }
    if timed_out {
        return Err(format!(
            "command timed out after {} ms: {output}",
            timeout_ms.unwrap_or_default()
        ));
    }
    Ok((status, output, cancelled))
}

/// Run a terminal command with the default policy.
///
/// Test-only: production dispatch always passes the Host-resolved policy and the
/// session id, so the default-policy wrapper exists only for the sandbox tests.
#[cfg(test)]
fn run_terminal(root: &Path, arguments: &Value) -> Result<String, String> {
    run_terminal_with_policy(root, arguments, None, None)
}

/// Build the process that runs one terminal command.
///
/// The sandbox decision lives in `workspace_sandbox` so the monitor path cannot
/// drift from the terminal path; a profile that cannot be enforced fails closed
/// instead of running the command unsandboxed.
fn terminal_process(
    root: &Path,
    command: &str,
    sandbox_profile: Option<&str>,
) -> Result<Command, String> {
    crate::workspace_sandbox::sandboxed_shell_command(root, sandbox_profile, command, true)
}

fn effective_terminal_timeout_ms(arguments: &Value, policy: Option<PiTerminalPolicy>) -> u64 {
    let (default_timeout_ms, max_timeout_ms) = policy
        .map(|policy| (policy.default_timeout_ms, policy.max_timeout_ms))
        .unwrap_or((
            TERMINAL_DEFAULT_TIMEOUT.as_millis() as u64,
            TERMINAL_MAX_TIMEOUT.as_millis() as u64,
        ));
    arguments
        .as_object()
        .and_then(|arguments| arguments.get("timeoutMs"))
        .and_then(Value::as_u64)
        .filter(|timeout_ms| *timeout_ms > 0)
        .unwrap_or(default_timeout_ms)
        .clamp(1, max_timeout_ms.max(1))
}

fn run_terminal_with_policy(
    root: &Path,
    arguments: &Value,
    policy: Option<PiTerminalPolicy>,
    owner_session_id: Option<&str>,
) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "run_terminal_command arguments must be an object".to_string())?;
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command must be a string".to_string())?;
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let background = arguments
        .get("background")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "background must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    if background {
        let owner_session_id = owner_session_id.ok_or_else(|| {
            "background terminal tasks require a product session identity".to_string()
        })?;
        return start_background_terminal(root, arguments, policy, owner_session_id);
    }
    let timeout_ms = effective_terminal_timeout_ms(&Value::Object(arguments.clone()), policy);
    let sandbox_profile = crate::config_runtime::pi_sandbox_profile(&root.to_string_lossy());
    let mut process = terminal_process(root, command, sandbox_profile.as_deref())?;
    let mut child = process
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start terminal command: {error}"))?;
    let (status, output) = collect_terminal_output(root, &mut child, timeout_ms, policy)?;
    if status.success() {
        Ok(output)
    } else {
        Err(format!("command exited with {status}: {output}"))
    }
}

fn effective_background_timeout_ms(
    arguments: &Map<String, Value>,
    policy: Option<PiTerminalPolicy>,
) -> Result<Option<u64>, String> {
    let Some(value) = arguments.get("timeoutMs") else {
        return Ok(None);
    };
    let requested = value
        .as_u64()
        .ok_or_else(|| "timeoutMs must be a non-negative integer".to_string())?;
    if requested == 0 {
        return Ok(None);
    }
    let max_timeout_ms = policy
        .map(|policy| policy.max_timeout_ms)
        .unwrap_or(TERMINAL_MAX_TIMEOUT.as_millis() as u64)
        .clamp(1, TERMINAL_MAX_TIMEOUT.as_millis() as u64);
    Ok(Some(requested.clamp(1, max_timeout_ms)))
}

fn spawn_terminal_process(root: &Path, command: &str) -> Result<std::process::Child, String> {
    let sandbox_profile = crate::config_runtime::pi_sandbox_profile(&root.to_string_lossy());
    let mut process = terminal_process(root, command, sandbox_profile.as_deref())?;
    process
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start terminal command: {error}"))
}

fn start_background_terminal(
    root: &Path,
    arguments: &Map<String, Value>,
    policy: Option<PiTerminalPolicy>,
    owner_session_id: &str,
) -> Result<String, String> {
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command must be a string".to_string())?;
    if command.trim().is_empty() {
        return Err("command must not be empty".to_string());
    }
    let timeout_ms = effective_background_timeout_ms(arguments, policy)?;
    let mut child = spawn_terminal_process(root, command)?;
    let task_id = format!(
        "{}{}",
        PI_BACKGROUND_TERMINAL_TASK_PREFIX,
        uuid::Uuid::new_v4().simple()
    );
    let task = Arc::new(BackgroundTerminalTask {
        task_id: task_id.clone(),
        owner_session_id: owner_session_id.to_string(),
        root: root.to_path_buf(),
        cancel: AtomicBool::new(false),
        state: Mutex::new(BackgroundTaskState {
            status: BackgroundTaskStatus::Running,
            output: String::new(),
        }),
        changed: Condvar::new(),
    });
    if let Err(error) = (|| {
        let mut tasks = background_terminal_tasks()
            .lock()
            .map_err(|_| "Background terminal task registry is unavailable".to_string())?;
        prune_background_terminal_tasks(&mut tasks)?;
        tasks.insert(task_id.clone(), Arc::clone(&task));
        Ok::<(), String>(())
    })() {
        // `std::process::Child` is not killed when dropped. If the bounded
        // registry rejects a new task, terminate the just-created process so
        // a failed request cannot leak an orphan shell.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let worker_task = Arc::clone(&task);
    let worker_root = root.to_path_buf();
    thread::spawn(move || {
        let mut child = child;
        let result = collect_terminal_output_controlled(
            &worker_root,
            &mut child,
            timeout_ms,
            policy,
            Some(&worker_task.cancel),
        );
        let (status, output) = match result {
            Ok((exit_status, output, cancelled)) => {
                if cancelled || worker_task.cancel.load(Ordering::Acquire) {
                    (BackgroundTaskStatus::Cancelled, output)
                } else if exit_status.success() {
                    (BackgroundTaskStatus::Completed, output)
                } else {
                    (
                        BackgroundTaskStatus::Failed,
                        format!("command exited with {exit_status}: {output}"),
                    )
                }
            }
            Err(error) => {
                let cancelled = worker_task.cancel.load(Ordering::Acquire);
                (
                    if cancelled {
                        BackgroundTaskStatus::Cancelled
                    } else {
                        BackgroundTaskStatus::Failed
                    },
                    error,
                )
            }
        };
        if let Ok(mut state) = worker_task.state.lock() {
            state.status = status;
            state.output = output;
            worker_task.changed.notify_all();
        }
    });

    Ok(json!({
        "task_id": task_id,
        "status": BackgroundTaskStatus::Running.as_str(),
        "message": "Background terminal task started; use get_command_or_subagent_output to inspect it."
    })
    .to_string())
}

fn task_id_argument(arguments: &Map<String, Value>) -> Result<&str, String> {
    let task_id = arguments
        .get("task_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "task_id must be a non-empty string".to_string())?;
    if !task_id.starts_with(PI_BACKGROUND_TERMINAL_TASK_PREFIX) {
        return Err("task_id is not a Host-owned background terminal task".to_string());
    }
    Ok(task_id)
}

/// Read a task id without assuming its kind. `task_id_argument` keeps the
/// terminal-only guard for the terminal registry; monitors share the same tool
/// surface but their own registry.
fn raw_task_id_argument(arguments: &Map<String, Value>) -> Result<&str, String> {
    arguments
        .get("task_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "task_id must be a non-empty string".to_string())
}

fn task_timeout_ms(arguments: &Map<String, Value>, default_ms: u64) -> Result<u64, String> {
    let Some(value) = arguments.get("timeout_ms") else {
        return Ok(default_ms);
    };
    let timeout = value
        .as_u64()
        .ok_or_else(|| "timeout_ms must be a non-negative integer".to_string())?;
    Ok(timeout.min(120_000))
}

fn authorize_background_task(
    root: &Path,
    owner_session_id: &str,
    task_id: &str,
) -> Result<Arc<BackgroundTerminalTask>, String> {
    let task = background_terminal_tasks()
        .lock()
        .map_err(|_| "Background terminal task registry is unavailable".to_string())?
        .get(task_id)
        .cloned()
        .ok_or_else(|| format!("Background task not found: {task_id}"))?;
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let task_root = task
        .root
        .canonicalize()
        .unwrap_or_else(|_| task.root.clone());
    if task.owner_session_id != owner_session_id || task_root != canonical_root {
        return Err("Background task does not belong to this session workspace".to_string());
    }
    Ok(task)
}

fn wait_background_task(task: &BackgroundTerminalTask, timeout_ms: u64) {
    let mut state = match task.state.lock() {
        Ok(state) => state,
        Err(_) => return,
    };
    if state.status != BackgroundTaskStatus::Running || timeout_ms == 0 {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while state.status == BackgroundTaskStatus::Running {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, result) = match task.changed.wait_timeout(state, remaining) {
            Ok(value) => value,
            Err(_) => return,
        };
        state = next;
        if result.timed_out() {
            break;
        }
    }
}

fn resolve_background_task_control(
    root: &Path,
    owner_session_id: &str,
    tool_name: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    // Monitor ids are Host-owned too, but they carry a different lifecycle and
    // an event stream instead of a poll buffer; the two kinds are never mixed in
    // one call so an id can only reach its own registry.
    let referenced_monitor_id = match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT | KILL_COMMAND_OR_SUBAGENT => {
            raw_task_id_argument(arguments)
                .ok()
                .filter(|id| monitor_task_id(id))
        }
        WAIT_COMMANDS_OR_SUBAGENTS => arguments
            .get("task_ids")
            .and_then(Value::as_array)
            .and_then(|ids| ids.iter().find_map(|id| id.as_str()))
            .filter(|id| monitor_task_id(id)),
        _ => None,
    };
    if let Some(referenced) = referenced_monitor_id {
        let all_monitors = match tool_name {
            WAIT_COMMANDS_OR_SUBAGENTS => arguments
                .get("task_ids")
                .and_then(Value::as_array)
                .is_some_and(|ids| {
                    ids.iter()
                        .all(|id| id.as_str().is_some_and(monitor_task_id))
                }),
            _ => true,
        };
        if !all_monitors {
            return Err(format!(
                "task_ids cannot mix monitors and terminal tasks (saw {referenced})"
            ));
        }
        return resolve_monitor_task_control(tool_name, owner_session_id, arguments);
    }
    match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT => {
            let task_id = task_id_argument(arguments)?;
            let task = authorize_background_task(root, owner_session_id, task_id)?;
            wait_background_task(&task, task_timeout_ms(arguments, 0)?);
            Ok(background_task_snapshot(&task).to_string())
        }
        KILL_COMMAND_OR_SUBAGENT => {
            let task_id = task_id_argument(arguments)?;
            let task = authorize_background_task(root, owner_session_id, task_id)?;
            task.cancel.store(true, Ordering::Release);
            wait_background_task(&task, 5_000);
            Ok(background_task_snapshot(&task).to_string())
        }
        WAIT_COMMANDS_OR_SUBAGENTS => {
            let task_ids = arguments
                .get("task_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| "task_ids must be an array".to_string())?;
            if task_ids.is_empty() || task_ids.len() > 20 {
                return Err("task_ids must contain between 1 and 20 entries".to_string());
            }
            let mode = arguments
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| "mode must be wait_any or wait_all".to_string())?;
            if !matches!(mode, "wait_any" | "wait_all") {
                return Err(format!("Unsupported wait mode: {mode}"));
            }
            let tasks = task_ids
                .iter()
                .map(|value| {
                    let task_id = value
                        .as_str()
                        .ok_or_else(|| "task_ids must contain strings".to_string())?;
                    authorize_background_task(root, owner_session_id, task_id)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let timeout_ms = task_timeout_ms(arguments, 30_000)?;
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let completed = tasks.iter().filter(|task| {
                    task.state
                        .lock()
                        .map(|state| state.status != BackgroundTaskStatus::Running)
                        .unwrap_or(true)
                });
                let should_return = match mode {
                    "wait_any" => completed.count() > 0,
                    "wait_all" => completed.count() == tasks.len(),
                    _ => unreachable!(),
                };
                if should_return || timeout_ms == 0 || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(
                    BACKGROUND_TASK_POLL_INTERVAL
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            let snapshots = tasks
                .iter()
                .map(|task| background_task_snapshot(task))
                .collect::<Vec<_>>();
            Ok(Value::Array(snapshots).to_string())
        }
        _ => Err(format!("Unsupported background task tool: {tool_name}")),
    }
}

/// Start a Host-owned monitor for a tool request.
///
/// The command is authorized before reaching this function (`mutating_tool`
/// covers `monitor`), so this only builds the bounded arguments, starts the
/// process and returns the same task shape the other task tools consume.
fn start_monitor_tool(
    root: &Path,
    session_id: &str,
    arguments: &Map<String, Value>,
    app: Option<&tauri::AppHandle>,
) -> Result<String, String> {
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "a monitor needs a command".to_string())?;
    if command.len() > MONITOR_MAX_COMMAND_BYTES {
        return Err(format!(
            "the monitor command exceeds {MONITOR_MAX_COMMAND_BYTES} bytes"
        ));
    }
    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("monitor");
    let persistent = arguments
        .get("persistent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let workspace = root.to_path_buf();
    let owner_session = session_id.to_string();
    let event_app = app.cloned();
    let event_session = owner_session.clone();
    let event_workspace = workspace.clone();
    let snapshot = crate::pi_monitor_runtime::start_monitor(
        &owner_session,
        &workspace,
        command,
        description,
        persistent,
        move |line| {
            // Without an AppHandle (unit tests, headless bridge) the monitor
            // still runs and its tail stays readable; only delivery is skipped.
            let Some(app) = event_app.as_ref() else {
                return;
            };
            let event = json!({
                "type": "task.notification",
                "taskId": line.task_id,
                "description": line.description,
                "line": line.line,
                "sequence": line.sequence,
                "truncated": line.truncated,
            });
            if let Err(error) = crate::pi_worker_runtime::emit_host_agent_event(
                app,
                &event_session,
                &event_workspace,
                event,
            ) {
                eprintln!("monitor event was not persisted: {error}");
            }
        },
    )?;
    Ok(monitor_task_snapshot(&snapshot).to_string())
}

/// Serve Melody's scheduler tools from the Host-owned schedule store.
///
/// The model can only see and change this session's schedules; the Host keeps
/// the clock, the missed-trigger policy, the identity snapshot and the run
/// journal, so a model-created timer is the same object the UI shows.
fn scheduler_tool(
    app: Option<&tauri::AppHandle>,
    tool_name: &str,
    session_id: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let app = app.ok_or_else(|| "scheduler tools require the desktop Host".to_string())?;
    let database = app
        .try_state::<crate::database::AppDatabase>()
        .ok_or_else(|| "the application database is unavailable".to_string())?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "the application database is unavailable".to_string())?;
    let now = crate::database::current_timestamp(&connection)?;
    match tool_name {
        SCHEDULER_CREATE => {
            let interval = arguments.get("interval").and_then(Value::as_str);
            let cron = arguments.get("cron").and_then(Value::as_str);
            let (kind, interval_ms, cron) = match (interval, cron) {
                (Some(interval), None) => (
                    "interval",
                    Some(crate::database::parse_scheduler_interval(interval)?),
                    None,
                ),
                (None, Some(cron)) => ("cron", None, Some(cron)),
                (Some(_), Some(_)) => {
                    return Err("provide either interval or cron, not both".to_string());
                }
                (None, None) => {
                    return Err(
                        "provide interval (for example 5m) or a 5-field cron rule".to_string()
                    );
                }
            };
            let prompt = arguments
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "prompt is required".to_string())?;
            let fire_immediately = arguments
                .get("fire_immediately")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let task_id = arguments.get("task_id").and_then(Value::as_str);
            let schedule = crate::database::create_schedule_from_tool_with_kind(
                &connection,
                session_id,
                task_id,
                kind,
                interval_ms,
                cron,
                prompt,
                fire_immediately,
                now,
            )?;
            Ok(scheduler_snapshot(&schedule).to_string())
        }
        SCHEDULER_LIST => {
            let schedules = crate::database::list_schedules(&connection, Some(session_id))?;
            Ok(Value::Array(schedules.iter().map(scheduler_snapshot).collect()).to_string())
        }
        SCHEDULER_DELETE => {
            let task_id = arguments
                .get("task_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "task_id is required".to_string())?;
            match crate::database::read_schedule(&connection, task_id)? {
                Some(schedule) if schedule.session_id == session_id => {
                    crate::database::set_schedule_status(&connection, task_id, "cancelled", now)?;
                    Ok(Value::String(format!("cancelled {task_id}")).to_string())
                }
                Some(_) => Err(format!("schedule {task_id} belongs to another session")),
                None => Err(format!("no scheduled task with id {task_id}")),
            }
        }
        other => Err(format!("unsupported scheduler tool: {other}")),
    }
}

/// Bounded, model-facing snapshot of one schedule.
fn scheduler_snapshot(schedule: &crate::database::AgentSchedule) -> Value {
    json!({
        "id": schedule.schedule_id,
        "kind": schedule.kind,
        "status": schedule.status,
        "interval_ms": schedule.interval_ms,
        "cron": schedule.cron,
        "next_run_at": schedule.next_run_at,
        "run_count": schedule.run_count,
        "missed_policy": schedule.missed_policy,
        "prompt": schedule.prompt,
    })
}

/// Snapshot shape shared by the monitor and terminal task tools.
fn monitor_task_snapshot(snapshot: &crate::pi_monitor_runtime::MonitorSnapshot) -> Value {
    json!({
        "task_id": snapshot.task_id,
        "status": snapshot.status.as_str(),
        "description": snapshot.description,
        "persistent": snapshot.persistent,
        "emitted": snapshot.emitted,
        "output": snapshot.output,
    })
}

fn monitor_task_id(value: &str) -> bool {
    value.starts_with(crate::pi_monitor_runtime::PI_MONITOR_TASK_PREFIX)
}

/// Wait for a monitor to reach a terminal status, bounded by `timeout_ms`.
fn wait_for_monitor(task_id: &str, timeout_ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match crate::pi_monitor_runtime::monitor_snapshot(task_id) {
            Some(snapshot)
                if !matches!(
                    snapshot.status,
                    crate::pi_monitor_runtime::MonitorStatus::Running
                ) =>
            {
                return;
            }
            Some(_) => {}
            None => return,
        }
        if timeout_ms == 0 || Instant::now() >= deadline {
            return;
        }
        thread::sleep(BACKGROUND_TASK_POLL_INTERVAL.min(Duration::from_millis(50)));
    }
}

/// Resolve `get`, `kill` and `wait` for monitor task ids.
fn resolve_monitor_task_control(
    tool_name: &str,
    owner_session_id: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    let snapshot_for = |task_id: &str| -> Result<Value, String> {
        let snapshot = crate::pi_monitor_runtime::monitor_snapshot(task_id)
            .ok_or_else(|| format!("monitor {task_id} does not exist"))?;
        if snapshot.task_id.is_empty() {
            return Err("monitor snapshot is invalid".to_string());
        }
        Ok(monitor_task_snapshot(&snapshot))
    };
    match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT => {
            let task_id = raw_task_id_argument(arguments)?;
            crate::pi_monitor_runtime::authorize_monitor(task_id, owner_session_id)?;
            wait_for_monitor(task_id, task_timeout_ms(arguments, 0)?);
            Ok(snapshot_for(task_id)?.to_string())
        }
        KILL_COMMAND_OR_SUBAGENT => {
            let task_id = raw_task_id_argument(arguments)?;
            crate::pi_monitor_runtime::authorize_monitor(task_id, owner_session_id)?;
            crate::pi_monitor_runtime::cancel_monitor(task_id)?;
            Ok(snapshot_for(task_id)?.to_string())
        }
        WAIT_COMMANDS_OR_SUBAGENTS => {
            let task_ids = arguments
                .get("task_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| "task_ids must be an array".to_string())?;
            let mode = arguments
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| "mode must be wait_any or wait_all".to_string())?;
            if !matches!(mode, "wait_any" | "wait_all") {
                return Err(format!("Unsupported wait mode: {mode}"));
            }
            let ids = task_ids
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| "task_ids must contain strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let timeout_ms = task_timeout_ms(arguments, 30_000)?;
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let finished = ids
                    .iter()
                    .filter(|task_id| {
                        !matches!(
                            crate::pi_monitor_runtime::monitor_snapshot(task_id)
                                .map(|snapshot| snapshot.status),
                            Some(crate::pi_monitor_runtime::MonitorStatus::Running)
                        )
                    })
                    .count();
                let should_return = match mode {
                    "wait_any" => finished > 0,
                    "wait_all" => finished == ids.len(),
                    _ => unreachable!(),
                };
                if should_return || timeout_ms == 0 || Instant::now() >= deadline {
                    break;
                }
                thread::sleep(BACKGROUND_TASK_POLL_INTERVAL.min(Duration::from_millis(50)));
            }
            let snapshots = ids
                .iter()
                .map(|task_id| snapshot_for(task_id))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Value::Array(snapshots).to_string())
        }
        _ => Err(format!("Unsupported monitor task tool: {tool_name}")),
    }
}

/// Request cancellation for all Host-owned terminal tasks in a workspace when
/// its Pi worker is stopped. Completed tasks remain queryable until the bounded
/// registry is pruned, while live child processes receive the same cancellation
/// path as an explicit `kill_command_or_subagent` call.
pub(crate) fn cancel_background_tasks_for_workspace(root: &Path) {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let Ok(tasks) = background_terminal_tasks().lock() else {
        return;
    };
    for task in tasks.values() {
        let task_root = task
            .root
            .canonicalize()
            .unwrap_or_else(|_| task.root.clone());
        if task_root == canonical_root {
            task.cancel.store(true, Ordering::Release);
        }
    }
}

pub(crate) fn event_context(
    value: &Value,
) -> Result<(&str, Option<&str>, &str, &str, &Value, &Value), String> {
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "tool.requested.sessionId is required".to_string())?;
    let run_id = value.get("runId").and_then(Value::as_str);
    let event = value
        .get("event")
        .and_then(Value::as_object)
        .ok_or_else(|| "tool.requested.event is required".to_string())?;
    let tool_call_id = event
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "tool.requested.toolCallId is required".to_string())?;
    let tool_name = event
        .get("toolName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "tool.requested.toolName is required".to_string())?;
    let activity = event.get("activity").unwrap_or(&Value::Null);
    let arguments = activity
        .get("activity")
        .and_then(Value::as_object)
        .and_then(|activity| activity.get("arguments"))
        .unwrap_or(&Value::Null);
    // The worker puts arguments directly under activity. Accept both the
    // current shape and the older nested shape for replay compatibility.
    let arguments = activity
        .as_object()
        .and_then(|activity| activity.get("arguments"))
        .or_else(|| {
            event
                .get("activity")
                .and_then(Value::as_object)
                .and_then(|activity| activity.get("activity"))
                .and_then(Value::as_object)
                .and_then(|activity| activity.get("arguments"))
        })
        .unwrap_or(arguments);
    Ok((
        session_id,
        run_id,
        tool_call_id,
        tool_name,
        arguments,
        activity,
    ))
}

/// Return the MCP operation represented by a worker tool request.  Keeping
/// this parser at the gateway boundary lets the worker runtime route MCP to
/// the Host bridge without duplicating the event-shape compatibility logic.
pub(crate) fn mcp_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        MCP_LIST_TOOLS => Some("list"),
        MCP_CALL_TOOL => Some("call"),
        _ => None,
    }
}

/// Return the web operation represented by a worker tool request.  Network
/// access is deliberately routed separately from the filesystem gateway so
/// the Host can apply URL/domain/response limits without treating a URL as a
/// workspace path.
pub(crate) fn web_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        WEB_SEARCH => Some("search"),
        WEB_FETCH => Some("fetch"),
        _ => None,
    }
}

/// Browser requests are dispatched to the session-scoped Browser Host, never
/// interpreted as arbitrary worker-side JavaScript or network access.
pub(crate) fn browser_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        BROWSER_NAVIGATE => Some("navigate"),
        BROWSER_TABS => Some("tabs"),
        BROWSER_SNAPSHOT => Some("snapshot"),
        BROWSER_WAIT => Some("wait"),
        BROWSER_SCREENSHOT => Some("screenshot"),
        BROWSER_CLICK => Some("click"),
        BROWSER_TYPE => Some("type"),
        BROWSER_TAB_OPEN => Some("tab_open"),
        BROWSER_TAB_SELECT => Some("tab_select"),
        BROWSER_TAB_CLOSE => Some("tab_close"),
        _ => None,
    }
}

/// Defense-in-depth permission check for page navigation and DOM interaction.
/// Read-only snapshots do not require a second approval prompt.
pub(crate) fn browser_action_requires_permission(value: &Value) -> bool {
    if !matches!(
        browser_tool_kind(value),
        Some(
            "navigate" | "click" | "type" | "screenshot" | "tab_open" | "tab_select" | "tab_close"
        )
    ) {
        return false;
    }
    let (_, _, _, _, _, activity) = match event_context(value) {
        Ok(context) => context,
        Err(_) => return true,
    };
    activity.get("approved").and_then(Value::as_bool) != Some(true)
}

/// Return the memory operation represented by a worker tool request. Memory
/// reads use a dedicated Host boundary because their files live outside the
/// authorized project workspace.
pub(crate) fn memory_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        MEMORY_SEARCH => Some("search"),
        MEMORY_GET => Some("get"),
        MEMORY_REMEMBER => Some("remember"),
        _ => None,
    }
}

/// Return the Host-owned background terminal operation represented by a
/// worker request. These controls intentionally live beside the normal
/// gateway, but are resolved by the task registry instead of being treated as
/// ordinary shell commands.
pub(crate) fn background_task_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    match tool_name {
        GET_COMMAND_OR_SUBAGENT_OUTPUT => Some("get"),
        WAIT_COMMANDS_OR_SUBAGENTS => Some("wait"),
        KILL_COMMAND_OR_SUBAGENT => Some("kill"),
        _ => None,
    }
}

/// Return whether a worker request is the internal isolated-worktree bridge.
/// Keeping this parser beside the other Host-owned operations prevents the
/// generic file gateway from ever treating a task id as a shell/path input.
pub(crate) fn subagent_worktree_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = event_context(value).ok()?;
    (tool_name == CREATE_SUBAGENT_WORKTREE).then_some("create")
}

fn subagent_worktree_path(root: &Path, task_id: &str) -> Result<PathBuf, String> {
    let task_id = task_id.trim();
    if task_id.is_empty() || task_id.len() > 512 || task_id.chars().any(char::is_control) {
        return Err("task_id must be a bounded non-empty identifier".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let melody_root = canonical_root.join(".melody");
    let worktree_root = canonical_root.join(SUBAGENT_WORKTREE_RELATIVE_ROOT);
    // Check every existing component before create_dir_all. Checking only the
    // top-level `.melody` directory would still allow a malicious `.melody/pi`
    // or `worktrees` symlink to be followed while the directory tree is made.
    for component in [
        melody_root.clone(),
        melody_root.join("pi"),
        worktree_root.clone(),
    ] {
        if let Ok(metadata) = fs::symlink_metadata(&component)
            && metadata.file_type().is_symlink()
        {
            return Err(
                "Refusing to create a subagent worktree through a symbolic link".to_string(),
            );
        }
    }
    fs::create_dir_all(&worktree_root)
        .map_err(|error| format!("Failed to create subagent worktree directory: {error}"))?;
    let canonical_worktree_root = worktree_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve subagent worktree directory: {error}"))?;
    if !canonical_worktree_root.starts_with(&canonical_root) {
        return Err("Subagent worktree directory is outside the authorized workspace".to_string());
    }
    let mut hasher = DefaultHasher::new();
    task_id.hash(&mut hasher);
    let candidate = canonical_worktree_root.join(format!("task-{:016x}", hasher.finish()));
    if candidate.exists() {
        return Err("A subagent worktree already exists for this task id".to_string());
    }
    Ok(candidate)
}

fn create_subagent_worktree(root: &Path, task_id: &str) -> Result<String, String> {
    let path = subagent_worktree_path(root, task_id)?;
    let output = Command::new("git")
        .current_dir(root)
        .args(["worktree", "add", "--detach"])
        .arg(&path)
        .arg("HEAD")
        .output()
        .map_err(|error| format!("Failed to start git worktree: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git worktree add failed".to_string()
        } else {
            stderr
        });
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve created worktree: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Created worktree is outside the authorized workspace".to_string());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// Resolve the internal worker request and return only a bounded path. The
/// worker never receives a git process handle, branch name, or arbitrary path;
/// Host chooses the managed destination and always creates a detached tree
/// below `.melody/pi/worktrees`.
pub(crate) fn resolve_subagent_worktree_request(root: &Path, value: &Value) -> Value {
    let (session_id, run_id, tool_call_id, tool_name, arguments, _) = match event_context(value) {
        Ok(context) => context,
        Err(error) => return fail_for_request(value, "pi.invalid_tool_request", error),
    };
    if tool_name != CREATE_SUBAGENT_WORKTREE {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.tool_not_allowed",
            format!("Tool is not allowed by Melody ToolGateway: {tool_name}"),
        );
    }
    let Some(arguments) = arguments.as_object() else {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.invalid_tool_request",
            "tool.requested.activity.arguments must be an object",
        );
    };
    let Some(task_id) = arguments.get("task_id").and_then(Value::as_str) else {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.invalid_tool_request",
            "task_id must be a non-empty string",
        );
    };
    match create_subagent_worktree(root, task_id) {
        Ok(path) => success_resolution(
            session_id,
            run_id,
            tool_call_id,
            json!({ "worktree_path": path }).to_string(),
        ),
        Err(error) => fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.subagent_worktree_failed",
            error,
        ),
    }
}

/// Resolve a Host-owned background terminal control request. The worker only
/// receives the resulting `tool.resolve` command; it never gets access to the
/// registry or a process handle.
pub(crate) fn resolve_background_task_request(root: &Path, value: &Value) -> Value {
    let (session_id, run_id, tool_call_id, tool_name, arguments, _) = match event_context(value) {
        Ok(context) => context,
        Err(error) => return fail_for_request(value, "pi.invalid_tool_request", error),
    };
    let arguments = match arguments.as_object() {
        Some(arguments) => arguments,
        None => {
            return fail_resolution(
                session_id,
                run_id,
                tool_call_id,
                "pi.invalid_tool_request",
                "tool.requested.activity.arguments must be an object",
            );
        }
    };
    match resolve_background_task_control(root, session_id, tool_name, arguments) {
        Ok(output) => success_resolution(session_id, run_id, tool_call_id, output),
        Err(error) => fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.background_task_failed",
            error,
        ),
    }
}

/// Extract a validated tool name and argument object for a Host-owned bridge.
/// Keeping the event-shape compatibility logic in one place prevents web and
/// future network tools from accidentally accepting renderer-shaped payloads
/// that the normal gateway would reject.
pub(crate) fn tool_request_arguments(
    value: &Value,
) -> Result<(&str, &serde_json::Map<String, Value>), String> {
    let (_, _, _, tool_name, arguments, _) = event_context(value)?;
    Ok((
        tool_name,
        arguments
            .as_object()
            .ok_or_else(|| "tool.requested.activity.arguments must be an object".to_string())?,
    ))
}

pub(crate) fn is_instruction_scope_request(value: &Value) -> bool {
    event_context(value)
        .map(|context| context.3 == INSTRUCTION_SCOPE_LOOKUP)
        .unwrap_or(false)
}

fn existing_scoped_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative_path(Some(&Value::String(relative.to_string())), "path")?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut candidate = canonical_root.join(relative);
    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("Failed to resolve instruction-scope path: {error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("Instruction-scope path is outside the authorized workspace".to_string());
        }
        candidate = if canonical.is_dir() {
            canonical
        } else {
            canonical
                .parent()
                .ok_or_else(|| "Instruction-scope target has no parent directory".to_string())?
                .to_path_buf()
        };
    } else {
        candidate = candidate
            .parent()
            .ok_or_else(|| "Instruction-scope target has no parent directory".to_string())?
            .to_path_buf();
        while !candidate.exists() {
            let parent = candidate
                .parent()
                .ok_or_else(|| "Instruction-scope path has no existing ancestor".to_string())?;
            if parent == candidate {
                return Err("Instruction-scope path has no existing ancestor".to_string());
            }
            candidate = parent.to_path_buf();
        }
        candidate = candidate
            .canonicalize()
            .map_err(|error| format!("Failed to resolve instruction-scope ancestor: {error}"))?;
    }
    if !candidate.starts_with(&canonical_root) {
        return Err("Instruction-scope path is outside the authorized workspace".to_string());
    }
    Ok(candidate)
}

fn scoped_instruction_files(root: &Path, paths: &[String]) -> Result<Vec<Value>, String> {
    if paths.len() > INSTRUCTION_SCOPE_MAX_PATHS {
        return Err("Instruction-scope request contains too many target paths".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total_bytes = 0usize;
    for target in paths {
        let directory = existing_scoped_directory(&canonical_root, target)?;
        let mut ancestors = Vec::new();
        let mut current = directory;
        while current != canonical_root {
            if !current.starts_with(&canonical_root) {
                return Err(
                    "Instruction-scope path is outside the authorized workspace".to_string()
                );
            }
            ancestors.push(current.clone());
            current = current
                .parent()
                .ok_or_else(|| "Instruction-scope path has no workspace ancestor".to_string())?
                .to_path_buf();
        }
        ancestors.reverse();
        for directory in ancestors {
            for file_name in ["AGENTS.md", "CLAUDE.md"] {
                let path = directory.join(file_name);
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!("Failed to inspect {}: {error}", path.display()));
                    }
                };
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Refusing to load symlinked project instruction file: {}",
                        path.display()
                    ));
                }
                if !metadata.is_file() {
                    continue;
                }
                if metadata.len() > INSTRUCTION_SCOPE_MAX_FILE_BYTES {
                    return Err(format!(
                        "{} exceeds the {} byte scoped-instruction limit",
                        path.display(),
                        INSTRUCTION_SCOPE_MAX_FILE_BYTES
                    ));
                }
                let canonical = path
                    .canonicalize()
                    .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
                if !canonical.starts_with(&canonical_root) {
                    return Err(
                        "Scoped project instruction is outside the authorized workspace"
                            .to_string(),
                    );
                }
                let relative = canonical
                    .strip_prefix(&canonical_root)
                    .map_err(|_| {
                        "Scoped project instruction is outside the authorized workspace".to_string()
                    })?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !seen.insert(relative.clone()) {
                    continue;
                }
                if files.len() >= INSTRUCTION_SCOPE_MAX_FILES {
                    return Err("Target paths require too many instruction files".to_string());
                }
                let content = fs::read_to_string(&canonical)
                    .map_err(|error| format!("Failed to read {}: {error}", canonical.display()))?;
                total_bytes = total_bytes.saturating_add(content.len());
                if total_bytes > INSTRUCTION_SCOPE_MAX_TOTAL_BYTES {
                    return Err(
                        "Applicable project instructions exceed the total instruction limit"
                            .to_string(),
                    );
                }
                files.push(json!({ "path": relative, "content": content }));
            }
        }
    }
    Ok(files)
}

/// Read only Host-authorized, nested directory instructions for worker path
/// preflight. The returned data is context, not a permission decision.
pub(crate) fn resolve_instruction_scope_request(root: &Path, value: &Value) -> Value {
    let (session_id, run_id, tool_call_id, _, arguments, _) = match event_context(value) {
        Ok(context) => context,
        Err(error) => return fail_for_request(value, "pi.instruction_scope_invalid", error),
    };
    let paths = arguments
        .get("paths")
        .and_then(Value::as_array)
        .and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
        });
    let Some(paths) = paths else {
        return fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.instruction_scope_invalid",
            "Instruction-scope paths must be an array of strings.",
        );
    };
    match scoped_instruction_files(root, &paths) {
        Ok(files) => success_resolution(
            session_id,
            run_id,
            tool_call_id,
            json!({ "files": files }).to_string(),
        ),
        Err(error) => fail_resolution(
            session_id,
            run_id,
            tool_call_id,
            "pi.instruction_scope_failed",
            error,
        ),
    }
}

pub(crate) fn mcp_call_requires_permission(value: &Value) -> bool {
    if mcp_tool_kind(value) != Some("call") {
        return false;
    }
    let (_, _, _, _, _, activity) = match event_context(value) {
        Ok(context) => context,
        Err(_) => return true,
    };
    activity
        .get("permissionMode")
        .and_then(Value::as_str)
        .unwrap_or("ask")
        == "ask"
        && activity.get("approved").and_then(Value::as_bool) != Some(true)
}

/// Return whether a durable memory write still needs the interactive
/// permission gate. Memory files live outside the workspace, so they bypass
/// the normal mutating-tool matcher below; keep the same ask/approved
/// semantics explicitly at the Host routing boundary.
pub(crate) fn memory_write_requires_permission(value: &Value) -> bool {
    if memory_tool_kind(value) != Some("remember") {
        return false;
    }
    let (_, _, _, _, _, activity) = match event_context(value) {
        Ok(context) => context,
        Err(_) => return true,
    };
    activity
        .get("permissionMode")
        .and_then(Value::as_str)
        .unwrap_or("ask")
        == "ask"
        && activity.get("approved").and_then(Value::as_bool) != Some(true)
}

pub(crate) fn success_for_request(value: &Value, output: String) -> Value {
    match event_context(value) {
        Ok((session_id, run_id, tool_call_id, _, _, _)) => {
            success_resolution(session_id, run_id, tool_call_id, output)
        }
        Err(error) => fail_for_request(value, "pi.invalid_tool_request", error),
    }
}

pub(crate) fn fail_for_request(value: &Value, code: &str, message: impl Into<String>) -> Value {
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let run_id = value.get("runId").and_then(Value::as_str);
    let tool_call_id = value
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("toolCallId"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    fail_resolution(session_id, run_id, tool_call_id, code, message)
}

/// Convert one worker tool request to a validated, bounded resolution command.
///
/// `permission_override` is supplied only by the Rust Host after looking up
/// the session's project rule. It is deliberately not read from the renderer
/// payload, so a client cannot turn an unapproved request into an approved
/// one by editing the event it sends back to the worker.
pub(crate) fn resolve_request(root: &Path, value: &Value) -> Value {
    resolve_request_with_permission(root, value, None)
}

pub(crate) fn resolve_request_with_permission(
    root: &Path,
    value: &Value,
    permission_override: Option<bool>,
) -> Value {
    resolve_request_with_policy(root, value, permission_override, None)
}

/// Resolve a request while optionally applying a Host-owned `.gitignore`
/// policy.  The worker includes `respectGitignore` as a convenience so the
/// same request shape can be replayed, but a live Host must pass the policy
/// resolved from its trusted configuration here.  When supplied, that value
/// replaces the worker field for the file tools covered by the compatibility
/// manifest, so a compromised worker cannot disable the visibility boundary.
pub(crate) fn resolve_request_with_policy(
    root: &Path,
    value: &Value,
    permission_override: Option<bool>,
    respect_gitignore_override: Option<bool>,
) -> Value {
    resolve_request_with_host_policy(
        root,
        value,
        permission_override,
        respect_gitignore_override,
        None,
        None,
    )
}

/// Resolve a request with all policy decisions that belong to the trusted
/// Host.  The worker can request a shorter timeout, but it cannot raise the
/// Host ceiling or bypass the Host-selected output preview limit.
pub(crate) fn resolve_request_with_host_policy(
    root: &Path,
    value: &Value,
    permission_override: Option<bool>,
    respect_gitignore_override: Option<bool>,
    terminal_policy_override: Option<PiTerminalPolicy>,
    // Present for a tool call that can deliver product events without a worker
    // turn (the `monitor` stream). Absent in unit tests and headless bridges,
    // where the monitor still runs but nothing is delivered.
    monitor_app: Option<tauri::AppHandle>,
) -> Value {
    let (session_id, run_id, tool_call_id, tool_name, arguments, activity) =
        match event_context(value) {
            Ok(context) => context,
            Err(error) => return fail_for_request(value, "pi.invalid_tool_request", error),
        };
    if background_task_tool_kind(value).is_some() {
        return resolve_background_task_request(root, value);
    }
    let effective_arguments = if respect_gitignore_override.is_some()
        && matches!(
            tool_name,
            WORKSPACE_READ_FILE
                | WORKSPACE_SEARCH
                | WORKSPACE_LIST_DIRECTORY
                | WORKSPACE_EDIT
                | WORKSPACE_APPLY_PATCH
        ) {
        arguments.as_object().map(|arguments| {
            let mut arguments = arguments.clone();
            arguments.insert(
                "respectGitignore".to_string(),
                Value::Bool(respect_gitignore_override.unwrap_or(false)),
            );
            Value::Object(arguments)
        })
    } else {
        None
    };
    let arguments = effective_arguments.as_ref().unwrap_or(arguments);
    if mutating_tool(tool_name) {
        let approved = permission_override.unwrap_or_else(|| {
            activity
                .get("approved")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
        let permission_mode = activity
            .get("permissionMode")
            .and_then(Value::as_str)
            .unwrap_or("ask");
        if !approved && permission_mode == "ask" {
            return fail_resolution(
                session_id,
                run_id,
                tool_call_id,
                "pi.permission_required",
                "该工具需要用户授权后才能执行。",
            );
        }
    }
    let resolve = || match tool_name {
        WORKSPACE_READ_FILE => read_file(root, arguments),
        WORKSPACE_READ_TOOL_OUTPUT => read_tool_output(root, arguments),
        WORKSPACE_SEARCH => search(root, arguments),
        WORKSPACE_LIST_DIRECTORY => list_directory(root, arguments),
        WORKSPACE_WRITE_FILE => write_file(root, arguments),
        WORKSPACE_EDIT => edit_file(root, arguments),
        WORKSPACE_APPLY_PATCH => apply_patch(root, arguments),
        RUN_TERMINAL_COMMAND => {
            run_terminal_with_policy(root, arguments, terminal_policy_override, Some(session_id))
        }
        MONITOR => arguments
            .as_object()
            .ok_or_else(|| "monitor arguments must be an object".to_string())
            .and_then(|arguments| {
                start_monitor_tool(root, session_id, arguments, monitor_app.as_ref())
            }),
        SCHEDULER_CREATE | SCHEDULER_LIST | SCHEDULER_DELETE => arguments
            .as_object()
            .ok_or_else(|| "scheduler arguments must be an object".to_string())
            .and_then(|arguments| {
                scheduler_tool(monitor_app.as_ref(), tool_name, session_id, arguments)
            }),
        ASK_USER_QUESTION | UPDATE_PLAN | SPAWN_SUBAGENT | RUN_BACKGROUND_TASK => {
            Err("This interaction is resolved by the Pi worker".to_string())
        }
        _ => Err(format!(
            "Tool is not allowed by Melody ToolGateway: {tool_name}"
        )),
    };
    let result = if mutating_tool(tool_name) {
        let lock = workspace_mutation_lock(root);
        match lock.lock() {
            Ok(_guard) => resolve(),
            Err(_) => Err("Workspace mutation lock is poisoned".to_string()),
        }
    } else {
        resolve()
    };
    match result {
        Ok(output) => success_resolution(session_id, run_id, tool_call_id, output),
        Err(error) => {
            let (code, message) = if let Some(message) = error.strip_prefix(GITIGNORED_ERROR_PREFIX)
            {
                ("pi.gitignored_path", message.to_string())
            } else if matches!(
                tool_name,
                WORKSPACE_READ_FILE
                    | WORKSPACE_READ_TOOL_OUTPUT
                    | WORKSPACE_SEARCH
                    | WORKSPACE_LIST_DIRECTORY
                    | WORKSPACE_WRITE_FILE
                    | WORKSPACE_EDIT
                    | WORKSPACE_APPLY_PATCH
                    | RUN_TERMINAL_COMMAND
            ) {
                ("pi.tool_gateway_denied", error)
            } else {
                ("pi.tool_not_allowed", error)
            };
            fail_resolution(session_id, run_id, tool_call_id, code, message)
        }
    }
}

pub(crate) fn is_tool_request(value: &Value) -> bool {
    value
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        == Some("tool.requested")
}

/// Return the stable permission identity used by the renderer's persisted
/// project rules (`title\\ncommand`). Pi permission interactions include a
/// minimal `rawInput` object so that this identity does not depend on the
/// complete file contents or patch body.
fn permission_command(raw_input: &Value) -> String {
    let Some(raw_input) = raw_input.as_object() else {
        return String::new();
    };
    raw_input
        .get("command")
        .or_else(|| raw_input.get("cmd"))
        .or_else(|| raw_input.get("path"))
        .or_else(|| raw_input.get("scope"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| serde_json::to_string_pretty(raw_input).unwrap_or_default())
}

fn permission_identity(title: &str, raw_input: &Value) -> String {
    let command = if title.trim() == WORKSPACE_APPLY_PATCH {
        "apply_patch".to_string()
    } else {
        permission_command(raw_input)
    };
    format!("{}\\n{}", title.trim(), command.trim())
}

/// Return the project-rule key for a `tool.requested` event. This is used by
/// the Host as a defense-in-depth check even when the worker normally emits
/// `approved: true` after resolving the preceding permission interaction.
pub(crate) fn permission_tool_key(value: &Value) -> Option<String> {
    let (_, _, _, tool_name, arguments, _) = event_context(value).ok()?;
    Some(permission_identity(tool_name, arguments))
}

/// Extract a pending permission interaction and its project-rule key. The
/// returned strings are owned because the lookup/auto-resolution runs after
/// the stdout reader has moved on to later events.
pub(crate) fn permission_interaction(value: &Value) -> Option<(String, String, String)> {
    // Replayed historical interactions have no pending worker promise to
    // resolve. They are display-only and must not receive a fresh command.
    if value.get("replay").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let event = value.get("event").and_then(Value::as_object)?;
    if event.get("type").and_then(Value::as_str) != Some("interaction.requested")
        || event.get("kind").and_then(Value::as_str) != Some("permission")
    {
        return None;
    }
    let interaction_id = event
        .get("interactionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let payload = event.get("payload").and_then(Value::as_object)?;
    let tool = payload
        .get("toolCall")
        .or_else(|| payload.get("tool_call"))
        .and_then(Value::as_object)
        .unwrap_or(payload);
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("工具调用");
    let raw_input = tool.get("rawInput").or_else(|| tool.get("raw_input"));
    let key = permission_identity(title, raw_input.unwrap_or(&Value::Null));
    Some((session_id.to_string(), interaction_id.to_string(), key))
}

/// Return the worker-reported session working directory. The Host must still
/// authorize this path through `WorkspaceRegistry`; the worker value is only
/// routing metadata and is never trusted on its own.
pub(crate) fn requested_cwd(value: &Value) -> Option<&str> {
    let activity = value
        .get("event")
        .and_then(Value::as_object)
        .and_then(|event| event.get("activity"))
        .and_then(Value::as_object)?;
    activity
        .get("cwd")
        .or_else(|| {
            activity
                .get("activity")
                .and_then(Value::as_object)
                .and_then(|nested| nested.get("cwd"))
        })
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
}

pub(crate) fn fail_for_workspace(value: &Value, message: impl Into<String>) -> Value {
    fail_for_request(value, "pi.workspace_unauthorized", message)
}

pub(crate) fn deny_for_persisted_permission(value: &Value) -> Value {
    fail_for_request(
        value,
        "pi.permission_denied",
        "项目权限规则拒绝了这次工具调用。",
    )
}

pub(crate) fn permission_required_for_request(value: &Value) -> Value {
    fail_for_request(
        value,
        "pi.permission_required",
        "该工具需要用户授权后才能执行。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("melody-pi-gateway-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "fn hello() {}\nneedle here\n").unwrap();
        root
    }

    fn request(tool_name: &str, arguments: Value) -> Value {
        json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "event": {
                "type": "tool.requested",
                "toolCallId": "call-1",
                "toolName": tool_name,
                "activity": { "arguments": arguments }
            }
        })
    }

    fn approved_request(tool_name: &str, arguments: Value) -> Value {
        let mut request = request(tool_name, arguments);
        request["event"]["activity"]["approved"] = Value::Bool(true);
        request
    }

    #[test]
    fn loads_nested_project_instruction_files_in_ancestor_order_without_reloading_root_scope() {
        let root = root();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("AGENTS.md"), "root instructions\n").unwrap();
        fs::write(root.join("src/AGENTS.md"), "src instructions\n").unwrap();
        fs::write(root.join("src/CLAUDE.md"), "legacy src instructions\n").unwrap();
        fs::write(root.join("src/nested/AGENTS.md"), "nested instructions\n").unwrap();
        fs::write(
            root.join("src/nested/CLAUDE.md"),
            "legacy nested instructions\n",
        )
        .unwrap();
        let value = request(
            INSTRUCTION_SCOPE_LOOKUP,
            json!({ "paths": ["src/nested/generated.rs"] }),
        );

        let resolved = resolve_instruction_scope_request(&root, &value);
        assert_eq!(resolved["resolution"]["status"], "completed");
        let output: Value =
            serde_json::from_str(resolved["resolution"]["output"].as_str().unwrap()).unwrap();
        let files = output["files"].as_array().unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(files[0]["path"], "src/AGENTS.md");
        assert_eq!(files[1]["path"], "src/CLAUDE.md");
        assert_eq!(files[2]["path"], "src/nested/AGENTS.md");
        assert_eq!(files[3]["path"], "src/nested/CLAUDE.md");
        assert_eq!(files[0]["content"], "src instructions\n");
        assert_eq!(files[1]["content"], "legacy src instructions\n");
        assert_eq!(files[2]["content"], "nested instructions\n");
        assert_eq!(files[3]["content"], "legacy nested instructions\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scoped_instruction_lookup_rejects_paths_outside_the_workspace() {
        let root = root();
        let value = request(
            INSTRUCTION_SCOPE_LOOKUP,
            json!({ "paths": ["../outside/secret.rs"] }),
        );

        let resolved = resolve_instruction_scope_request(&root, &value);
        assert_eq!(resolved["resolution"]["status"], "failed");
        assert_eq!(
            resolved["resolution"]["error"]["code"],
            "pi.instruction_scope_failed"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_only_authorized_relative_files() {
        let root = root();
        let value = resolve_request(
            &root,
            &request(WORKSPACE_READ_FILE, json!({"path": "src/lib.rs"})),
        );
        assert_eq!(value["type"], "tool.resolve");
        assert_eq!(value["resolution"]["status"], "completed");
        assert!(
            value["resolution"]["output"]
                .as_str()
                .unwrap()
                .contains("needle")
        );
        let outside = resolve_request(
            &root,
            &request(WORKSPACE_READ_FILE, json!({"path": "../secret"})),
        );
        assert_eq!(outside["resolution"]["status"], "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_with_bounded_literal_results() {
        let root = root();
        let value = resolve_request(
            &root,
            &request(WORKSPACE_SEARCH, json!({"query": "needle"})),
        );
        assert_eq!(value["resolution"]["status"], "completed");
        assert!(
            value["resolution"]["output"]
                .as_str()
                .unwrap()
                .contains("src/lib.rs:2")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gitignore_policy_filters_search_and_directory_listing() {
        let root = root();
        fs::write(root.join(".gitignore"), "ignored.txt\nignored-dir/\n").unwrap();
        fs::write(root.join("ignored.txt"), "needle ignored\n").unwrap();
        fs::create_dir_all(root.join("ignored-dir")).unwrap();
        fs::write(root.join("ignored-dir/secret.txt"), "needle ignored\n").unwrap();
        fs::write(root.join("visible.txt"), "needle visible\n").unwrap();

        let filtered_search = resolve_request(
            &root,
            &request(
                WORKSPACE_SEARCH,
                json!({"query": "needle", "respectGitignore": true}),
            ),
        );
        assert_eq!(filtered_search["resolution"]["status"], "completed");
        let filtered_search_output = filtered_search["resolution"]["output"].as_str().unwrap();
        assert!(filtered_search_output.contains("visible.txt:1"));
        assert!(!filtered_search_output.contains("ignored.txt"));
        assert!(!filtered_search_output.contains("ignored-dir"));

        let filtered_listing = resolve_request(
            &root,
            &request(
                WORKSPACE_LIST_DIRECTORY,
                json!({"path": ".", "respectGitignore": true}),
            ),
        );
        assert_eq!(filtered_listing["resolution"]["status"], "completed");
        let filtered_listing_output = filtered_listing["resolution"]["output"].as_str().unwrap();
        assert!(filtered_listing_output.contains("visible.txt"));
        assert!(!filtered_listing_output.contains("ignored.txt"));
        assert!(!filtered_listing_output.contains("ignored-dir"));

        let unfiltered_search = resolve_request(
            &root,
            &request(
                WORKSPACE_SEARCH,
                json!({"query": "needle", "respectGitignore": false}),
            ),
        );
        let unfiltered_search_output = unfiltered_search["resolution"]["output"].as_str().unwrap();
        assert!(unfiltered_search_output.contains("ignored.txt"));
        assert!(unfiltered_search_output.contains("ignored-dir/secret.txt"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gitignore_policy_blocks_read_edit_and_patch_targets() {
        let root = root();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("ignored.txt"), "needle\n").unwrap();

        let read = resolve_request(
            &root,
            &request(
                WORKSPACE_READ_FILE,
                json!({"path": "ignored.txt", "respectGitignore": true}),
            ),
        );
        assert_eq!(read["resolution"]["status"], "failed");
        assert_eq!(read["resolution"]["error"]["code"], "pi.gitignored_path");

        let edit = resolve_request(
            &root,
            &approved_request(
                WORKSPACE_EDIT,
                json!({
                    "path": "ignored.txt",
                    "oldText": "needle",
                    "newText": "changed",
                    "respectGitignore": true
                }),
            ),
        );
        assert_eq!(edit["resolution"]["status"], "failed");
        assert_eq!(edit["resolution"]["error"]["code"], "pi.gitignored_path");

        let patch = resolve_request(
            &root,
            &approved_request(
                WORKSPACE_APPLY_PATCH,
                json!({
                    "patch": "*** Begin Patch\n*** Update File: ignored.txt\n@@\n-needle\n+changed\n*** End Patch",
                    "respectGitignore": true
                }),
            ),
        );
        assert_eq!(patch["resolution"]["status"], "failed");
        assert_eq!(patch["resolution"]["error"]["code"], "pi.gitignored_path");
        assert_eq!(
            fs::read_to_string(root.join("ignored.txt")).unwrap(),
            "needle\n"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_gitignore_policy_cannot_be_disabled_by_worker_arguments() {
        let root = root();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("ignored.txt"), "needle ignored\n").unwrap();
        fs::write(root.join("visible.txt"), "needle visible\n").unwrap();

        // The worker claims that ignore rules are disabled, but the Host
        // configuration says they are enabled. The Host-owned override must
        // win before the request reaches the file traversal implementation.
        let resolved = resolve_request_with_policy(
            &root,
            &request(
                WORKSPACE_SEARCH,
                json!({"query": "needle", "respectGitignore": false}),
            ),
            None,
            Some(true),
        );
        assert_eq!(resolved["resolution"]["status"], "completed");
        let output = resolved["resolution"]["output"].as_str().unwrap();
        assert!(output.contains("visible.txt:1"));
        assert!(!output.contains("ignored.txt"));

        // The inverse is also enforced: a worker cannot opt into a policy
        // that the Host has disabled for this workspace.
        let resolved = resolve_request_with_policy(
            &root,
            &request(
                WORKSPACE_SEARCH,
                json!({"query": "needle", "respectGitignore": true}),
            ),
            None,
            Some(false),
        );
        assert_eq!(resolved["resolution"]["status"], "completed");
        let output = resolved["resolution"]["output"].as_str().unwrap();
        assert!(output.contains("ignored.txt:1"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_workspace_directories_like_melody_build_list_dir() {
        let root = root();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/nested/main.swift"), "import Foundation\n").unwrap();
        fs::write(root.join(".hidden"), "do not show by default\n").unwrap();
        fs::create_dir_all(root.join("node_modules/ignored")).unwrap();
        fs::write(root.join("node_modules/ignored/package.json"), "{}\n").unwrap();

        let value = resolve_request(
            &root,
            &request(WORKSPACE_LIST_DIRECTORY, json!({"path": ".", "depth": 8})),
        );
        assert_eq!(value["resolution"]["status"], "completed");
        let output = value["resolution"]["output"].as_str().unwrap();
        assert!(output.starts_with("- ./\n"), "unexpected header: {output}");
        assert!(
            output.contains("- src/"),
            "src directory should be listed: {output}"
        );
        assert!(
            output.contains("- nested/"),
            "nested directory should be listed: {output}"
        );
        assert!(
            output.contains("- main.swift"),
            "nested file should be listed: {output}"
        );
        assert!(
            !output.contains(".hidden"),
            "hidden files should be omitted: {output}"
        );
        assert!(
            !output.contains("node_modules"),
            "generated directories should be omitted: {output}"
        );
        assert!(
            !output.contains(&root.to_string_lossy().to_string()),
            "absolute workspace paths must not leak: {output}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_directory_honors_depth_hidden_and_invalid_targets() {
        let root = root();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/nested/main.swift"), "import Foundation\n").unwrap();
        fs::write(root.join("src/.env"), "secret\n").unwrap();

        let shallow = resolve_request(
            &root,
            &request(WORKSPACE_LIST_DIRECTORY, json!({"path": "src", "depth": 0})),
        );
        assert_eq!(shallow["resolution"]["status"], "completed");
        let shallow_output = shallow["resolution"]["output"].as_str().unwrap();
        assert!(shallow_output.contains("- nested/"));
        assert!(!shallow_output.contains("main.swift"));

        let hidden = resolve_request(
            &root,
            &request(
                WORKSPACE_LIST_DIRECTORY,
                json!({"path": "src", "includeHidden": true}),
            ),
        );
        let hidden_output = hidden["resolution"]["output"].as_str().unwrap();
        assert!(hidden_output.contains("- .env"));

        let file = resolve_request(
            &root,
            &request(WORKSPACE_LIST_DIRECTORY, json!({"path": "src/lib.rs"})),
        );
        assert_eq!(file["resolution"]["status"], "failed");

        let outside = resolve_request(
            &root,
            &request(WORKSPACE_LIST_DIRECTORY, json!({"path": "../"})),
        );
        assert_eq!(outside["resolution"]["status"], "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unknown_tools_without_executing_them() {
        let root = root();
        let value = resolve_request(&root, &request("shell", json!({"command": "pwd"})));
        assert_eq!(value["resolution"]["status"], "failed");
        assert_eq!(value["resolution"]["error"]["code"], "pi.tool_not_allowed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn host_permission_override_allows_a_mutating_request() {
        let root = root().canonicalize().unwrap();
        let mut value = request(
            WORKSPACE_WRITE_FILE,
            json!({"path": "src/generated.txt", "content": "hello"}),
        );
        value["event"]["activity"] = json!({
            "arguments": {"path": "src/generated.txt", "content": "hello"},
            "permissionMode": "ask",
            "approved": false,
        });

        let pending = resolve_request(&root, &value);
        assert_eq!(pending["resolution"]["status"], "failed");
        assert_eq!(
            pending["resolution"]["error"]["code"],
            "pi.permission_required"
        );

        let allowed = resolve_request_with_permission(&root, &value, Some(true));
        assert_eq!(allowed["resolution"]["status"], "completed");
        assert_eq!(
            fs::read_to_string(root.join("src/generated.txt")).unwrap(),
            "hello"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patch_preflights_every_file_before_writing_any_file() {
        let root = root();
        let original = fs::read_to_string(root.join("src/lib.rs")).unwrap();
        let patch = "*** Update File: src/lib.rs\n@@\n-fn hello() {}\n+fn hello() { println!(\"changed\"); }\n*** Update File: src/missing.rs\n@@\n-old\n+new\n";
        let error = apply_patch(&root, &json!({ "patch": patch }))
            .expect_err("a missing later target should reject the whole patch");
        assert!(error.contains("Failed to read patch target metadata"));
        assert_eq!(
            fs::read_to_string(root.join("src/lib.rs")).unwrap(),
            original
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patch_supports_add_delete_and_move_operations() {
        let root = root();
        fs::write(root.join("src/obsolete.txt"), "remove me\n").unwrap();
        let patch = "*** Begin Patch\n\
*** Add File: src/new.txt\n\
+created\n\
*** Update File: src/lib.rs\n\
*** Move to: src/renamed.rs\n\
@@\n\
-fn hello() {}\n\
+fn hello() { println!(\"moved\"); }\n\
*** Delete File: src/obsolete.txt\n\
*** End Patch\n";

        apply_patch(&root, &json!({ "patch": patch })).unwrap();

        assert!(!root.join("src/lib.rs").exists());
        assert_eq!(
            fs::read_to_string(root.join("src/renamed.rs")).unwrap(),
            "fn hello() { println!(\"moved\"); }\nneedle here\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/new.txt")).unwrap(),
            "created\n"
        );
        assert!(!root.join("src/obsolete.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn mutation_tools_reject_workspace_symlinks() {
        use std::os::unix::fs::symlink;

        let root = root();
        fs::write(root.join("src/target.txt"), "before\n").unwrap();
        symlink("target.txt", root.join("src/link.txt")).unwrap();

        let edit = request(
            WORKSPACE_EDIT,
            json!({
                "path": "src/link.txt",
                "oldText": "before",
                "newText": "after",
            }),
        );
        let edit_result = resolve_request_with_permission(&root, &edit, Some(true));
        assert_eq!(edit_result["resolution"]["status"], "failed");
        assert_eq!(
            fs::read_to_string(root.join("src/target.txt")).unwrap(),
            "before\n"
        );

        let patch = "*** Update File: src/link.txt\n@@\n-before\n+after\n";
        let patch_error = apply_patch(&root, &json!({ "patch": patch })).unwrap_err();
        assert!(patch_error.contains("symbolic link"));
        assert_eq!(
            fs::read_to_string(root.join("src/target.txt")).unwrap(),
            "before\n"
        );

        let delete_patch = "*** Delete File: src/link.txt\n";
        let delete_error = apply_patch(&root, &json!({ "patch": delete_patch })).unwrap_err();
        assert!(delete_error.contains("symbolic link"));
        assert!(root.join("src/link.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn permission_identity_matches_project_rule_shape() {
        let terminal = request(
            RUN_TERMINAL_COMMAND,
            json!({"command": "git status --short"}),
        );
        assert_eq!(
            permission_tool_key(&terminal),
            Some("run_terminal_command\\ngit status --short".to_string())
        );

        let file = request(
            WORKSPACE_WRITE_FILE,
            json!({"path": "src/generated.txt", "content": "secret"}),
        );
        assert_eq!(
            permission_tool_key(&file),
            Some("workspace_write_file\\nsrc/generated.txt".to_string())
        );

        let memory = request(
            MEMORY_REMEMBER,
            json!({"content": "first note", "scope": "global"}),
        );
        assert_eq!(
            permission_tool_key(&memory),
            Some("memory_remember\\nglobal".to_string())
        );
    }

    #[test]
    fn mcp_call_requires_permission_only_for_unapproved_ask_mode() {
        let mut value = request(
            MCP_CALL_TOOL,
            json!({
                "server": "local",
                "tool": "write_note",
                "arguments": {"text": "hello"}
            }),
        );
        value["event"]["activity"] = json!({
            "arguments": value["event"]["activity"]["arguments"].clone(),
            "permissionMode": "ask",
            "approved": false,
        });
        assert!(mcp_call_requires_permission(&value));

        value["event"]["activity"]["approved"] = Value::Bool(true);
        assert!(!mcp_call_requires_permission(&value));

        value["event"]["activity"]["permissionMode"] = Value::String("auto".to_string());
        value["event"]["activity"]["approved"] = Value::Bool(false);
        assert!(!mcp_call_requires_permission(&value));
    }

    #[test]
    fn browser_mutations_require_explicit_approval_in_every_permission_mode() {
        let mut navigate = request(BROWSER_NAVIGATE, json!({"url":"https://example.com"}));
        navigate["event"]["activity"] = json!({
            "arguments": navigate["event"]["activity"]["arguments"].clone(),
            "permissionMode": "always-approve",
            "approved": false,
        });
        assert_eq!(browser_tool_kind(&navigate), Some("navigate"));
        assert!(browser_action_requires_permission(&navigate));
        navigate["event"]["activity"]["approved"] = Value::Bool(true);
        assert!(!browser_action_requires_permission(&navigate));

        let snapshot = request(BROWSER_SNAPSHOT, json!({}));
        assert_eq!(browser_tool_kind(&snapshot), Some("snapshot"));
        assert!(!browser_action_requires_permission(&snapshot));
        let wait = request(
            BROWSER_WAIT,
            json!({"text_contains":"Ready","timeout_ms":750}),
        );
        assert_eq!(browser_tool_kind(&wait), Some("wait"));
        assert!(!browser_action_requires_permission(&wait));
        let tabs = request(BROWSER_TABS, json!({}));
        assert_eq!(browser_tool_kind(&tabs), Some("tabs"));
        assert!(!browser_action_requires_permission(&tabs));

        let screenshot = request(BROWSER_SCREENSHOT, json!({}));
        assert_eq!(browser_tool_kind(&screenshot), Some("screenshot"));
        assert!(browser_action_requires_permission(&screenshot));
        let approved_screenshot = approved_request(BROWSER_SCREENSHOT, json!({}));
        assert!(!browser_action_requires_permission(&approved_screenshot));

        for (tool_name, arguments, operation) in [
            (
                BROWSER_TAB_OPEN,
                json!({"url":"https://example.com"}),
                "tab_open",
            ),
            (BROWSER_TAB_SELECT, json!({"tab_id":"tab-1"}), "tab_select"),
            (BROWSER_TAB_CLOSE, json!({"tab_id":"tab-1"}), "tab_close"),
        ] {
            let tool_request = request(tool_name, arguments);
            assert_eq!(browser_tool_kind(&tool_request), Some(operation));
            assert!(browser_action_requires_permission(&tool_request));
            let approved = approved_request(tool_name, json!({}));
            assert!(!browser_action_requires_permission(&approved));
        }

        let click = request(BROWSER_CLICK, json!({"ref_id":"r1"}));
        assert_eq!(browser_tool_kind(&click), Some("click"));
        assert!(browser_action_requires_permission(&click));

        let type_request = request(BROWSER_TYPE, json!({"ref_id":"r2","text":"hello"}));
        assert_eq!(browser_tool_kind(&type_request), Some("type"));
        assert!(browser_action_requires_permission(&type_request));
    }

    #[test]
    fn malformed_mcp_call_is_conservatively_permissioned() {
        let value = json!({
            "sessionId": "session-1",
            "event": {
                "type": "tool.requested",
                "toolCallId": "call-1",
                "toolName": MCP_CALL_TOOL,
                "activity": {}
            }
        });
        assert!(mcp_call_requires_permission(&value));
    }

    #[test]
    fn memory_remember_requires_permission_only_for_unapproved_ask_mode() {
        let mut value = request(
            MEMORY_REMEMBER,
            json!({"content": "Remember this decision", "scope": "workspace"}),
        );
        value["event"]["activity"] = json!({
            "arguments": value["event"]["activity"]["arguments"].clone(),
            "permissionMode": "ask",
            "approved": false,
        });
        assert_eq!(memory_tool_kind(&value), Some("remember"));
        assert!(memory_write_requires_permission(&value));

        value["event"]["activity"]["approved"] = Value::Bool(true);
        assert!(!memory_write_requires_permission(&value));

        value["event"]["activity"]["permissionMode"] = Value::String("auto".to_string());
        value["event"]["activity"]["approved"] = Value::Bool(false);
        assert!(!memory_write_requires_permission(&value));
    }

    #[test]
    fn terminal_output_capture_keeps_small_output_unchanged() {
        let root = root();
        let mut capture = TerminalOutputCapture::new(&root);
        capture.push(b"stdout\nstderr\n");
        assert_eq!(capture.finish(), "stdout\nstderr\n");
        assert!(!root.join(TERMINAL_ARCHIVE_RELATIVE_DIR).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_policy_resolves_configured_default_and_host_ceiling() {
        let policy = PiTerminalPolicy {
            default_timeout_ms: 45_000,
            max_timeout_ms: 90_000,
            output_byte_limit: 20_000,
        };

        assert_eq!(
            effective_terminal_timeout_ms(&json!({"command": "pwd"}), Some(policy)),
            45_000
        );
        assert_eq!(
            effective_terminal_timeout_ms(
                &json!({"command": "pwd", "timeoutMs": 120_000}),
                Some(policy)
            ),
            90_000
        );
        assert_eq!(
            effective_terminal_timeout_ms(
                &json!({"command": "pwd", "timeoutMs": 2_000}),
                Some(policy)
            ),
            2_000
        );
    }

    #[test]
    fn terminal_output_capture_uses_host_policy_preview_limit() {
        let root = root();
        let policy = PiTerminalPolicy {
            default_timeout_ms: 1_000,
            max_timeout_ms: 2_000,
            output_byte_limit: 4,
        };
        let mut capture = TerminalOutputCapture::with_policy(&root, Some(policy));
        capture.push(b"abcdefgh");
        let preview = capture.finish();

        assert!(preview.starts_with("abcd"));
        assert!(preview.contains("output truncated"));
        let archive_directory = root.join(TERMINAL_ARCHIVE_RELATIVE_DIR);
        let archive = fs::read_dir(&archive_directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(archive).unwrap(), b"abcdefgh");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn host_terminal_policy_is_applied_at_resolution_boundary() {
        let root = root();
        let policy = PiTerminalPolicy {
            default_timeout_ms: 1_000,
            max_timeout_ms: 2_000,
            output_byte_limit: 4,
        };
        let resolved = resolve_request_with_host_policy(
            &root,
            &request(
                RUN_TERMINAL_COMMAND,
                json!({
                    "command": "printf 12345678",
                    "timeoutMs": 120_000,
                }),
            ),
            Some(true),
            None,
            Some(policy),
            None,
        );

        assert_eq!(resolved["resolution"]["status"], "completed");
        assert!(
            resolved["resolution"]["output"]
                .as_str()
                .unwrap()
                .starts_with("1234")
        );
        assert!(
            resolved["resolution"]["output"]
                .as_str()
                .unwrap()
                .contains("output truncated")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn background_terminal_tasks_are_host_owned_and_controllable() {
        let root = root();
        let started = resolve_request_with_host_policy(
            &root,
            &approved_request(
                RUN_TERMINAL_COMMAND,
                json!({
                    "command": "printf done; sleep 0.05",
                    "background": true,
                    "timeoutMs": 2_000,
                }),
            ),
            Some(true),
            None,
            None,
            None,
        );
        assert_eq!(
            started["resolution"]["status"], "completed",
            "monitor start failed: {started}"
        );
        let start_output = started["resolution"]["output"].as_str().unwrap();
        let task_id = serde_json::from_str::<Value>(start_output).unwrap()["task_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(task_id.starts_with(PI_BACKGROUND_TERMINAL_TASK_PREFIX));

        let mut get = request(
            GET_COMMAND_OR_SUBAGENT_OUTPUT,
            json!({"task_id": task_id, "timeout_ms": 2_000}),
        );
        get["sessionId"] = Value::String("session-1".to_string());
        let inspected = resolve_background_task_request(&root, &get);
        assert_eq!(
            inspected["resolution"]["status"], "completed",
            "monitor get failed: {inspected}"
        );
        let snapshot =
            serde_json::from_str::<Value>(inspected["resolution"]["output"].as_str().unwrap())
                .unwrap();
        assert_eq!(snapshot["status"], "completed");
        assert!(snapshot["output"].as_str().unwrap().contains("done"));

        let mut kill_start = approved_request(
            RUN_TERMINAL_COMMAND,
            json!({"command": "sleep 10", "background": true}),
        );
        kill_start["sessionId"] = Value::String("session-kill".to_string());
        let kill_started =
            resolve_request_with_host_policy(&root, &kill_start, Some(true), None, None, None);
        let kill_task_id =
            serde_json::from_str::<Value>(kill_started["resolution"]["output"].as_str().unwrap())
                .unwrap()["task_id"]
                .as_str()
                .unwrap()
                .to_string();
        let mut kill = request(KILL_COMMAND_OR_SUBAGENT, json!({"task_id": kill_task_id}));
        kill["sessionId"] = Value::String("session-kill".to_string());
        let killed = resolve_background_task_request(&root, &kill);
        let killed_snapshot =
            serde_json::from_str::<Value>(killed["resolution"]["output"].as_str().unwrap())
                .unwrap();
        assert_eq!(killed_snapshot["status"], "cancelled");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scheduler_tools_route_through_the_host_schedule_store() {
        // The gateway needs an AppHandle for the database, so this test covers
        // the argument/dispatch layer: name mapping, interval parsing failures
        // and the read-only listing shape. The store itself is covered by the
        // schedule tests, which exercise the same functions without Tauri.
        assert!(mutating_tool(SCHEDULER_CREATE));
        assert!(mutating_tool(SCHEDULER_DELETE));
        assert!(
            !mutating_tool(SCHEDULER_LIST),
            "listing schedules must not require approval"
        );
        assert_eq!(
            crate::database::parse_scheduler_interval("5m").unwrap(),
            300_000
        );
        // Without a desktop Host the tools fail closed instead of panicking.
        let mut arguments = Map::new();
        arguments.insert("interval".to_string(), Value::String("5m".to_string()));
        arguments.insert("prompt".to_string(), Value::String("x".to_string()));
        let error = scheduler_tool(None, SCHEDULER_CREATE, "session-1", &arguments)
            .expect_err("a scheduler tool without the Host must fail closed");
        assert!(error.contains("desktop Host"), "{error}");
    }

    #[test]
    fn monitor_tool_streams_lines_and_answers_task_control() {
        let root = root();
        let started = resolve_request_with_host_policy(
            &root,
            &approved_request(
                MONITOR,
                json!({
                    "command": "printf 'first\\nsecond\\n'",
                    "description": "watch the deploy log",
                }),
            ),
            Some(true),
            None,
            None,
            None,
        );
        assert_eq!(
            started["resolution"]["status"], "completed",
            "monitor start failed: {started}"
        );
        let start_output = started["resolution"]["output"].as_str().unwrap();
        let task_id = serde_json::from_str::<Value>(start_output).unwrap()["task_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(task_id.starts_with(crate::pi_monitor_runtime::PI_MONITOR_TASK_PREFIX));

        // The Host task tools accept a monitor id, so the model can read the
        // stream tail and stop the monitor with the tools it already knows.
        let mut get = request(
            GET_COMMAND_OR_SUBAGENT_OUTPUT,
            json!({"task_id": task_id, "timeout_ms": 2_000}),
        );
        get["sessionId"] = Value::String("session-1".to_string());
        let inspected = resolve_background_task_request(&root, &get);
        assert_eq!(
            inspected["resolution"]["status"], "completed",
            "monitor get failed: {inspected}"
        );
        let snapshot =
            serde_json::from_str::<Value>(inspected["resolution"]["output"].as_str().unwrap())
                .unwrap();
        assert_eq!(snapshot["status"], "completed");
        assert_eq!(snapshot["description"], "watch the deploy log");
        assert!(snapshot["output"].as_str().unwrap().contains("first"));

        // A monitor id from another session is refused instead of leaking the
        // stream into the wrong conversation.
        let mut foreign = request(GET_COMMAND_OR_SUBAGENT_OUTPUT, json!({"task_id": task_id}));
        foreign["sessionId"] = Value::String("session-other".to_string());
        let refused = resolve_background_task_request(&root, &foreign);
        assert!(
            refused.get("error").is_some() || refused["resolution"]["status"] == "failed",
            "a foreign monitor id must not resolve: {refused}"
        );

        // Monitors and terminal tasks are never mixed in one wait.
        let mut mixed = request(
            WAIT_COMMANDS_OR_SUBAGENTS,
            json!({
                "task_ids": [task_id, "pi-terminal-task:unknown"],
                "mode": "wait_all",
                "timeout_ms": 10,
            }),
        );
        mixed["sessionId"] = Value::String("session-1".to_string());
        let mixed_result = resolve_background_task_request(&root, &mixed);
        assert!(
            serde_json::to_string(&mixed_result)
                .unwrap()
                .contains("cannot mix"),
            "mixed task kinds must be rejected: {mixed_result}"
        );

        let kill = request(KILL_COMMAND_OR_SUBAGENT, json!({"task_id": task_id}));
        let mut kill = kill;
        kill["sessionId"] = Value::String("session-1".to_string());
        let killed = resolve_background_task_request(&root, &kill);
        let killed_snapshot =
            serde_json::from_str::<Value>(killed["resolution"]["output"].as_str().unwrap())
                .unwrap();
        assert_eq!(killed_snapshot["status"], "completed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_sandboxed_terminal_command_is_confined_by_the_os() {
        if !cfg!(target_os = "macos") {
            // Windows and unsupported Linux profiles fail closed; Linux's
            // Landlock path is covered by workspace_sandbox tests.
            return;
        }
        let root = root();
        // Managed macOS hosts can expose sandbox-exec while denying nested
        // sandbox creation. Probe the wrapper before asserting kernel-level
        // behavior so that this environment restriction is not reported as a
        // product regression.
        let mut probe = terminal_process(&root, "true", Some("workspace")).unwrap();
        let probe = probe.current_dir(&root).output().unwrap();
        if !probe.status.success() {
            fs::remove_dir_all(root).unwrap();
            return;
        }
        let run = |command: &str, profile: Option<&str>| {
            let mut process = terminal_process(&root, command, profile).unwrap();
            process
                .current_dir(&root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .unwrap()
        };

        // A write inside the workspace is allowed.
        let inside = run("printf ok > inside.txt", Some("workspace"));
        assert!(
            inside.status.success(),
            "workspace writes must keep working: {}",
            String::from_utf8_lossy(&inside.stderr)
        );
        assert!(root.join("inside.txt").exists());

        // A write to the user's home outside the workspace is denied by the OS,
        // not by our own path checks: the shell itself reports the failure.
        let home = crate::config_runtime::user_home().unwrap();
        let outside = home.join(format!(
            "melody-sandbox-outside-{}.txt",
            uuid::Uuid::new_v4()
        ));
        let denied = run(
            &format!("printf bad > {}", outside.display()),
            Some("workspace"),
        );
        assert!(
            !denied.status.success(),
            "a sandboxed command must not write outside the allowed subtrees"
        );
        assert!(!outside.exists(), "the denied write must not have happened");

        // A profile the Host cannot enforce fails closed instead of running the
        // command unsandboxed.
        assert!(terminal_process(&root, "echo hi", Some("strict")).is_err());

        // Without a profile the command is unconfined, which is the documented
        // pre-existing behaviour.
        let unconfined = run("printf ok > unconfined.txt", None);
        assert!(unconfined.status.success());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_output_capture_archives_overflow_and_returns_a_bounded_preview() {
        let root = root();
        let mut capture = TerminalOutputCapture::new(&root);
        let mut output = vec![b'x'; TERMINAL_MAX_OUTPUT_BYTES + 128];
        output[TERMINAL_MAX_OUTPUT_BYTES - 1] = b'\n';
        capture.push(&output);
        let preview = capture.finish();

        assert!(preview.len() <= TERMINAL_MAX_OUTPUT_BYTES + 256);
        assert!(preview.contains("output truncated"));
        assert!(preview.contains("full output"));
        let archive_directory = root.join(TERMINAL_ARCHIVE_RELATIVE_DIR);
        let archives = fs::read_dir(&archive_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(archives.len(), 1);
        assert_eq!(fs::read(&archives[0]).unwrap(), output);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn terminal_command_streams_large_output_into_an_archive() {
        let root = root();
        let output = run_terminal(
            &root,
            &json!({
                "command": "yes x | head -c 8388736",
                "timeoutMs": 5_000,
            }),
        )
        .unwrap();

        assert!(output.contains("full output"));
        let archive_directory = root.join(TERMINAL_ARCHIVE_RELATIVE_DIR);
        let archives = fs::read_dir(&archive_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(archives.len(), 1);
        assert_eq!(fs::metadata(&archives[0]).unwrap().len(), 8_388_736);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_output_archive_can_be_read_in_bounded_chunks() {
        let root = root();
        let mut capture = TerminalOutputCapture::new(&root);
        let output = vec![b'a'; TERMINAL_MAX_OUTPUT_BYTES + 16];
        capture.push(&output);
        let preview = capture.finish();
        assert!(preview.contains("full output"));

        let archive_directory = root.join(TERMINAL_ARCHIVE_RELATIVE_DIR);
        let archive_name = fs::read_dir(&archive_directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .into_owned();
        let path = format!("{TERMINAL_ARCHIVE_RELATIVE_DIR}/{archive_name}");
        let chunk = read_tool_output(
            &root,
            &json!({"path": path, "offset": 0_u64, "limit": 64_u64}),
        )
        .unwrap();
        assert!(chunk.starts_with(&"a".repeat(64)));
        assert!(chunk.contains("archive chunk"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolve_request_reads_tool_output_archive_through_gateway() {
        let root = root();
        let mut capture = TerminalOutputCapture::new(&root);
        let output = vec![b'z'; TERMINAL_MAX_OUTPUT_BYTES + 16];
        capture.push(&output);
        assert!(capture.finish().contains("full output"));

        let archive_directory = root.join(TERMINAL_ARCHIVE_RELATIVE_DIR);
        let archive_name = fs::read_dir(&archive_directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .into_owned();
        let path = format!("{TERMINAL_ARCHIVE_RELATIVE_DIR}/{archive_name}");
        let resolved = resolve_request(
            &root,
            &request(
                WORKSPACE_READ_TOOL_OUTPUT,
                json!({"path": path, "offset": 32_u64, "limit": 64_u64}),
            ),
        );
        assert_eq!(resolved["resolution"]["status"], "completed");
        assert!(
            resolved["resolution"]["output"]
                .as_str()
                .unwrap()
                .starts_with(&"z".repeat(64))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn terminal_output_archive_rejects_symlinked_directories() {
        use std::os::unix::fs::symlink;

        let root = root();
        let outside = root.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".melody")).unwrap();

        let error = create_tool_output_archive(&root).unwrap_err().to_string();
        assert!(error.contains("symbolic link"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn extracts_only_permission_interactions() {
        let value = json!({
            "sessionId": "session-1",
            "event": {
                "type": "interaction.requested",
                "interactionId": "session-1:permission:call-1",
                "kind": "permission",
                "payload": {
                    "toolCallId": "call-1",
                    "title": RUN_TERMINAL_COMMAND,
                    "rawInput": {"command": "git status --short"}
                }
            }
        });
        assert_eq!(
            permission_interaction(&value),
            Some((
                "session-1".to_string(),
                "session-1:permission:call-1".to_string(),
                "run_terminal_command\\ngit status --short".to_string()
            ))
        );

        let plan = json!({
            "sessionId": "session-1",
            "event": {
                "type": "interaction.requested",
                "interactionId": "plan-1",
                "kind": "plan",
                "payload": {}
            }
        });
        assert_eq!(permission_interaction(&plan), None);
    }

    #[test]
    fn reads_workspace_from_direct_or_nested_activity_metadata() {
        let direct = json!({
            "event": { "activity": { "cwd": "/tmp/direct" } }
        });
        assert_eq!(requested_cwd(&direct), Some("/tmp/direct"));

        let nested = json!({
            "event": { "activity": { "activity": { "cwd": "/tmp/nested" } } }
        });
        assert_eq!(requested_cwd(&nested), Some("/tmp/nested"));

        let empty = json!({ "event": { "activity": { "cwd": "  " } } });
        assert_eq!(requested_cwd(&empty), None);
    }

    #[test]
    fn recognizes_only_the_internal_subagent_worktree_request() {
        let value = request(CREATE_SUBAGENT_WORKTREE, json!({"task_id": "task-1"}));
        assert_eq!(subagent_worktree_tool_kind(&value), Some("create"));
        let ordinary = request(WORKSPACE_READ_FILE, json!({"path": "src/lib.rs"}));
        assert_eq!(subagent_worktree_tool_kind(&ordinary), None);
    }
}
