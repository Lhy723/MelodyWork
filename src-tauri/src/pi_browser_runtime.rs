//! Session-scoped embedded browser views and a bounded browser tool surface for Pi.
//!
//! Remote pages run in child WebViews with no Melody IPC capabilities. Only
//! this Host module evaluates fixed scripts for snapshots and short-lived refs.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use reqwest::Url;
#[path = "pi_browser_runtime/browser_policy.rs"]
mod browser_policy;
#[path = "pi_browser_runtime/screenshot.rs"]
mod browser_screenshot;
#[path = "pi_browser_runtime/page_tools.rs"]
mod page_tools;
#[path = "pi_browser_runtime/session_lifecycle.rs"]
mod session_lifecycle;
#[path = "pi_browser_runtime/view_creation.rs"]
mod view_creation;
use self::browser_policy::{validate_local_preview_url, validate_url};
pub(crate) use self::browser_screenshot::BrowserScreenshot;
pub(crate) use self::page_tools::BrowserSnapshot;
use self::page_tools::{BrowserRef, BrowserWaitOptions};
use self::session_lifecycle::{BrowserSessionLifecycle, BrowserTabAdapter};
use self::view_creation::create_browser_view;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State, Webview};

use crate::pi_tool_gateway::{
    self, BROWSER_CLICK, BROWSER_NAVIGATE, BROWSER_SCREENSHOT, BROWSER_SNAPSHOT, BROWSER_TAB_CLOSE,
    BROWSER_TAB_OPEN, BROWSER_TAB_SELECT, BROWSER_TABS, BROWSER_TYPE, BROWSER_WAIT,
};

const MAX_SESSION_ID_BYTES: usize = 256;
const BROWSER_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(200);
const BROWSER_SCREENSHOT_OUTPUT_PREFIX: &str = "data:image/jpeg;base64,";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

impl BrowserBounds {
    fn new(x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<Self, String> {
        if ![x, y, width, height].into_iter().all(f64::is_finite)
            || x < 0.0
            || y < 0.0
            || width < 1.0
            || height < 1.0
            || x > 20_000.0
            || y > 20_000.0
            || width > 20_000.0
            || height > 20_000.0
        {
            return Err("Browser view bounds are invalid or outside the window.".to_string());
        }
        Ok(Self {
            x,
            y,
            width,
            height,
            visible,
        })
    }
}

struct BrowserEntry {
    view: Webview,
    snapshot_url: Option<String>,
    refs: HashMap<String, BrowserRef>,
    bounds: Option<BrowserBounds>,
    local_origin: Arc<Mutex<Option<String>>>,
    popup_policy: Arc<AtomicBool>,
}

struct BrowserTabCreateRequest {
    app: AppHandle,
    session_id: String,
    initial_url: Url,
}

#[derive(Default)]
struct TauriBrowserTabAdapter;

impl BrowserTabAdapter<BrowserEntry> for TauriBrowserTabAdapter {
    type CreateRequest = BrowserTabCreateRequest;

    fn create(
        &mut self,
        tab_id: &str,
        request: Self::CreateRequest,
    ) -> Result<BrowserEntry, String> {
        let local_origin = Arc::new(Mutex::new(None));
        let popup_policy = Arc::new(AtomicBool::new(false));
        let view = create_browser_view(
            &request.app,
            &request.session_id,
            tab_id,
            &request.initial_url,
            Arc::clone(&local_origin),
            Arc::clone(&popup_policy),
        )?;
        Ok(BrowserEntry {
            view,
            snapshot_url: None,
            refs: HashMap::new(),
            bounds: None,
            local_origin,
            popup_policy,
        })
    }

    fn apply_selection(
        &mut self,
        _tab_id: &str,
        entry: &BrowserEntry,
        active: bool,
    ) -> Result<(), String> {
        if let Some(bounds) = entry.bounds.as_ref() {
            let visible_bounds = BrowserBounds {
                visible: active && bounds.visible,
                ..bounds.clone()
            };
            apply_browser_bounds(entry, &visible_bounds)
        } else if !active {
            #[cfg(desktop)]
            entry
                .view
                .hide()
                .map_err(|error| format!("Unable to hide inactive browser tab: {error}"))?;
            Ok(())
        } else {
            Ok(())
        }
    }

    fn close(&mut self, entry: BrowserEntry) -> Result<(), String> {
        close_view(&entry.view)
    }
}

type BrowserSession = BrowserSessionLifecycle<BrowserEntry>;

#[derive(Default)]
pub(crate) struct PiBrowserRuntime {
    entries: Mutex<HashMap<String, BrowserSession>>,
}

fn entries(
    state: &PiBrowserRuntime,
) -> Result<MutexGuard<'_, HashMap<String, BrowserSession>>, String> {
    state
        .entries
        .lock()
        .map_err(|_| "Browser Host state lock is unavailable.".to_string())
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || session_id.chars().any(char::is_control)
    {
        return Err("Browser session id is invalid or too long.".to_string());
    }
    Ok(())
}

fn view_for_session(
    app: &AppHandle,
    state: &PiBrowserRuntime,
    session_id: &str,
    url: Option<&str>,
) -> Result<(String, Webview), String> {
    validate_session_id(session_id)?;
    let parsed_url = url.map(validate_url).transpose()?;
    let mut sessions = entries(state)?;
    let session = sessions.entry(session_id.to_string()).or_default();
    let mut adapter = TauriBrowserTabAdapter;
    let tab_id = session.ensure_active_entry(
        &mut adapter,
        BrowserTabCreateRequest {
            app: app.clone(),
            session_id: session_id.to_string(),
            initial_url: Url::parse("about:blank").expect("valid URL"),
        },
    )?;
    let entry = session
        .entry_mut(&tab_id)
        .ok_or_else(|| "The browser tab could not be initialized.".to_string())?;
    if let Some(url) = parsed_url {
        if let Ok(mut origin) = entry.local_origin.lock() {
            *origin = None;
        }
        entry
            .view
            .navigate(url)
            .map_err(|error| format!("Unable to navigate browser: {error}"))?;
        entry.snapshot_url = None;
        entry.refs.clear();
    }
    Ok((tab_id, entry.view.clone()))
}

async fn read_snapshot(
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
    view: &Webview,
) -> Result<BrowserSnapshot, String> {
    let local_origin = entries(state)?
        .get(session_id)
        .and_then(|session| session.entry(tab_id))
        .and_then(|entry| {
            entry
                .local_origin
                .lock()
                .ok()
                .and_then(|origin| origin.clone())
        });
    let capture = page_tools::capture_snapshot(view, local_origin.as_deref()).await?;
    let snapshot_url = capture.snapshot.url.clone();
    let mut sessions = entries(state)?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| "Browser session was closed while capturing a snapshot.".to_string())?;
    let entry = session
        .entry_mut(tab_id)
        .ok_or_else(|| "Browser tab was closed while capturing a snapshot.".to_string())?;
    entry.snapshot_url = Some(snapshot_url);
    entry.refs = capture.refs;
    Ok(capture.snapshot)
}

async fn wait_for_browser_snapshot(
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
    view: &Webview,
    options: BrowserWaitOptions,
) -> Result<Value, String> {
    let started = tokio::time::Instant::now();
    let deadline = started + options.timeout;
    loop {
        if browser_status(state, session_id)?.active_tab_id.as_deref() != Some(tab_id) {
            return Err(
                "The active Browser tab changed while waiting; inspect the current tab and retry."
                    .to_string(),
            );
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Browser wait timed out before a page snapshot completed.".to_string());
        }
        let snapshot =
            tokio::time::timeout(remaining, read_snapshot(state, session_id, tab_id, view))
                .await
                .map_err(|_| "Browser wait timed out while reading the page.".to_string())??;
        let matched = options.matches(&snapshot);
        let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        if matched || tokio::time::Instant::now() >= deadline {
            return Ok(json!({
                "matched": matched,
                "elapsed_ms": elapsed_ms,
                "snapshot": snapshot,
            }));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::time::sleep(BROWSER_WAIT_POLL_INTERVAL.min(remaining)).await;
    }
}

async fn click_ref(
    state: &PiBrowserRuntime,
    session_id: &str,
    ref_id: &str,
) -> Result<String, String> {
    let (window, snapshot_url, element) =
        {
            let sessions = entries(state)?;
            let session = sessions.get(session_id).ok_or_else(|| {
                "Open the browser and capture a snapshot before clicking.".to_string()
            })?;
            let tab_id = session.active_id().ok_or_else(|| {
                "Open the browser and capture a snapshot before clicking.".to_string()
            })?;
            let entry = session.entry(tab_id).ok_or_else(|| {
                "Open the browser and capture a snapshot before clicking.".to_string()
            })?;
            let element =
                entry.refs.get(ref_id).cloned().ok_or_else(|| {
                    "Browser ref is stale; capture a new snapshot first.".to_string()
                })?;
            (
                entry.view.clone(),
                entry.snapshot_url.clone().ok_or_else(|| {
                    "Browser ref is stale; capture a new snapshot first.".to_string()
                })?,
                element,
            )
        };
    page_tools::click_ref(&window, &snapshot_url, ref_id, &element).await
}

async fn type_into_ref(
    state: &PiBrowserRuntime,
    session_id: &str,
    ref_id: &str,
    text: &str,
) -> Result<String, String> {
    let (window, snapshot_url, element) =
        {
            let sessions = entries(state)?;
            let session = sessions.get(session_id).ok_or_else(|| {
                "Open the browser and capture a snapshot before typing.".to_string()
            })?;
            let tab_id = session.active_id().ok_or_else(|| {
                "Open the browser and capture a snapshot before typing.".to_string()
            })?;
            let entry = session.entry(tab_id).ok_or_else(|| {
                "Open the browser and capture a snapshot before typing.".to_string()
            })?;
            let element =
                entry.refs.get(ref_id).cloned().ok_or_else(|| {
                    "Browser ref is stale; capture a new snapshot first.".to_string()
                })?;
            (
                entry.view.clone(),
                entry.snapshot_url.clone().ok_or_else(|| {
                    "Browser ref is stale; capture a new snapshot first.".to_string()
                })?,
                element,
            )
        };
    page_tools::type_into_ref(&window, &snapshot_url, ref_id, &element, text).await
}

async fn capture_browser_screenshot(
    app: &AppHandle,
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
    view: &Webview,
) -> Result<BrowserScreenshot, String> {
    let (bounds, local_origin) = {
        let sessions = entries(state)?;
        let entry = sessions
            .get(session_id)
            .and_then(|session| session.entry(tab_id))
            .ok_or_else(|| "The active browser tab is no longer available.".to_string())?;
        let bounds = entry
            .bounds
            .clone()
            .ok_or_else(|| "Open the Browser panel before capturing a screenshot.".to_string())?;
        (
            bounds,
            entry
                .local_origin
                .lock()
                .ok()
                .and_then(|origin| origin.clone()),
        )
    };
    browser_screenshot::capture_browser_screenshot(app, tab_id, view, bounds, local_origin).await
}

pub(crate) async fn resolve_request(
    app: &AppHandle,
    value: &Value,
    state: &PiBrowserRuntime,
) -> Result<String, String> {
    let (session_id, _, _, tool_name, arguments, _) = pi_tool_gateway::event_context(value)?;
    match tool_name {
        BROWSER_NAVIGATE => {
            let raw_url = arguments
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "browser_navigate requires a URL.".to_string())?;
            let url = validate_url(raw_url)?;
            let (_, _) = view_for_session(app, state, session_id, Some(url.as_str()))?;
            emit_browser_changed(app, session_id, "");
            Ok(format!("Navigated the Melody Browser to {}.", url))
        }
        BROWSER_TABS => {
            let status = browser_status(state, session_id)?;
            serde_json::to_string(&status).map_err(|error| error.to_string())
        }
        BROWSER_SNAPSHOT => {
            let (tab_id, view) = active_view(state, session_id)?;
            let snapshot = read_snapshot(state, session_id, &tab_id, &view).await?;
            serde_json::to_string(&snapshot).map_err(|error| error.to_string())
        }
        BROWSER_WAIT => {
            let options = BrowserWaitOptions::parse(arguments)?;
            let (tab_id, view) = active_view(state, session_id)?;
            let result =
                wait_for_browser_snapshot(state, session_id, &tab_id, &view, options).await?;
            serde_json::to_string(&result).map_err(|error| error.to_string())
        }
        BROWSER_SCREENSHOT => {
            let (tab_id, view) = active_view(state, session_id)?;
            let screenshot =
                capture_browser_screenshot(app, state, session_id, &tab_id, &view).await?;
            Ok(format!(
                "{BROWSER_SCREENSHOT_OUTPUT_PREFIX}{}",
                screenshot.data
            ))
        }
        BROWSER_TAB_OPEN => {
            let url = match arguments.get("url") {
                None | Some(Value::Null) => None,
                Some(Value::String(url)) => Some(url.as_str()),
                _ => return Err("browser_tab_open url must be a string.".to_string()),
            };
            let status = open_browser_tab(app, state, session_id, url)?;
            serde_json::to_string(&status).map_err(|error| error.to_string())
        }
        BROWSER_TAB_SELECT => {
            let tab_id = arguments
                .get("tab_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "browser_tab_select requires a tab_id.".to_string())?;
            let status = select_browser_tab(app, state, session_id, tab_id)?;
            serde_json::to_string(&status).map_err(|error| error.to_string())
        }
        BROWSER_TAB_CLOSE => {
            let tab_id = arguments
                .get("tab_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "browser_tab_close requires a tab_id.".to_string())?;
            let status = close_browser_tab(app, state, session_id, tab_id)?;
            serde_json::to_string(&status).map_err(|error| error.to_string())
        }
        BROWSER_CLICK => {
            let ref_id = arguments
                .get("ref_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "browser_click requires a snapshot ref_id.".to_string())?;
            click_ref(state, session_id, ref_id).await
        }
        BROWSER_TYPE => {
            let ref_id = arguments
                .get("ref_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "browser_type requires a snapshot ref_id.".to_string())?;
            let text = arguments
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "browser_type requires text.".to_string())?;
            type_into_ref(state, session_id, ref_id, text).await
        }
        _ => Err("Unsupported browser operation.".to_string()),
    }
}

fn active_view(state: &PiBrowserRuntime, session_id: &str) -> Result<(String, Webview), String> {
    let sessions = entries(state)?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| "The session browser is not open yet.".to_string())?;
    let tab_id = session
        .active_id()
        .ok_or_else(|| "The session browser has no active tab.".to_string())?;
    let view = session
        .entry(tab_id)
        .map(|entry| entry.view.clone())
        .ok_or_else(|| "The active browser tab is not open yet.".to_string())?;
    Ok((tab_id.to_string(), view))
}

fn emit_browser_changed(app: &AppHandle, session_id: &str, tab_id: &str) {
    let _ = app.emit_to(
        tauri::EventTarget::webview_window("main"),
        "melody://pi-browser-changed",
        serde_json::json!({ "sessionId": session_id, "tabId": tab_id }),
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTabStatus {
    pub id: String,
    pub url: Option<String>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStatus {
    pub session_id: String,
    pub open: bool,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<BrowserTabStatus>,
}

fn browser_status(state: &PiBrowserRuntime, session_id: &str) -> Result<BrowserStatus, String> {
    let sessions = entries(state)?;
    let Some(session) = sessions.get(session_id) else {
        return Ok(BrowserStatus {
            session_id: session_id.to_string(),
            open: false,
            active_tab_id: None,
            tabs: Vec::new(),
        });
    };
    let active_tab_id = session.active_id().map(str::to_string);
    let tabs = session
        .tab_ids()
        .iter()
        .map(|id| BrowserTabStatus {
            id: id.clone(),
            url: session
                .entry(id)
                .and_then(|entry| entry.view.url().ok())
                .map(|url| url.to_string()),
            active: active_tab_id.as_deref() == Some(id.as_str()),
        })
        .collect();
    Ok(BrowserStatus {
        session_id: session_id.to_string(),
        open: !session.tab_ids().is_empty(),
        active_tab_id,
        tabs,
    })
}

fn apply_browser_bounds(entry: &BrowserEntry, bounds: &BrowserBounds) -> Result<(), String> {
    if !bounds.visible {
        #[cfg(desktop)]
        entry
            .view
            .hide()
            .map_err(|error| format!("Unable to hide embedded browser: {error}"))?;
        #[cfg(not(desktop))]
        return Err("The embedded browser is only available on desktop platforms.".to_string());
        return Ok(());
    }
    #[cfg(desktop)]
    {
        entry
            .view
            .set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|error| format!("Unable to position embedded browser: {error}"))?;
        entry
            .view
            .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
            .map_err(|error| format!("Unable to resize embedded browser: {error}"))?;
        entry
            .view
            .show()
            .map_err(|error| format!("Unable to show embedded browser: {error}"))?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        Err("The embedded browser is only available on desktop platforms.".to_string())
    }
}

fn close_view(view: &Webview) -> Result<(), String> {
    #[cfg(desktop)]
    {
        view.close()
            .map_err(|error| format!("Unable to close embedded browser: {error}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = view;
        Err("The embedded browser is only available on desktop platforms.".to_string())
    }
}

fn open_browser_tab(
    app: &AppHandle,
    state: &PiBrowserRuntime,
    session_id: &str,
    url: Option<&str>,
) -> Result<BrowserStatus, String> {
    validate_session_id(session_id)?;
    let parsed_url = url.map(validate_url).transpose()?;
    let blank = Url::parse("about:blank").expect("valid URL");
    let start_url = parsed_url.as_ref().unwrap_or(&blank);
    let mut sessions = entries(state)?;
    let session = sessions.entry(session_id.to_string()).or_default();
    let mut adapter = TauriBrowserTabAdapter;
    let tab_id = session.open(
        &mut adapter,
        BrowserTabCreateRequest {
            app: app.clone(),
            session_id: session_id.to_string(),
            initial_url: start_url.clone(),
        },
    )?;
    drop(sessions);
    emit_browser_changed(app, session_id, &tab_id);
    browser_status(state, session_id)
}

fn select_browser_tab(
    app: &AppHandle,
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
) -> Result<BrowserStatus, String> {
    validate_session_id(session_id)?;
    let mut sessions = entries(state)?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| "Browser session does not exist.".to_string())?;
    session.select(tab_id, &mut TauriBrowserTabAdapter)?;
    drop(sessions);
    emit_browser_changed(app, session_id, tab_id);
    browser_status(state, session_id)
}

fn close_browser_tab(
    app: &AppHandle,
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
) -> Result<BrowserStatus, String> {
    validate_session_id(session_id)?;
    let mut sessions = entries(state)?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| "Browser session does not exist.".to_string())?;
    let active_id = session.close(tab_id, &mut TauriBrowserTabAdapter)?;
    drop(sessions);
    emit_browser_changed(app, session_id, active_id.as_deref().unwrap_or_default());
    browser_status(state, session_id)
}

#[tauri::command]
pub(crate) fn pi_browser_tab_open(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    url: Option<String>,
) -> Result<BrowserStatus, String> {
    open_browser_tab(&app, &state, &session_id, url.as_deref())
}

#[tauri::command]
pub(crate) fn pi_browser_tab_select(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    tab_id: String,
) -> Result<BrowserStatus, String> {
    select_browser_tab(&app, &state, &session_id, &tab_id)
}

#[tauri::command]
pub(crate) fn pi_browser_tab_close(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    tab_id: String,
) -> Result<BrowserStatus, String> {
    close_browser_tab(&app, &state, &session_id, &tab_id)
}

#[tauri::command]
pub(crate) fn pi_browser_set_bounds(
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let bounds = BrowserBounds::new(x, y, width, height, visible)?;
    let mut sessions = entries(&state)?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Browser session does not exist.".to_string())?;
    let active = session.active_id() == Some(tab_id.as_str());
    let entry = session
        .entry_mut(&tab_id)
        .ok_or_else(|| "Browser tab does not exist.".to_string())?;
    let bounds_to_apply = BrowserBounds {
        visible: bounds.visible && active,
        ..bounds.clone()
    };
    entry.bounds = Some(bounds);
    apply_browser_bounds(entry, &bounds_to_apply)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn pi_browser_set_popup_policy(
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    tab_id: String,
    allow: bool,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let sessions = entries(&state)?;
    let entry = sessions
        .get(&session_id)
        .and_then(|session| session.entry(&tab_id))
        .ok_or_else(|| "Browser tab does not exist.".to_string())?;
    entry.popup_policy.store(allow, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub(crate) async fn pi_browser_open(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    url: Option<String>,
) -> Result<BrowserStatus, String> {
    view_for_session(&app, &state, &session_id, url.as_deref())?;
    browser_status(&state, &session_id)
}

#[tauri::command]
pub(crate) async fn pi_browser_navigate(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    url: String,
) -> Result<BrowserStatus, String> {
    view_for_session(&app, &state, &session_id, Some(&url))?;
    emit_browser_changed(&app, &session_id, "");
    browser_status(&state, &session_id)
}

#[tauri::command]
pub(crate) async fn pi_browser_navigate_local_preview(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
    url: String,
) -> Result<BrowserStatus, String> {
    let url = validate_local_preview_url(&url)?;
    let (tab_id, view) = view_for_session(&app, &state, &session_id, None)?;
    {
        let mut sessions = entries(&state)?;
        let entry = sessions
            .get_mut(&session_id)
            .and_then(|session| session.entry_mut(&tab_id))
            .ok_or_else(|| "Browser tab does not exist.".to_string())?;
        let mut local_origin = entry
            .local_origin
            .lock()
            .map_err(|_| "Browser navigation policy is unavailable.".to_string())?;
        *local_origin = Some(url.origin().ascii_serialization());
        entry.snapshot_url = None;
        entry.refs.clear();
    }
    view.navigate(url)
        .map_err(|error| format!("Unable to navigate local preview: {error}"))?;
    emit_browser_changed(&app, &session_id, &tab_id);
    browser_status(&state, &session_id)
}

#[tauri::command]
pub(crate) async fn pi_browser_snapshot(
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
) -> Result<BrowserSnapshot, String> {
    let (tab_id, view) = active_view(&state, &session_id)?;
    read_snapshot(&state, &session_id, &tab_id, &view).await
}

#[tauri::command]
pub(crate) async fn pi_browser_screenshot(
    app: AppHandle,
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
) -> Result<BrowserScreenshot, String> {
    let (tab_id, view) = active_view(&state, &session_id)?;
    capture_browser_screenshot(&app, &state, &session_id, &tab_id, &view).await
}

#[tauri::command]
pub(crate) fn pi_browser_close(
    state: State<'_, PiBrowserRuntime>,
    session_id: String,
) -> Result<(), String> {
    let session = entries(&state)?.remove(&session_id);
    if let Some(session) = session {
        for entry in session.into_entries().into_values() {
            close_view(&entry.view)?;
        }
    }
    Ok(())
}

pub(crate) fn close_main_window(state: &PiBrowserRuntime) {
    if let Ok(mut entries) = state.entries.lock() {
        entries.clear();
    }
}
