//! Host-window capture, embedded viewport crop, and bounded JPEG projection.

use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};

use super::BrowserBounds;
use super::browser_policy::browser_url_is_allowed_for_snapshot;

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use image::{DynamicImage, codecs::jpeg::JpegEncoder};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BROWSER_SCREENSHOT_BYTES: usize = 512 * 1024;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BROWSER_SCREENSHOT_WIDTH: u32 = 1280;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const MAX_BROWSER_SCREENSHOT_HEIGHT: u32 = 960;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScreenshot {
    pub tab_id: String,
    pub url: String,
    pub mime_type: &'static str,
    pub data: String,
}

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

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(super) async fn capture_browser_screenshot(
    app: &AppHandle,
    tab_id: &str,
    view: &Webview,
    bounds: BrowserBounds,
    local_origin: Option<String>,
) -> Result<BrowserScreenshot, String> {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
    {
        return Err(
            "Browser screenshots are unavailable on Linux Wayland; use an X11 session.".to_string(),
        );
    }

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
            &bounds,
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
pub(super) async fn capture_browser_screenshot(
    _app: &AppHandle,
    _tab_id: &str,
    _view: &Webview,
    _bounds: BrowserBounds,
    _local_origin: Option<String>,
) -> Result<BrowserScreenshot, String> {
    Err("Browser screenshots are available only on desktop platforms.".to_string())
}
