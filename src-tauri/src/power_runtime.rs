use std::sync::Mutex;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::{Child, Command, Stdio};

use tauri::State;

#[derive(Default)]
pub struct SystemSleepState {
    inner: Mutex<SleepState>,
}

#[derive(Default)]
struct SleepState {
    enabled: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    process: Option<Child>,
}

impl SystemSleepState {
    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "系统休眠状态锁已损坏。".to_string())?;
        if state.enabled == enabled {
            return Ok(());
        }

        if enabled {
            acquire_sleep_prevention(&mut state)?;
        } else {
            release_sleep_prevention(&mut state);
        }
        state.enabled = enabled;
        Ok(())
    }
}

impl Drop for SystemSleepState {
    fn drop(&mut self) {
        if let Ok(state) = self.inner.get_mut() {
            release_sleep_prevention(state);
        }
    }
}

#[tauri::command]
pub fn set_system_sleep_prevention(
    state: State<'_, SystemSleepState>,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(enabled)
}

#[allow(unused_variables)]
fn acquire_sleep_prevention(state: &mut SleepState) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w"])
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动 macOS 防休眠服务：{error}"))?;
        state.process = Some(child);
    }

    #[cfg(target_os = "linux")]
    {
        let child = Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--mode=block",
                "--why=MelodyWork 运行时任务",
                "tail",
                "-f",
                "/dev/null",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动 Linux 防休眠服务：{error}"))?;
        state.process = Some(child);
    }

    #[cfg(target_os = "windows")]
    {
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

        let result = unsafe { set_thread_execution_state(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        if result == 0 {
            return Err(format!(
                "无法设置 Windows 防休眠状态：{}",
                std::io::Error::last_os_error()
            ));
        }
    }

    Ok(())
}

#[allow(unused_variables)]
fn release_sleep_prevention(state: &mut SleepState) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if let Some(mut child) = state.process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(target_os = "windows")]
    {
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        unsafe {
            let _ = set_thread_execution_state(ES_CONTINUOUS);
        }
    }
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
}

#[cfg(target_os = "windows")]
unsafe fn set_thread_execution_state(es_flags: u32) -> u32 {
    // Keep the raw Windows call isolated so the rest of the runtime remains
    // portable and the desktop command can use the same setting on all OSes.
    unsafe { SetThreadExecutionState(es_flags) }
}
