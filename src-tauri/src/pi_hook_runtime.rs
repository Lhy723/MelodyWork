//! Host-owned compatibility runner for the declarative command-hook subset.
//!
//! Melody/Claude hooks are normally arbitrary extension code.  Pi must not
//! load that code in the worker, so this module accepts only the standard JSON
//! command-hook shape from trusted `.melody/hooks` roots and executes the
//! command in the Host with a clean, bounded environment.  Unsupported hook
//! types/events are reported to capability preflight and keep the session on
//! ACP instead of being silently ignored.

#[path = "pi_hook_runtime/hook_config.rs"]
mod hook_config;
#[path = "pi_hook_runtime/hook_execution.rs"]
mod hook_execution;

pub(crate) use hook_config::{MelodyHookSnapshot, list_melody_hooks};
pub(crate) use hook_execution::{HookEvent, HookRunResult, run_event_hooks, run_tool_hooks};
