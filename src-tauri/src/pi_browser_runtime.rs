//! Session-scoped embedded browser views and a bounded browser tool surface for Pi.
//!
//! Remote pages run in child WebViews with no Melody IPC capabilities. Only
//! this Host module evaluates fixed scripts for snapshots and short-lived refs.

use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use image::{DynamicImage, codecs::jpeg::JpegEncoder};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::env;
use tauri::WebviewWindowBuilder;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewUrl};
use tokio::sync::oneshot;

use crate::pi_tool_gateway::{
    self, BROWSER_CLICK, BROWSER_NAVIGATE, BROWSER_SCREENSHOT, BROWSER_SNAPSHOT, BROWSER_TAB_CLOSE,
    BROWSER_TAB_OPEN, BROWSER_TAB_SELECT, BROWSER_TABS, BROWSER_TYPE, BROWSER_WAIT,
};

const MAX_SESSION_ID_BYTES: usize = 256;
const MAX_BROWSER_TABS: usize = 8;
const MAX_URL_BYTES: usize = 4_096;
const MAX_TYPE_BYTES: usize = 2_048;
const MAX_BROWSER_WAIT_TEXT_BYTES: usize = 512;
const MAX_BROWSER_WAIT_URL_BYTES: usize = 2_048;
const MAX_BROWSER_WAIT_MS: u64 = 10_000;
const BROWSER_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAX_SNAPSHOT_TEXT_BYTES: usize = 32 * 1024;
const MAX_SNAPSHOT_ELEMENTS: usize = 80;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BROWSER_SCREENSHOT_BYTES: usize = 512 * 1024;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BROWSER_SCREENSHOT_WIDTH: u32 = 1280;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BROWSER_SCREENSHOT_HEIGHT: u32 = 960;
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);
const BROWSER_SCREENSHOT_OUTPUT_PREFIX: &str = "data:image/jpeg;base64,";
const WINDOW_LABEL_PREFIX: &str = "melody-browser-";
const POPUP_WINDOW_LABEL_PREFIX: &str = "melody-browser-popup-";

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn crop_browser_viewport(
    screenshot: &image::RgbaImage,
    capture_origin: (i32, i32),
    inner_origin: (i32, i32),
    bounds: &BrowserBounds,
    scale_factor: f64,
) -> Result<image::RgbaImage, String> {
    let left =
        (i64::from(inner_origin.0) - i64::from(capture_origin.0)) as f64 + bounds.x * scale_factor;
    let top =
        (i64::from(inner_origin.1) - i64::from(capture_origin.1)) as f64 + bounds.y * scale_factor;
    let width = (bounds.width * scale_factor).round();
    let height = (bounds.height * scale_factor).round();
    if ![left, top, width, height, scale_factor]
        .into_iter()
        .all(f64::is_finite)
        || scale_factor <= 0.0
        || left < 0.0
        || top < 0.0
        || width < 1.0
        || height < 1.0
    {
        return Err("The browser viewport is outside the captured window.".to_string());
    }
    let left = left.round() as u32;
    let top = top.round() as u32;
    let width = width as u32;
    let height = height as u32;
    if left.saturating_add(width) > screenshot.width()
        || top.saturating_add(height) > screenshot.height()
    {
        return Err("The browser viewport did not match the captured window bounds.".to_string());
    }
    Ok(image::imageops::crop_imm(screenshot, left, top, width, height).to_image())
}

#[derive(Default)]
struct BrowserTabIndex {
    ids: Vec<String>,
    active_id: Option<String>,
    next_id: u32,
}

impl BrowserTabIndex {
    fn open(&mut self) -> Result<String, String> {
        if self.ids.len() >= MAX_BROWSER_TABS {
            return Err(format!(
                "A browser session can have at most {MAX_BROWSER_TABS} tabs."
            ));
        }
        self.next_id = self.next_id.saturating_add(1);
        let id = format!("tab-{}", self.next_id);
        self.ids.push(id.clone());
        self.active_id = Some(id.clone());
        Ok(id)
    }

    fn select(&mut self, id: &str) -> Result<(), String> {
        if !self.ids.iter().any(|candidate| candidate == id) {
            return Err("Browser tab does not exist.".to_string());
        }
        self.active_id = Some(id.to_string());
        Ok(())
    }

    fn close(&mut self, id: &str) -> Option<String> {
        let index = self.ids.iter().position(|candidate| candidate == id)?;
        let was_active = self.active_id.as_deref() == Some(id);
        self.ids.remove(index);
        if was_active {
            self.active_id = self
                .ids
                .get(index.min(self.ids.len().saturating_sub(1)))
                .cloned();
        }
        self.active_id.clone()
    }

    fn active_id(&self) -> Option<&str> {
        self.active_id.as_deref()
    }

    fn ids(&self) -> &[String] {
        &self.ids
    }
}

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)] // Some profile modes are only constructed on other Tauri targets.
enum BrowserProfileMode {
    PersistentDirectory,
    PersistentStore,
    Ephemeral,
    Unavailable,
}

fn browser_profile_mode() -> BrowserProfileMode {
    #[cfg(target_os = "macos")]
    {
        return if macos_custom_store_available() {
            BrowserProfileMode::PersistentStore
        } else {
            // Before macOS 14 a custom WKWebsiteDataStore is not available.
            // Use an ephemeral store rather than silently sharing the app's
            // default Safari/WebKit identity.
            BrowserProfileMode::Ephemeral
        };
    }
    #[cfg(target_os = "ios")]
    {
        return BrowserProfileMode::Ephemeral;
    }
    #[cfg(target_os = "android")]
    {
        // Wry does not currently implement incognito mode on Android, and a
        // custom data directory is unsupported there, so fail closed.
        return BrowserProfileMode::Unavailable;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        BrowserProfileMode::PersistentDirectory
    }
}

#[cfg(target_os = "macos")]
fn macos_custom_store_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("/usr/bin/sw_vers")
            .args(["-productVersion"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 14)
    })
}

fn webkit_data_store_identifier(session_id: &str) -> [u8; 16] {
    let digest = Sha256::digest(session_id.as_bytes());
    let mut identifier = [0_u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserElement {
    ref_id: String,
    role: String,
    name: String,
    tag: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSnapshot {
    url: String,
    title: String,
    text: String,
    elements: Vec<BrowserElement>,
}

struct BrowserWaitOptions {
    url_contains: Option<String>,
    text_contains: Option<String>,
    timeout: Duration,
}

impl BrowserWaitOptions {
    fn parse(arguments: &Value) -> Result<Self, String> {
        let read_filter = |name: &str, max_bytes: usize| -> Result<Option<String>, String> {
            match arguments.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(value))
                    if !value.trim().is_empty()
                        && value.len() <= max_bytes
                        && !value.chars().any(char::is_control) =>
                {
                    Ok(Some(value.clone()))
                }
                _ => Err(format!(
                    "browser_wait {name} must be non-empty text within {max_bytes} bytes."
                )),
            }
        };
        let url_contains = read_filter("url_contains", MAX_BROWSER_WAIT_URL_BYTES)?;
        let text_contains = read_filter("text_contains", MAX_BROWSER_WAIT_TEXT_BYTES)?;
        if url_contains.is_none() && text_contains.is_none() {
            return Err("browser_wait requires url_contains, text_contains, or both.".to_string());
        }
        let timeout_ms = match arguments.get("timeout_ms") {
            None | Some(Value::Null) => 5_000,
            Some(Value::Number(value)) => value.as_u64().ok_or_else(|| {
                "browser_wait timeout_ms must be an integer from 250 to 10000.".to_string()
            })?,
            _ => {
                return Err(
                    "browser_wait timeout_ms must be an integer from 250 to 10000.".to_string(),
                );
            }
        };
        if !(250..=MAX_BROWSER_WAIT_MS).contains(&timeout_ms) {
            return Err(
                "browser_wait timeout_ms must be an integer from 250 to 10000.".to_string(),
            );
        }
        Ok(Self {
            url_contains,
            text_contains,
            timeout: Duration::from_millis(timeout_ms),
        })
    }

    fn matches(&self, snapshot: &BrowserSnapshot) -> bool {
        self.url_contains
            .as_ref()
            .map_or(true, |needle| snapshot.url.contains(needle))
            && self
                .text_contains
                .as_ref()
                .map_or(true, |needle| snapshot.text.contains(needle))
    }
}

#[derive(Clone)]
struct BrowserRef {
    tag: String,
    role: String,
    name: String,
}

struct BrowserEntry {
    view: Webview,
    snapshot_url: Option<String>,
    refs: HashMap<String, BrowserRef>,
    bounds: Option<BrowserBounds>,
    local_origin: Arc<Mutex<Option<String>>>,
    popup_policy: Arc<AtomicBool>,
}

#[derive(Default)]
struct BrowserSession {
    tabs: BrowserTabIndex,
    entries: HashMap<String, BrowserEntry>,
}

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

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_broadcast()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_documentation()
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !(segments[0] & 0xfe00 == 0xfc00) // unique-local
                && !(segments[0] & 0xffc0 == 0xfe80) // link-local
        }
    }
}

fn validate_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err("Browser URL is invalid or exceeds 4 KB.".to_string());
    }
    let url = Url::parse(raw.trim()).map_err(|error| format!("Browser URL is invalid: {error}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let local_name = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal");
    let private_ip = host
        .parse::<IpAddr>()
        .is_ok_and(|address| !is_public_ip(address));
    if url.scheme() != "https"
        || host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || local_name
        || private_ip
    {
        return Err(
            "Browser only allows public HTTPS URLs without embedded credentials.".to_string(),
        );
    }
    Ok(url)
}

fn validate_local_preview_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err("Local preview URL is invalid or exceeds 4 KB.".to_string());
    }
    let url =
        Url::parse(raw.trim()).map_err(|error| format!("Local preview URL is invalid: {error}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_loopback_name = host == "localhost" || host.ends_with(".localhost");
    let is_loopback_ip = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    if !matches!(url.scheme(), "http" | "https")
        || (!is_loopback_name && !is_loopback_ip)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(
            "Local preview only allows HTTP(S) loopback URLs without credentials.".to_string(),
        );
    }
    Ok(url)
}

fn browser_url_is_allowed_for_snapshot(raw: &str, local_origin: Option<&str>) -> bool {
    if raw == "about:blank" || validate_url(raw).is_ok() {
        return true;
    }
    validate_local_preview_url(raw)
        .is_ok_and(|url| local_origin == Some(url.origin().ascii_serialization().as_str()))
}

fn is_allowed_popup_url(raw: &str) -> bool {
    raw == "about:blank" || validate_url(raw).is_ok()
}

fn profile_directory(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve browser profile directory: {error}"))?;
    let digest = Sha256::digest(session_id.as_bytes());
    let label = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let directory = root.join("browser-profiles").join(label);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create browser profile directory: {error}"))?;
    Ok(directory)
}

fn webview_label(session_id: &str, tab_id: &str) -> String {
    let digest = Sha256::digest(format!("{session_id}\0{tab_id}").as_bytes());
    let suffix = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{WINDOW_LABEL_PREFIX}{suffix}")
}

#[cfg(desktop)]
fn browser_view(
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
    initial_url: &Url,
    local_origin: Arc<Mutex<Option<String>>>,
    popup_policy: Arc<AtomicBool>,
) -> Result<Webview, String> {
    let navigation_origin = Arc::clone(&local_origin);
    let popup_allowed = Arc::clone(&popup_policy);
    let popup_app = app.clone();
    let changed_app = app.clone();
    let changed_session_id = session_id.to_string();
    let changed_tab_id = tab_id.to_string();
    let builder = WebviewBuilder::new(
        webview_label(session_id, tab_id),
        WebviewUrl::External(initial_url.clone()),
    )
    .focused(false)
    .on_navigation(move |url| {
        if url.as_str() == "about:blank" || validate_url(url.as_str()).is_ok() {
            return true;
        }
        let Ok(local_url) = validate_local_preview_url(url.as_str()) else {
            return false;
        };
        navigation_origin
            .lock()
            .ok()
            .and_then(|origin| origin.clone())
            .is_some_and(|origin| origin == local_url.origin().ascii_serialization())
    })
    .on_new_window(move |url, features| {
        if !popup_allowed.load(Ordering::Relaxed) || !is_allowed_popup_url(url.as_str()) {
            return tauri::webview::NewWindowResponse::Deny;
        }
        let blank = Url::parse("about:blank").expect("valid URL");
        let label = format!("{POPUP_WINDOW_LABEL_PREFIX}{}", uuid::Uuid::new_v4());
        let popup = WebviewWindowBuilder::new(&popup_app, label, WebviewUrl::External(blank))
            .window_features(features)
            .title("Melody Browser sign-in")
            .inner_size(520.0, 680.0)
            .on_navigation(|url| {
                url.as_str() == "about:blank" || validate_url(url.as_str()).is_ok()
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_document_title_changed(|window, title| {
                let title: String = title
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(80)
                    .collect();
                let _ = window.set_title(&format!("Melody Browser — {title}"));
            })
            .build();
        let Ok(popup) = popup else {
            return tauri::webview::NewWindowResponse::Deny;
        };
        if url.as_str() != "about:blank" && popup.navigate(url).is_err() {
            let _ = popup.close();
            return tauri::webview::NewWindowResponse::Deny;
        }
        tauri::webview::NewWindowResponse::Create { window: popup }
    })
    .on_page_load(move |_, _| {
        let _ = changed_app.emit_to(
            tauri::EventTarget::webview_window("main"),
            "melody://pi-browser-changed",
            serde_json::json!({
                "sessionId": changed_session_id,
                "tabId": changed_tab_id,
            }),
        );
    });
    let builder = match browser_profile_mode() {
        BrowserProfileMode::PersistentDirectory => {
            builder.data_directory(profile_directory(app, session_id)?)
        }
        BrowserProfileMode::PersistentStore => {
            builder.data_store_identifier(webkit_data_store_identifier(session_id))
        }
        BrowserProfileMode::Ephemeral => builder.incognito(true),
        BrowserProfileMode::Unavailable => {
            return Err("A session-isolated browser is not available on Android.".to_string());
        }
    };
    let main = app
        .get_window("main")
        .ok_or_else(|| "The main window is not available for the embedded browser.".to_string())?;
    let view = main
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("Unable to create embedded browser: {error}"))?;
    view.hide()
        .map_err(|error| format!("Unable to hide embedded browser: {error}"))?;
    Ok(view)
}

#[cfg(not(desktop))]
fn browser_view(
    _app: &AppHandle,
    _session_id: &str,
    _tab_id: &str,
    _initial_url: &Url,
    _local_origin: Arc<Mutex<Option<String>>>,
    _popup_policy: Arc<AtomicBool>,
) -> Result<Webview, String> {
    Err("The embedded browser is only available on desktop platforms.".to_string())
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
    let tab_id = match session.tabs.active_id().map(str::to_string) {
        Some(id) => id,
        None => session.tabs.open()?,
    };
    if !session.entries.contains_key(&tab_id) {
        let blank = Url::parse("about:blank").expect("valid URL");
        let local_origin = Arc::new(Mutex::new(None));
        let popup_policy = Arc::new(AtomicBool::new(false));
        let view = browser_view(
            app,
            session_id,
            &tab_id,
            &blank,
            Arc::clone(&local_origin),
            Arc::clone(&popup_policy),
        )?;
        session.entries.insert(
            tab_id.clone(),
            BrowserEntry {
                view,
                snapshot_url: None,
                refs: HashMap::new(),
                bounds: None,
                local_origin,
                popup_policy,
            },
        );
    }
    let entry = session
        .entries
        .get_mut(&tab_id)
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

async fn evaluate(window: &Webview, script: String) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    window
        .eval_with_callback(script, move |value| {
            if let Ok(mut sender) = callback_sender.lock()
                && let Some(sender) = sender.take()
            {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| format!("Browser page evaluation failed: {error}"))?;
    let serialized = tokio::time::timeout(EVAL_TIMEOUT, receiver)
        .await
        .map_err(|_| "Browser page did not respond within 8 seconds.".to_string())?
        .map_err(|_| "Browser page closed before responding.".to_string())?;
    let first: Value = serde_json::from_str(&serialized)
        .map_err(|error| format!("Unable to decode browser response: {error}"))?;
    match first {
        Value::String(inner) => serde_json::from_str(&inner)
            .map_err(|error| format!("Unable to decode browser response: {error}")),
        value => Ok(value),
    }
}

const SNAPSHOT_SCRIPT: &str = r#"(() => {
  const clean = (value, limit = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const selector = 'a[href],button,input:not([type=password]):not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]';
  const nodes = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 80);
  const elements = nodes.map((node, index) => {
    const refId = `r${index + 1}`;
    node.setAttribute('data-melody-browser-ref', refId);
    const tag = node.tagName.toLowerCase();
    const role = clean(node.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag));
    const label = node.labels ? Array.from(node.labels).map((item) => item.innerText).join(' ') : '';
    const name = clean(node.getAttribute('aria-label') || label || node.getAttribute('title') || node.getAttribute('placeholder') || node.innerText || node.getAttribute('alt'));
    return { refId, role, name, tag };
  });
  return JSON.stringify({ url: location.href, title: clean(document.title, 512), text: clean(document.body?.innerText, 32768), elements });
})()"#;

async fn read_snapshot(
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
    view: &Webview,
) -> Result<BrowserSnapshot, String> {
    let value = evaluate(view, SNAPSHOT_SCRIPT.to_string()).await?;
    let snapshot: BrowserSnapshot = serde_json::from_value(value)
        .map_err(|error| format!("Unable to decode browser snapshot: {error}"))?;
    let local_origin = entries(state)?
        .get(session_id)
        .and_then(|session| session.entries.get(tab_id))
        .and_then(|entry| {
            entry
                .local_origin
                .lock()
                .ok()
                .and_then(|origin| origin.clone())
        });
    if !browser_url_is_allowed_for_snapshot(&snapshot.url, local_origin.as_deref()) {
        return Err("Browser snapshot URL is outside the approved browser origin.".to_string());
    }
    let mut text = snapshot.text;
    if text.len() > MAX_SNAPSHOT_TEXT_BYTES {
        let mut end = MAX_SNAPSHOT_TEXT_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n[page text truncated]");
    }
    let elements: Vec<_> = snapshot
        .elements
        .into_iter()
        .take(MAX_SNAPSHOT_ELEMENTS)
        .collect();
    let refs = elements
        .iter()
        .filter(|element| {
            element.ref_id.len() <= 8
                && element.ref_id.starts_with('r')
                && element.ref_id[1..].chars().all(|ch| ch.is_ascii_digit())
        })
        .map(|element| {
            (
                element.ref_id.clone(),
                BrowserRef {
                    tag: element.tag.clone(),
                    role: element.role.clone(),
                    name: element.name.clone(),
                },
            )
        })
        .collect();
    let snapshot = BrowserSnapshot {
        url: snapshot.url,
        title: snapshot.title,
        text,
        elements,
    };
    let mut sessions = entries(state)?;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| "Browser session was closed while capturing a snapshot.".to_string())?;
    let entry = session
        .entries
        .get_mut(tab_id)
        .ok_or_else(|| "Browser tab was closed while capturing a snapshot.".to_string())?;
    entry.snapshot_url = Some(snapshot.url.clone());
    entry.refs = refs;
    Ok(snapshot)
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
            let tab_id = session.tabs.active_id().ok_or_else(|| {
                "Open the browser and capture a snapshot before clicking.".to_string()
            })?;
            let entry = session.entries.get(tab_id).ok_or_else(|| {
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
    let expected_url = serde_json::to_string(&snapshot_url).map_err(|error| error.to_string())?;
    let selector = serde_json::to_string(&format!("[data-melody-browser-ref=\"{ref_id}\"]"))
        .map_err(|error| error.to_string())?;
    let script = format!(
        "(() => {{ if (location.href !== {expected_url}) return JSON.stringify({{ok:false,error:'page changed'}}); const node = document.querySelector({selector}); if (!node || !node.isConnected) return JSON.stringify({{ok:false,error:'element disappeared'}}); node.click(); return JSON.stringify({{ok:true}}); }})()"
    );
    let result = evaluate(&window, script).await?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Browser page changed or the selected element is no longer available; capture a new snapshot.".to_string());
    }
    Ok(format!(
        "Clicked {} ({}) {} on {}.",
        ref_id, element.role, element.name, snapshot_url
    ))
}

async fn type_into_ref(
    state: &PiBrowserRuntime,
    session_id: &str,
    ref_id: &str,
    text: &str,
) -> Result<String, String> {
    if text.len() > MAX_TYPE_BYTES || text.chars().any(char::is_control) {
        return Err(
            "Browser input exceeds the 2 KB limit or contains control characters.".to_string(),
        );
    }
    let (window, snapshot_url, element) =
        {
            let sessions = entries(state)?;
            let session = sessions.get(session_id).ok_or_else(|| {
                "Open the browser and capture a snapshot before typing.".to_string()
            })?;
            let tab_id = session.tabs.active_id().ok_or_else(|| {
                "Open the browser and capture a snapshot before typing.".to_string()
            })?;
            let entry = session.entries.get(tab_id).ok_or_else(|| {
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
    if element.tag != "input" && element.tag != "textarea" && element.role != "textbox" {
        return Err("browser_type only supports text inputs and textareas.".to_string());
    }
    let expected_url = serde_json::to_string(&snapshot_url).map_err(|error| error.to_string())?;
    let selector = serde_json::to_string(&format!("[data-melody-browser-ref=\"{ref_id}\"]"))
        .map_err(|error| error.to_string())?;
    let input = serde_json::to_string(text).map_err(|error| error.to_string())?;
    let script = format!(
        "(() => {{ if (location.href !== {expected_url}) return JSON.stringify({{ok:false}}); const node = document.querySelector({selector}); if (!node || !node.isConnected || node.disabled || node.readOnly || node.type === 'password' || node.type === 'file') return JSON.stringify({{ok:false}}); const allowedTypes = ['text','search','email','url','tel','number']; if (node.tagName === 'INPUT' && !allowedTypes.includes(node.type || 'text')) return JSON.stringify({{ok:false}}); node.focus(); if (node.isContentEditable) node.textContent = {input}; else node.value = {input}; node.dispatchEvent(new InputEvent('input', {{ bubbles:true, inputType:'insertText', data:{input} }})); node.dispatchEvent(new Event('change', {{ bubbles:true }})); return JSON.stringify({{ok:true}}); }})()"
    );
    let result = evaluate(&window, script).await?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(
            "Browser page changed, or the selected field is read-only, sensitive, or unavailable."
                .to_string(),
        );
    }
    Ok(format!(
        "Typed text into {} ({}) on {}.",
        ref_id, element.name, snapshot_url
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
async fn capture_browser_screenshot(
    app: &AppHandle,
    state: &PiBrowserRuntime,
    session_id: &str,
    tab_id: &str,
    view: &Webview,
) -> Result<BrowserScreenshot, String> {
    #[cfg(target_os = "linux")]
    if env::var_os("WAYLAND_DISPLAY").is_some()
        || env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
    {
        return Err(
            "Browser screenshots are unavailable on Linux Wayland; use an X11 session.".to_string(),
        );
    }

    let (bounds, local_origin) = {
        let sessions = entries(state)?;
        let entry = sessions
            .get(session_id)
            .and_then(|session| session.entries.get(tab_id))
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
    if !bounds.visible {
        return Err("Open the Browser panel before capturing a screenshot.".to_string());
    }
    let url = view
        .url()
        .map_err(|error| format!("Unable to read the Browser URL: {error}"))?;
    if !browser_url_is_allowed_for_snapshot(url.as_str(), local_origin.as_deref()) {
        return Err("Browser screenshot URL is outside the approved browser origin.".to_string());
    }

    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main application window is unavailable.".to_string())?;
    if main_window
        .is_minimized()
        .map_err(|error| format!("Unable to inspect the application window: {error}"))?
    {
        return Err(
            "Restore the MelodyWork window before capturing a browser screenshot.".to_string(),
        );
    }
    let title = main_window
        .title()
        .map_err(|error| format!("Unable to read the application window title: {error}"))?;
    let inner_position = main_window
        .inner_position()
        .map_err(|error| format!("Unable to locate the application window: {error}"))?;
    let scale_factor = main_window
        .scale_factor()
        .map_err(|error| format!("Unable to read the display scale factor: {error}"))?;
    let process_id = std::process::id();
    let bounds_for_capture = bounds.clone();
    let encoded = tokio::task::spawn_blocking(move || {
        let windows = xcap::Window::all()
            .map_err(|error| format!("Unable to enumerate application windows: {error}"))?;
        let native_window = windows
            .into_iter()
            .find(|window| {
                window.pid().ok() == Some(process_id)
                    && window.title().ok().as_deref() == Some(title.as_str())
                    && !window.is_minimized().unwrap_or(true)
            })
            .ok_or_else(|| "The MelodyWork main window could not be captured.".to_string())?;

        let screenshot = native_window
            .capture_image()
            .map_err(|error| format!("Screen capture was denied or failed: {error}"))?;
        let capture_x = native_window
            .x()
            .map_err(|error| format!("Unable to locate the captured window: {error}"))?;
        let capture_y = native_window
            .y()
            .map_err(|error| format!("Unable to locate the captured window: {error}"))?;
        let cropped = crop_browser_viewport(
            &screenshot,
            (capture_x, capture_y),
            (inner_position.x, inner_position.y),
            &bounds_for_capture,
            scale_factor,
        )?;
        let thumbnail = DynamicImage::ImageRgba8(cropped)
            .thumbnail(MAX_BROWSER_SCREENSHOT_WIDTH, MAX_BROWSER_SCREENSHOT_HEIGHT)
            .to_rgb8();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 72)
            .encode_image(&DynamicImage::ImageRgb8(thumbnail))
            .map_err(|error| format!("Unable to encode the browser screenshot: {error}"))?;
        if jpeg.len() > MAX_BROWSER_SCREENSHOT_BYTES {
            return Err("Browser screenshot exceeds the 512 KiB transfer limit.".to_string());
        }
        Ok::<_, String>(BASE64.encode(jpeg))
    })
    .await
    .map_err(|error| format!("Browser screenshot worker failed: {error}"))??;

    Ok(BrowserScreenshot {
        tab_id: tab_id.to_string(),
        url: url.to_string(),
        mime_type: "image/jpeg",
        data: encoded,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn capture_browser_screenshot(
    _app: &AppHandle,
    _state: &PiBrowserRuntime,
    _session_id: &str,
    _tab_id: &str,
    _view: &Webview,
) -> Result<BrowserScreenshot, String> {
    Err("Browser screenshots are available only on desktop platforms.".to_string())
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
        .tabs
        .active_id()
        .ok_or_else(|| "The session browser has no active tab.".to_string())?;
    let view = session
        .entries
        .get(tab_id)
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScreenshot {
    pub tab_id: String,
    pub url: String,
    pub mime_type: &'static str,
    pub data: String,
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
    let active_tab_id = session.tabs.active_id().map(str::to_string);
    let tabs = session
        .tabs
        .ids()
        .iter()
        .map(|id| BrowserTabStatus {
            id: id.clone(),
            url: session
                .entries
                .get(id)
                .and_then(|entry| entry.view.url().ok())
                .map(|url| url.to_string()),
            active: active_tab_id.as_deref() == Some(id.as_str()),
        })
        .collect();
    Ok(BrowserStatus {
        session_id: session_id.to_string(),
        open: !session.tabs.ids().is_empty(),
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
    let tab_id = session.tabs.open()?;
    let local_origin = Arc::new(Mutex::new(None));
    let popup_policy = Arc::new(AtomicBool::new(false));
    let view = match browser_view(
        app,
        session_id,
        &tab_id,
        start_url,
        Arc::clone(&local_origin),
        Arc::clone(&popup_policy),
    ) {
        Ok(view) => view,
        Err(error) => {
            session.tabs.close(&tab_id);
            return Err(error);
        }
    };
    session.entries.insert(
        tab_id.clone(),
        BrowserEntry {
            view,
            snapshot_url: None,
            refs: HashMap::new(),
            bounds: None,
            local_origin,
            popup_policy,
        },
    );
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
    session.tabs.select(tab_id)?;
    let active = session.tabs.active_id().map(str::to_string);
    for (id, entry) in &mut session.entries {
        let visible_bounds = entry.bounds.as_ref().map(|bounds| BrowserBounds {
            visible: active.as_deref() == Some(id.as_str()) && bounds.visible,
            ..bounds.clone()
        });
        if let Some(bounds) = visible_bounds {
            apply_browser_bounds(entry, &bounds)?;
        } else if active.as_deref() != Some(id.as_str()) {
            #[cfg(desktop)]
            entry
                .view
                .hide()
                .map_err(|error| format!("Unable to hide inactive browser tab: {error}"))?;
        }
    }
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
    let view = session
        .entries
        .remove(tab_id)
        .ok_or_else(|| "Browser tab does not exist.".to_string())?
        .view;
    let active_id = session.tabs.close(tab_id);
    close_view(&view)?;
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
    let active = session.tabs.active_id() == Some(tab_id.as_str());
    let entry = session
        .entries
        .get_mut(&tab_id)
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
        .and_then(|session| session.entries.get(&tab_id))
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
            .and_then(|session| session.entries.get_mut(&tab_id))
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
        for entry in session.entries.into_values() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_wait_requires_bounded_url_or_visible_text_filters() {
        assert!(BrowserWaitOptions::parse(&json!({})).is_err());
        assert!(BrowserWaitOptions::parse(&json!({"text_contains":" "})).is_err());
        assert!(BrowserWaitOptions::parse(&json!({"text_contains":"ready\nnow"})).is_err());
        assert!(BrowserWaitOptions::parse(&json!({"text_contains":"x".repeat(513)})).is_err());
        assert!(
            BrowserWaitOptions::parse(&json!({"url_contains":"x","timeout_ms":10_001})).is_err()
        );
        let options = BrowserWaitOptions::parse(&json!({
            "url_contains":"example.com",
            "text_contains":"Ready",
            "timeout_ms":750
        }))
        .unwrap();
        assert_eq!(options.timeout, Duration::from_millis(750));
        assert!(options.matches(&BrowserSnapshot {
            url: "https://example.com/docs".to_string(),
            title: "Docs".to_string(),
            text: "Page is Ready".to_string(),
            elements: Vec::new(),
        }));
        assert!(!options.matches(&BrowserSnapshot {
            url: "https://example.com/docs".to_string(),
            title: "Docs".to_string(),
            text: "Still loading".to_string(),
            elements: Vec::new(),
        }));
        assert!(!options.matches(&BrowserSnapshot {
            url: "https://other.example/docs".to_string(),
            title: "Docs".to_string(),
            text: "Page is Ready".to_string(),
            elements: Vec::new(),
        }));
    }

    #[test]
    fn browser_urls_are_https_and_not_local_or_private() {
        assert!(validate_url("https://example.com/path").is_ok());
        assert!(validate_url("http://example.com").is_err());
        assert!(validate_url("https://localhost").is_err());
        assert!(validate_url("https://127.0.0.1").is_err());
        assert!(validate_url("https://192.168.1.1").is_err());
        assert!(validate_url("https://example.local").is_err());
        assert!(validate_url("https://user:pass@example.com").is_err());
    }

    #[test]
    fn browser_local_preview_only_allows_loopback_http_or_https() {
        assert!(validate_local_preview_url("http://localhost:5173").is_ok());
        assert!(validate_local_preview_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_local_preview_url("http://[::1]:8080").is_ok());
        assert!(validate_local_preview_url("http://192.168.1.2").is_err());
        assert!(validate_local_preview_url("https://example.com").is_err());
        assert!(validate_local_preview_url("file:///etc/passwd").is_err());
        assert!(validate_local_preview_url("http://user:pass@localhost").is_err());
        assert!(browser_url_is_allowed_for_snapshot(
            "http://localhost:5173/ready",
            Some("http://localhost:5173")
        ));
        assert!(!browser_url_is_allowed_for_snapshot(
            "http://localhost:3000/other-service",
            Some("http://localhost:5173")
        ));
    }

    #[test]
    fn browser_login_popups_only_allow_blank_or_public_https_destinations() {
        assert!(is_allowed_popup_url("about:blank"));
        assert!(is_allowed_popup_url("https://accounts.example.com/oauth"));
        assert!(!is_allowed_popup_url("http://accounts.example.com"));
        assert!(!is_allowed_popup_url("https://127.0.0.1"));
        assert!(!is_allowed_popup_url("data:text/html,unsafe"));
    }

    #[test]
    fn browser_profile_labels_do_not_embed_session_ids() {
        let label = webview_label("private-session-name", "tab-1");
        assert!(label.starts_with(WINDOW_LABEL_PREFIX));
        assert!(!label.contains("private-session-name"));
        assert_eq!(
            webkit_data_store_identifier("session-a"),
            webkit_data_store_identifier("session-a")
        );
        assert_ne!(
            webkit_data_store_identifier("session-a"),
            webkit_data_store_identifier("session-b")
        );
    }

    #[test]
    fn browser_tabs_are_bounded_and_closing_active_tab_selects_a_neighbor() {
        let mut tabs = BrowserTabIndex::default();
        let first = tabs.open().expect("first tab");
        let second = tabs.open().expect("second tab");
        assert_eq!(tabs.active_id(), Some(second.as_str()));
        assert!(tabs.select(&first).is_ok());
        assert_eq!(tabs.close(&first), Some(second.clone()));
        assert_eq!(tabs.active_id(), Some(second.as_str()));

        for _ in 1..MAX_BROWSER_TABS {
            tabs.open().expect("tab below limit");
        }
        assert!(tabs.open().is_err());
    }

    #[test]
    fn browser_tab_selection_rejects_unknown_ids_without_changing_active_tab() {
        let mut tabs = BrowserTabIndex::default();
        let first = tabs.open().expect("first tab");
        assert!(tabs.select("tab-999").is_err());
        assert_eq!(tabs.active_id(), Some(first.as_str()));
        assert_eq!(tabs.close("tab-999"), None);
        assert_eq!(tabs.active_id(), Some(first.as_str()));
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn browser_screenshot_crops_only_the_scaled_embedded_viewport() {
        let screenshot =
            image::RgbaImage::from_fn(4, 4, |x, y| image::Rgba([x as u8, y as u8, 0, 255]));
        let bounds = BrowserBounds::new(0.5, 0.5, 1.0, 1.0, true).unwrap();
        let cropped = crop_browser_viewport(&screenshot, (10, 20), (10, 20), &bounds, 2.0).unwrap();
        assert_eq!((cropped.width(), cropped.height()), (2, 2));
        assert_eq!(*cropped.get_pixel(0, 0), image::Rgba([1, 1, 0, 255]));
        assert_eq!(*cropped.get_pixel(1, 1), image::Rgba([2, 2, 0, 255]));
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn browser_screenshot_rejects_out_of_window_or_invalid_scale_bounds() {
        let screenshot = image::RgbaImage::new(4, 4);
        let outside = BrowserBounds::new(2.0, 2.0, 1.0, 1.0, true).unwrap();
        assert!(crop_browser_viewport(&screenshot, (0, 0), (0, 0), &outside, 2.0).is_err());
        let bounds = BrowserBounds::new(0.0, 0.0, 1.0, 1.0, true).unwrap();
        assert!(crop_browser_viewport(&screenshot, (0, 0), (0, 0), &bounds, 0.0).is_err());
        assert!(crop_browser_viewport(&screenshot, (0, 0), (0, 0), &bounds, f64::NAN).is_err());
    }

    #[test]
    fn browser_remote_pages_have_no_tauri_remote_capability() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capability.get("remote").is_none());
    }

    #[test]
    fn browser_view_bounds_reject_non_finite_negative_and_oversized_values() {
        assert!(BrowserBounds::new(0.0, 0.0, 320.0, 240.0, true).is_ok());
        assert!(BrowserBounds::new(0.0, 0.0, f64::NAN, 240.0, true).is_err());
        assert!(BrowserBounds::new(-1.0, 0.0, 320.0, 240.0, true).is_err());
        assert!(BrowserBounds::new(0.0, 0.0, 0.0, 240.0, true).is_err());
        assert!(BrowserBounds::new(0.0, 0.0, 20_001.0, 240.0, true).is_err());
    }

    #[test]
    fn browser_profile_policy_uses_isolation_supported_by_the_platform() {
        #[cfg(target_os = "macos")]
        assert_eq!(
            browser_profile_mode(),
            if macos_custom_store_available() {
                BrowserProfileMode::PersistentStore
            } else {
                BrowserProfileMode::Ephemeral
            }
        );

        #[cfg(target_os = "ios")]
        assert_eq!(browser_profile_mode(), BrowserProfileMode::Ephemeral);

        #[cfg(target_os = "android")]
        assert_eq!(browser_profile_mode(), BrowserProfileMode::Unavailable);

        #[cfg(not(target_os = "macos"))]
        #[cfg(not(target_os = "ios"))]
        #[cfg(not(target_os = "android"))]
        assert_eq!(
            browser_profile_mode(),
            BrowserProfileMode::PersistentDirectory
        );
    }
}
