use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

use super::database_agent_bindings::AgentSessionBinding;
use super::database_core::AppDatabase;

const MAX_RECOVERY_SCAN: i64 = 4096;
const MAX_RECOVERY_ID_BYTES: usize = 256;
const MAX_RECOVERY_REASONS: usize = 16;

/// A conservative action that the Host can take after inspecting a Pi
/// session. The inspector is intentionally read-only; a later recovery
/// coordinator can turn these summaries into explicit commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PiRecoveryAction {
    NotApplicable,
    Clean,
    Replay,
    Reconcile,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRecoveryRun {
    pub run_id: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRecoveryTool {
    pub tool_call_id: String,
    pub tool_name: Option<String>,
    pub run_id: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRecoveryInteraction {
    pub interaction_id: String,
    pub kind: String,
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRecoveryTask {
    pub task_id: String,
    pub status: String,
    pub child_session_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRecoveryMessage {
    pub message_id: String,
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRecoveryPlan {
    pub session_id: String,
    pub engine: Option<String>,
    pub native_session_id: Option<String>,
    pub worker_epoch: Option<String>,
    pub last_seq: Option<i64>,
    pub last_ordinal: Option<i64>,
    pub event_count: i64,
    pub scanned_events: i64,
    pub scan_complete: bool,
    pub active_runs: Vec<PiRecoveryRun>,
    pub pending_tools: Vec<PiRecoveryTool>,
    pub pending_interactions: Vec<PiRecoveryInteraction>,
    pub active_tasks: Vec<PiRecoveryTask>,
    pub active_messages: Vec<PiRecoveryMessage>,
    pub compaction_in_progress: bool,
    pub recommended_action: PiRecoveryAction,
    pub reasons: Vec<String>,
}

#[derive(Default)]
struct RecoveryAccumulator {
    active_runs: BTreeMap<String, PiRecoveryRun>,
    pending_tools: BTreeMap<String, PiRecoveryTool>,
    pending_interactions: BTreeMap<String, PiRecoveryInteraction>,
    active_tasks: BTreeMap<String, PiRecoveryTask>,
    active_messages: BTreeMap<String, PiRecoveryMessage>,
    compaction_in_progress: bool,
    reasons: Vec<String>,
}

impl RecoveryAccumulator {
    fn reason(&mut self, reason: impl Into<String>) {
        if self.reasons.len() < MAX_RECOVERY_REASONS {
            self.reasons.push(reason.into());
        }
    }

    fn has_pending_work(&self) -> bool {
        !self.active_runs.is_empty()
            || !self.pending_tools.is_empty()
            || !self.pending_interactions.is_empty()
            || !self.active_tasks.is_empty()
            || !self.active_messages.is_empty()
            || self.compaction_in_progress
    }
}

fn required_id(value: &str, field: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.len() > MAX_RECOVERY_ID_BYTES {
        return Err(format!(
            "{field} must be a non-empty string of at most {MAX_RECOVERY_ID_BYTES} bytes"
        ));
    }
    Ok(value.to_string())
}

fn required_value_string(object: &Map<String, Value>, field: &str) -> Result<String, String> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be a string"))?;
    required_id(value, field)
}

fn optional_value_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => required_id(value, field).map(Some),
        Some(_) => Err(format!("{field} must be a string when present")),
    }
}

fn terminal_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed"
            | "complete"
            | "succeeded"
            | "success"
            | "failed"
            | "error"
            | "cancelled"
            | "canceled"
            | "interrupted"
            | "closed"
            | "done"
            | "finished"
            | "expired"
            | "rejected"
    )
}

fn valid_tool_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "pending" | "running" | "completed" | "failed" | "cancelled" | "canceled"
    )
}

fn valid_interaction_kind(kind: &str) -> bool {
    matches!(kind, "permission" | "question" | "plan")
}

fn inspect_event(
    raw: &str,
    session_id: &str,
    accumulator: &mut RecoveryAccumulator,
) -> Result<(), String> {
    let value = serde_json::from_str::<Value>(raw)
        .map_err(|_| "event log contains invalid JSON".to_string())?;
    let envelope = value
        .as_object()
        .ok_or_else(|| "event log envelope must be an object".to_string())?;
    if envelope.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("event log envelope uses an unsupported protocol version".to_string());
    }
    let envelope_session_id = required_value_string(envelope, "sessionId")?;
    if envelope_session_id != session_id {
        return Err("event log envelope belongs to another session".to_string());
    }
    required_value_string(envelope, "eventId")?;
    if envelope.get("replay").and_then(Value::as_bool).is_none() {
        return Err("event log envelope replay must be a boolean".to_string());
    }
    let run_id = optional_value_string(envelope, "runId")?;
    let event = envelope
        .get("event")
        .and_then(Value::as_object)
        .ok_or_else(|| "event log inner event must be an object".to_string())?;
    let event_type = required_value_string(event, "type")?;

    match event_type.as_str() {
        "run.accepted" => {
            let run_id = run_id.ok_or_else(|| "run.accepted has no runId".to_string())?;
            accumulator.active_runs.insert(
                run_id.clone(),
                PiRecoveryRun {
                    run_id,
                    status: "accepted".to_string(),
                },
            );
        }
        "run.started" => {
            let run_id = run_id.ok_or_else(|| "run.started has no runId".to_string())?;
            accumulator.active_runs.insert(
                run_id.clone(),
                PiRecoveryRun {
                    run_id,
                    status: "running".to_string(),
                },
            );
        }
        "run.finished" => {
            let run_id = run_id.ok_or_else(|| "run.finished has no runId".to_string())?;
            let status = required_value_string(event, "status")?;
            if !terminal_status(&status) {
                return Err(format!("run.finished has non-terminal status {status}"));
            }
            accumulator.active_runs.remove(&run_id);
        }
        "tool.requested" | "tool.started" | "tool.progress" => {
            let tool_call_id = required_value_string(event, "toolCallId")?;
            let tool_name = optional_value_string(event, "toolName")?;
            let status = optional_value_string(event, "status")?.unwrap_or_else(|| {
                if event_type == "tool.requested" {
                    "pending".to_string()
                } else {
                    "running".to_string()
                }
            });
            if !valid_tool_status(&status) {
                return Err(format!("tool event has unsupported status {status}"));
            }
            if terminal_status(&status) {
                accumulator.pending_tools.remove(&tool_call_id);
            } else {
                accumulator.pending_tools.insert(
                    tool_call_id.clone(),
                    PiRecoveryTool {
                        tool_call_id,
                        tool_name,
                        run_id,
                        status,
                    },
                );
            }
        }
        "tool.finished" => {
            let tool_call_id = required_value_string(event, "toolCallId")?;
            accumulator.pending_tools.remove(&tool_call_id);
        }
        "interaction.requested" => {
            let interaction_id = required_value_string(event, "interactionId")?;
            let kind = required_value_string(event, "kind")?;
            if !valid_interaction_kind(&kind) {
                return Err(format!("interaction.requested has unsupported kind {kind}"));
            }
            accumulator.pending_interactions.insert(
                interaction_id.clone(),
                PiRecoveryInteraction {
                    interaction_id,
                    kind,
                    run_id,
                },
            );
        }
        "interaction.resolved" | "interaction.expired" => {
            let interaction_id = required_value_string(event, "interactionId")?;
            let kind = required_value_string(event, "kind")?;
            if !valid_interaction_kind(&kind) {
                return Err(format!("interaction event has unsupported kind {kind}"));
            }
            accumulator.pending_interactions.remove(&interaction_id);
        }
        "task.changed" | "subagent.changed" => {
            let task_id = required_value_string(event, "taskId")?;
            let status = required_value_string(event, "status")?;
            let child_session_id = optional_value_string(event, "childSessionId")?;
            if terminal_status(&status) {
                accumulator.active_tasks.remove(&task_id);
            } else {
                accumulator.active_tasks.insert(
                    task_id.clone(),
                    PiRecoveryTask {
                        task_id,
                        status,
                        child_session_id,
                        run_id,
                    },
                );
            }
        }
        "message.started" => {
            let message_id = required_value_string(event, "messageId")?;
            let role = required_value_string(event, "role")?;
            if role != "user" && role != "assistant" {
                return Err(format!("message.started has unsupported role {role}"));
            }
            accumulator
                .active_messages
                .insert(message_id.clone(), PiRecoveryMessage { message_id, role });
        }
        "message.completed" => {
            let message_id = required_value_string(event, "messageId")?;
            let role = required_value_string(event, "role")?;
            if role != "user" && role != "assistant" {
                return Err(format!("message.completed has unsupported role {role}"));
            }
            accumulator.active_messages.remove(&message_id);
        }
        "session.compacting" => {
            accumulator.compaction_in_progress = true;
        }
        "session.compacted" => {
            accumulator.compaction_in_progress = false;
        }
        _ => {
            // Unknown events are intentionally forward-compatible. They are
            // still present in the durable log and can be replayed by a newer
            // projection, but they do not make recovery unsafe by themselves.
        }
    }
    Ok(())
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSessionBinding> {
    Ok(AgentSessionBinding {
        session_id: row.get(0)?,
        engine: row.get(1)?,
        native_session_id: row.get(2)?,
        worker_epoch: row.get(3)?,
        last_seq: row.get(4)?,
        session_mode_id: row.get(5)?,
        permission_mode: row.get(6)?,
        model_id: row.get(7)?,
        reasoning_effort: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn recovery_plan(connection: &Connection, session_id: &str) -> Result<PiRecoveryPlan, String> {
    let session_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !session_exists {
        return Err(format!("Session {session_id} does not exist"));
    }

    let binding = connection
        .query_row(
            "SELECT session_id, engine, native_session_id, worker_epoch, last_seq,
                    session_mode_id, permission_mode, model_id, reasoning_effort, updated_at
             FROM agent_session_bindings WHERE session_id = ?1",
            [session_id],
            binding_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let event_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM agent_event_log WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let last_ordinal: Option<i64> = connection
        .query_row(
            "SELECT MAX(ordinal) FROM agent_event_log WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let scan_complete = event_count <= MAX_RECOVERY_SCAN;
    let scan_start = last_ordinal
        .unwrap_or(0_i64)
        .saturating_sub(MAX_RECOVERY_SCAN.saturating_sub(1));
    let mut accumulator = RecoveryAccumulator::default();

    if binding.is_none() && event_count > 0 {
        accumulator.reason("事件日志存在但缺少会话绑定，无法安全恢复");
    } else if binding.as_ref().is_some_and(|value| value.engine != "pi") && event_count > 0 {
        accumulator.reason("事件日志与非 Pi 引擎绑定冲突，需要显式迁移");
    } else if binding.as_ref().is_some_and(|value| value.engine == "pi") {
        let mut statement = connection
            .prepare(
                "SELECT ordinal, event_json FROM agent_event_log
                 WHERE session_id = ?1 AND ordinal >= ?2
                 ORDER BY ordinal ASC LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![session_id, scan_start, MAX_RECOVERY_SCAN], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (ordinal, event_json) = row.map_err(|error| error.to_string())?;
            if let Err(reason) = inspect_event(&event_json, session_id, &mut accumulator) {
                accumulator.reason(format!("事件日志第 {ordinal} 条无法用于恢复：{reason}"));
            }
        }
    }

    if !scan_complete {
        accumulator.reason(format!(
            "事件日志超过 {} 条恢复扫描上限，需要继续分页重放",
            MAX_RECOVERY_SCAN
        ));
    }

    let has_binding_conflict = (binding.is_none() && event_count > 0)
        || (binding
            .as_ref()
            .is_some_and(|value| value.engine != "pi" && event_count > 0));
    let recommended_action = if has_binding_conflict || !scan_complete {
        PiRecoveryAction::Blocked
    } else if binding.is_none() || binding.as_ref().is_some_and(|value| value.engine != "pi") {
        PiRecoveryAction::NotApplicable
    } else if !accumulator.reasons.is_empty() {
        PiRecoveryAction::Blocked
    } else if accumulator.has_pending_work() {
        PiRecoveryAction::Reconcile
    } else if event_count > 0 {
        PiRecoveryAction::Replay
    } else {
        PiRecoveryAction::Clean
    };

    if recommended_action == PiRecoveryAction::Reconcile {
        if !accumulator.active_runs.is_empty() {
            accumulator.reason("存在未结束的 Pi 回合，恢复前需要确认其最终状态");
        }
        if !accumulator.pending_tools.is_empty() {
            accumulator.reason("存在未结束的工具调用，不能自动重跑未知副作用");
        }
        if !accumulator.pending_interactions.is_empty() {
            accumulator.reason("存在未决交互，恢复前需要重新绑定审批或问题");
        }
        if !accumulator.active_tasks.is_empty() {
            accumulator.reason("存在未结束的任务或子代理，需要重新关联其生命周期");
        }
        if !accumulator.active_messages.is_empty() {
            accumulator.reason("存在未完成消息，需从事件日志重建尾部内容");
        }
        if accumulator.compaction_in_progress {
            accumulator.reason("压缩在进程退出前未完成，不能假定上下文已切换");
        }
    }

    let scanned_events = if binding.as_ref().is_some_and(|value| value.engine == "pi") {
        event_count.min(MAX_RECOVERY_SCAN)
    } else {
        0
    };
    let (engine, native_session_id, worker_epoch, last_seq) = binding
        .map(|value| {
            (
                Some(value.engine),
                value.native_session_id,
                value.worker_epoch,
                value.last_seq,
            )
        })
        .unwrap_or((None, None, None, None));

    Ok(PiRecoveryPlan {
        session_id: session_id.to_string(),
        engine,
        native_session_id,
        worker_epoch,
        last_seq,
        last_ordinal,
        event_count,
        scanned_events,
        scan_complete,
        active_runs: accumulator.active_runs.into_values().collect(),
        pending_tools: accumulator.pending_tools.into_values().collect(),
        pending_interactions: accumulator.pending_interactions.into_values().collect(),
        active_tasks: accumulator.active_tasks.into_values().collect(),
        active_messages: accumulator.active_messages.into_values().collect(),
        compaction_in_progress: accumulator.compaction_in_progress,
        recommended_action,
        reasons: accumulator.reasons,
    })
}

/// Inspect one product session without opening Pi or executing any tool.
/// This is deliberately a summary endpoint: event payloads, prompts and tool
/// output never cross the database/renderer boundary through this command.
#[tauri::command]
pub fn inspect_pi_session_recovery(
    database: State<'_, AppDatabase>,
    session_id: String,
) -> Result<PiRecoveryPlan, String> {
    required_id(&session_id, "sessionId")?;
    let connection = database
        .connection
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    recovery_plan(&connection, &session_id)
}
