//! Creates session-isolated embedded browser views and their constrained login popups.
//!
//! This platform adapter owns WebView/profile construction and navigation callbacks. The parent
//! runtime retains tab/session state and Host command routing; URL trust decisions stay in the
//! adjacent browser policy module.

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use reqwest::Url;
use sha2::{Digest, Sha256};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

use super::browser_policy::{is_allowed_popup_url, validate_local_preview_url, validate_url};

const WINDOW_LABEL_PREFIX: &str = "melody-browser-";
const POPUP_WINDOW_LABEL_PREFIX: &str = "melody-browser-popup-";

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
pub(super) fn create_browser_view(
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
pub(super) fn create_browser_view(
    _app: &AppHandle,
    _session_id: &str,
    _tab_id: &str,
    _initial_url: &Url,
    _local_origin: Arc<Mutex<Option<String>>>,
    _popup_policy: Arc<AtomicBool>,
) -> Result<Webview, String> {
    Err("The embedded browser is only available on desktop platforms.".to_string())
}
