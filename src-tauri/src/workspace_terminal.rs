use std::{
    collections::HashMap,
    io::{self, Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use crate::workspace_access::WorkspaceRegistry;
use portable_pty::{
    Child as PtyChild, CommandBuilder, ExitStatus as PtyExitStatus, MasterPty, PtySize,
    native_pty_system,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_TERMINAL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

struct TerminalSession {
    child: Arc<Mutex<Box<dyn PtyChild + Send + Sync>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
}

#[derive(Clone, Default)]
pub struct TerminalRuntime {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    terminal_id: String,
    stream: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    terminal_id: String,
    code: Option<i32>,
}

struct OutputBudget {
    emitted: AtomicUsize,
    truncation_sent: AtomicBool,
}

impl Default for OutputBudget {
    fn default() -> Self {
        Self {
            emitted: AtomicUsize::new(0),
            truncation_sent: AtomicBool::new(false),
        }
    }
}

impl OutputBudget {
    fn reserve(&self, requested: usize) -> usize {
        let mut current = self.emitted.load(Ordering::Relaxed);
        loop {
            let available = MAX_TERMINAL_OUTPUT_BYTES.saturating_sub(current);
            let allowed = requested.min(available);
            match self.emitted.compare_exchange(
                current,
                current.saturating_add(allowed),
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return allowed,
                Err(next) => current = next,
            }
        }
    }
}

fn forward_terminal_stream<R>(
    app: AppHandle,
    terminal_id: String,
    stream: &'static str,
    mut reader: R,
    budget: Arc<OutputBudget>,
) where
    R: Read,
{
    let mut buffer = [0_u8; 4_096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let allowed = budget.reserve(count);
                if allowed > 0 {
                    let data = String::from_utf8_lossy(&buffer[..allowed]).into_owned();
                    let _ = app.emit(
                        "melody://terminal-output",
                        TerminalOutput {
                            terminal_id: terminal_id.clone(),
                            stream: stream.to_string(),
                            data,
                        },
                    );
                }
                if allowed < count && !budget.truncation_sent.swap(true, Ordering::AcqRel) {
                    let _ = app.emit(
                        "melody://terminal-output",
                        TerminalOutput {
                            terminal_id: terminal_id.clone(),
                            stream: stream.to_string(),
                            data: "\n[终端输出已截断：超过 8 MiB 上限]\n".to_string(),
                        },
                    );
                }
            }
        }
    }
}

pub(crate) fn terminal_command(cwd: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new_default_prog();
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "MelodyWork");
    command
}

pub(crate) async fn wait_for_terminal_exit(
    child: Arc<Mutex<Box<dyn PtyChild + Send + Sync>>>,
) -> Result<PtyExitStatus, io::Error> {
    loop {
        let status = {
            let mut child = child.lock().await;
            child.try_wait()?
        };
        if let Some(status) = status {
            return Ok(status);
        }
        // Do not hold the child mutex while waiting. close_terminal_session
        // must be able to acquire it and kill an interactive shell.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tauri::command]
pub async fn create_terminal_session(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, TerminalRuntime>,
    cwd: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?;
    let terminal_id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize::default())
        .map_err(|error| format!("Failed to create terminal: {error}"))?;
    let child = pair
        .slave
        .spawn_command(terminal_command(&cwd))
        .map_err(|error| format!("Failed to start terminal: {error}"))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to open terminal input: {error}"))?;
    let session = Arc::new(TerminalSession {
        child: Arc::new(Mutex::new(child)),
        master: Arc::new(Mutex::new(pair.master)),
        writer: Mutex::new(writer),
    });
    runtime
        .sessions
        .lock()
        .await
        .insert(terminal_id.clone(), session.clone());

    let output_app = app.clone();
    let output_id = terminal_id.clone();
    let output_budget = Arc::new(OutputBudget::default());
    let output_thread_name = format!("melody-terminal-{terminal_id}");
    let _ = std::thread::Builder::new()
        .name(output_thread_name)
        .spawn(move || {
            forward_terminal_stream(output_app, output_id, "stdout", reader, output_budget);
        });

    let exit_id = terminal_id.clone();
    let sessions = runtime.sessions.clone();
    let stdout_session = session.clone();
    tauri::async_runtime::spawn(async move {
        let wait_task = wait_for_terminal_exit(stdout_session.child.clone());
        let status = wait_task.await;
        sessions.lock().await.remove(&exit_id);
        let _ = app.emit(
            "melody://terminal-exit",
            TerminalExit {
                terminal_id: exit_id,
                code: status
                    .ok()
                    .and_then(|status| i32::try_from(status.exit_code()).ok()),
            },
        );
    });

    Ok(terminal_id)
}

#[tauri::command]
pub async fn write_terminal_input(
    runtime: State<'_, TerminalRuntime>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let session = runtime
        .sessions
        .lock()
        .await
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "Terminal session is no longer running".to_string())?;
    let mut input = session.writer.lock().await;
    input
        .write_all(data.as_bytes())
        .map_err(|error| format!("Failed to write to terminal: {error}"))?;
    input
        .flush()
        .map_err(|error| format!("Failed to flush terminal input: {error}"))
}

#[tauri::command]
pub async fn resize_terminal_session(
    runtime: State<'_, TerminalRuntime>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = runtime
        .sessions
        .lock()
        .await
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "Terminal session is no longer running".to_string())?;
    let size = PtySize {
        cols: cols.clamp(2, 512),
        rows: rows.clamp(2, 512),
        pixel_width: 0,
        pixel_height: 0,
    };
    session
        .master
        .lock()
        .await
        .resize(size)
        .map_err(|error| format!("Failed to resize terminal: {error}"))
}

#[tauri::command]
pub async fn close_terminal_session(
    runtime: State<'_, TerminalRuntime>,
    terminal_id: String,
) -> Result<(), String> {
    let session = runtime.sessions.lock().await.remove(&terminal_id);
    let Some(session) = session else {
        return Ok(());
    };
    let mut child = session.child.lock().await;
    if child
        .try_wait()
        .map_err(|error| format!("Failed to inspect terminal process: {error}"))?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| format!("Failed to stop terminal process: {error}"))?;
        let _ = child.wait();
    }
    Ok(())
}
