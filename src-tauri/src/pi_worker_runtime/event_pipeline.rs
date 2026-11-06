//! Orders the Host-side event commit and delivery stages for one worker frame.
//!
//! Stream framing and process-generation teardown remain with `PiWorkerRuntime`;
//! this owner makes persistence-before-publication and duplicate handling
//! testable through a small event port.

use std::{future::Future, path::Path};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::{
    EventAcceptance, PI_AGENT_EVENT, PiEventPersistence, PiWorkerRuntime, event_acceptance,
    host_tool_routing, pi_tool_gateway,
};
use event_acceptance::is_sequence_violation;

/// The coordinator's only seam: generation acceptance, durable commit, and
/// post-commit delivery remain behind one production adapter and one fake.
trait EventPort: Sync {
    fn accept_event<'a>(
        &'a self,
        value: &'a Value,
    ) -> impl Future<Output = Result<EventAcceptance, String>> + Send + 'a;

    fn persist_event(
        &self,
        value: &Value,
        worker_cwd: Option<&Path>,
    ) -> Result<PiEventPersistence, String>;

    fn publish_event<'a>(
        &'a self,
        value: &'a Value,
        worker_cwd: Option<&'a Path>,
    ) -> impl Future<Output = ()> + Send + 'a;
}

async fn process_with_port<P: EventPort>(
    port: &P,
    value: &Value,
    worker_cwd: Option<&Path>,
) -> Result<(), String> {
    let acceptance = match port.accept_event(value).await {
        Ok(acceptance) => acceptance,
        Err(error) if is_sequence_violation(&error) => {
            match port.persist_event(value, worker_cwd) {
                Ok(PiEventPersistence::Duplicate) => return Ok(()),
                Ok(PiEventPersistence::Inserted) => return Err(error),
                Ok(PiEventPersistence::UnknownSession) => {
                    return Err("Pi event referenced an unknown product session".to_string());
                }
                Err(persist_error) => {
                    return Err(format!(
                        "Failed to persist Pi event before delivery: {persist_error}"
                    ));
                }
            }
        }
        Err(error) => return Err(error),
    };
    if acceptance == EventAcceptance::Duplicate {
        return Ok(());
    }
    match port.persist_event(value, worker_cwd) {
        Ok(PiEventPersistence::Inserted) => {}
        Ok(PiEventPersistence::Duplicate) => return Ok(()),
        Ok(PiEventPersistence::UnknownSession) => {
            return Err("Pi event referenced an unknown product session".to_string());
        }
        Err(error) => {
            return Err(format!(
                "Failed to persist Pi event before delivery: {error}"
            ));
        }
    }
    port.publish_event(value, worker_cwd).await;
    Ok(())
}

/// Run acceptance, durable commit, and post-commit effects for one decoded
/// JSON frame. The caller supplies the optional workspace identity because a
/// failed lookup remains best-effort for unscoped runtime events.
pub(super) async fn process_stdout_event(
    runtime: &PiWorkerRuntime,
    app: &AppHandle,
    generation: u64,
    value: &Value,
    worker_cwd: Option<&Path>,
) -> Result<(), String> {
    let port = HostEventPort {
        runtime,
        app,
        generation,
    };
    process_with_port(&port, value, worker_cwd).await
}

struct HostEventPort<'a> {
    runtime: &'a PiWorkerRuntime,
    app: &'a AppHandle,
    generation: u64,
}

impl EventPort for HostEventPort<'_> {
    fn accept_event<'a>(
        &'a self,
        value: &'a Value,
    ) -> impl Future<Output = Result<EventAcceptance, String>> + Send + 'a {
        self.runtime.accept_event(self.generation, value)
    }

    fn persist_event(
        &self,
        value: &Value,
        worker_cwd: Option<&Path>,
    ) -> Result<PiEventPersistence, String> {
        super::persist_pi_event(self.app, value, worker_cwd)
    }

    fn publish_event<'a>(
        &'a self,
        value: &'a Value,
        worker_cwd: Option<&'a Path>,
    ) -> impl Future<Output = ()> + Send + 'a {
        async move {
            self.runtime
                .inner
                .memory_lifecycle
                .observe_event(self.app, value, worker_cwd)
                .await;
            self.runtime.inner.dispatch.observe_event(value);

            // Host-owned lifecycle hooks are observational in Pi and are
            // re-read for each event. Keep them off the reader loop so a slow
            // bounded hook cannot stall streaming or permission delivery.
            let hook_runtime = self.runtime.clone();
            let hook_app = self.app.clone();
            let hook_value = value.clone();
            let generation = self.generation;
            tauri::async_runtime::spawn(async move {
                hook_runtime
                    .observe_host_hook_event(&hook_app, generation, &hook_value)
                    .await;
            });

            let persisted_permission =
                host_tool_routing::persisted_permission_for_interaction(self.app, value);
            let is_tool_request = pi_tool_gateway::is_tool_request(value);
            let _ = self.app.emit(PI_AGENT_EVENT, value.clone());
            if let Some((session_id, interaction_id, decision)) = persisted_permission {
                let request_runtime = self.runtime.clone();
                let request_app = self.app.clone();
                let request_value = value.clone();
                let generation = self.generation;
                tauri::async_runtime::spawn(async move {
                    request_runtime
                        .resolve_persisted_permission(
                            &request_app,
                            generation,
                            &request_value,
                            session_id,
                            interaction_id,
                            decision,
                        )
                        .await;
                });
            }
            if is_tool_request {
                let request_runtime = self.runtime.clone();
                let request_app = self.app.clone();
                let request_value = value.clone();
                let generation = self.generation;
                tauri::async_runtime::spawn(async move {
                    request_runtime
                        .resolve_tool_request(&request_app, generation, &request_value)
                        .await;
                });
            }
        }
    }
}
