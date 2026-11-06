use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::pi_memory_runtime::{self, SessionMemoryMessage};

use super::PI_AGENT_STDERR;

const MAX_TRANSCRIPT_MESSAGES: usize = 128;
const MAX_TRANSCRIPT_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Default)]
struct MemoryTranscript {
    cwd: PathBuf,
    messages: Vec<SessionMemoryMessage>,
    total_bytes: usize,
}

#[derive(Default)]
pub(super) struct HostMemoryLifecycle {
    transcripts: Mutex<HashMap<String, MemoryTranscript>>,
    injected_sessions: Mutex<HashSet<String>>,
}

impl HostMemoryLifecycle {
    /// Claim the first turn of a product session and prepend a Host-owned
    /// memory reminder when configured. Claim before search so concurrent
    /// renderer commands cannot inject the reminder twice.
    pub(super) async fn maybe_inject(&self, command: &mut Value, cwd: &Path) -> Result<(), String> {
        let Some(command_object) = command.get("command").and_then(Value::as_object) else {
            return Ok(());
        };
        if command_object.get("type").and_then(Value::as_str) != Some("turn.submit") {
            return Ok(());
        }
        let Some(session_id) = command_object
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return Ok(());
        };
        let should_inject = self
            .injected_sessions
            .lock()
            .await
            .insert(session_id.to_string());
        if !should_inject {
            return Ok(());
        }
        let query = command_object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let cwd = cwd.to_path_buf();
        let result = tauri::async_runtime::spawn_blocking(move || {
            pi_memory_runtime::initial_injection(&cwd, &query)
        })
        .await
        .map_err(|error| format!("Memory initial-injection worker failed: {error}"))??;
        let Some(context) = result else {
            return Ok(());
        };
        let Some(command_object) = command.get_mut("command").and_then(Value::as_object_mut) else {
            return Ok(());
        };
        let content = command_object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        command_object.insert(
            "content".to_string(),
            Value::String(format!("{context}\n\n{content}")),
        );
        Ok(())
    }

    /// Record only normalized root-session messages. Child Pi streams are
    /// excluded so private context never crosses product-session boundaries.
    pub(super) async fn observe_event(
        &self,
        app: &AppHandle,
        value: &Value,
        worker_cwd: Option<&Path>,
    ) {
        let Some(session_id) = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };
        if value
            .get("streamSessionId")
            .and_then(Value::as_str)
            .is_some_and(|stream| stream != session_id)
        {
            return;
        }
        let Some(event) = value.get("event").and_then(Value::as_object) else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("message.completed") => {
                let Some(role) = event
                    .get("role")
                    .and_then(Value::as_str)
                    .filter(|role| matches!(*role, "user" | "assistant"))
                else {
                    return;
                };
                let Some(content) = event.get("content").and_then(Value::as_str) else {
                    return;
                };
                let content = pi_memory_runtime::strip_injected_context(content)
                    .trim()
                    .to_string();
                if content.is_empty() {
                    return;
                }
                let Some(cwd) = worker_cwd else {
                    return;
                };
                let message_id = event
                    .get("messageId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("message")
                    .to_string();
                let mut transcripts = self.transcripts.lock().await;
                let transcript = transcripts
                    .entry(session_id.to_string())
                    .or_insert_with(|| MemoryTranscript {
                        cwd: cwd.to_path_buf(),
                        ..MemoryTranscript::default()
                    });
                let bounded = bound_session_text(&content, MAX_TRANSCRIPT_MESSAGE_BYTES);
                if let Some(index) = transcript
                    .messages
                    .iter()
                    .position(|message| message.id == message_id)
                {
                    let previous_bytes = transcript.messages[index].content.len();
                    let base_bytes = transcript.total_bytes.saturating_sub(previous_bytes);
                    let available = MAX_TRANSCRIPT_BYTES.saturating_sub(base_bytes);
                    if available == 0 {
                        return;
                    }
                    let bounded = bound_session_text(&bounded, available);
                    transcript.messages[index].role = role.to_string();
                    transcript.messages[index].content = bounded.clone();
                    transcript.total_bytes = base_bytes.saturating_add(bounded.len());
                } else if transcript.messages.len() < MAX_TRANSCRIPT_MESSAGES {
                    let available = MAX_TRANSCRIPT_BYTES.saturating_sub(transcript.total_bytes);
                    if available == 0 {
                        return;
                    }
                    let bounded = bound_session_text(&bounded, available);
                    transcript.total_bytes = transcript.total_bytes.saturating_add(bounded.len());
                    transcript.messages.push(SessionMemoryMessage {
                        id: message_id,
                        role: role.to_string(),
                        content: bounded,
                    });
                }
            }
            Some("session.closed") => {
                let transcript = self.transcripts.lock().await.remove(session_id);
                let Some(transcript) = transcript else {
                    return;
                };
                let session_id = session_id.to_string();
                match tauri::async_runtime::spawn_blocking(move || {
                    pi_memory_runtime::save_session_transcript(
                        &transcript.cwd,
                        &session_id,
                        &transcript.messages,
                    )
                })
                .await
                {
                    Ok(Ok(Some(path))) => {
                        let _ = app.emit(
                            PI_AGENT_STDERR,
                            format!("Pi memory session transcript saved: {}", path.display()),
                        );
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => {
                        let _ =
                            app.emit(PI_AGENT_STDERR, format!("Pi memory save skipped: {error}"));
                    }
                    Err(error) => {
                        let _ = app.emit(
                            PI_AGENT_STDERR,
                            format!("Pi memory save worker failed: {error}"),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) async fn flush_transcripts(&self, app: &AppHandle) {
        let transcripts = std::mem::take(&mut *self.transcripts.lock().await);
        for (session_id, transcript) in transcripts {
            match tauri::async_runtime::spawn_blocking(move || {
                pi_memory_runtime::save_session_transcript(
                    &transcript.cwd,
                    &session_id,
                    &transcript.messages,
                )
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    let _ = app.emit(
                        PI_AGENT_STDERR,
                        format!("Pi memory shutdown save failed: {error}"),
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        PI_AGENT_STDERR,
                        format!("Pi memory shutdown save worker failed: {error}"),
                    );
                }
            }
        }
    }

    pub(super) async fn reset_session(&self, session_id: &str) {
        self.injected_sessions.lock().await.remove(session_id);
        self.transcripts.lock().await.remove(session_id);
    }

    pub(super) async fn forget_injection(&self, session_id: &str) {
        self.injected_sessions.lock().await.remove(session_id);
    }

    pub(super) async fn clear(&self) {
        self.injected_sessions.lock().await.clear();
        self.transcripts.lock().await.clear();
    }
}

fn bound_session_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    const SUFFIX: &str = "\n[message truncated]";
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
    let mut bounded = value[..end].to_string();
    bounded.push_str(SUFFIX);
    bounded
}
