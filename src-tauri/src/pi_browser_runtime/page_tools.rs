//! Bounded page snapshot and reference-based interaction contract for Pi.
//!
//! This module evaluates only fixed host-owned scripts. It projects untrusted
//! page content into a bounded snapshot and only acts on references from that
//! exact URL snapshot.

use std::{collections::HashMap, sync::Arc, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Webview;
use tokio::sync::oneshot;

use super::browser_policy::browser_url_is_allowed_for_snapshot;

const MAX_TYPE_BYTES: usize = 2_048;
const MAX_BROWSER_WAIT_TEXT_BYTES: usize = 512;
const MAX_BROWSER_WAIT_URL_BYTES: usize = 2_048;
const MAX_BROWSER_WAIT_MS: u64 = 10_000;
const MAX_SNAPSHOT_TEXT_BYTES: usize = 32 * 1024;
const MAX_SNAPSHOT_ELEMENTS: usize = 80;
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);

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
    pub(super) url: String,
    title: String,
    text: String,
    elements: Vec<BrowserElement>,
}

#[derive(Clone)]
pub(super) struct BrowserRef {
    tag: String,
    role: String,
    name: String,
}

pub(super) struct PageSnapshotCapture {
    pub(super) snapshot: BrowserSnapshot,
    pub(super) refs: HashMap<String, BrowserRef>,
}

pub(super) struct BrowserWaitOptions {
    url_contains: Option<String>,
    text_contains: Option<String>,
    pub(super) timeout: Duration,
}

impl BrowserWaitOptions {
    pub(super) fn parse(arguments: &Value) -> Result<Self, String> {
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

    pub(super) fn matches(&self, snapshot: &BrowserSnapshot) -> bool {
        self.url_contains
            .as_ref()
            .map_or(true, |needle| snapshot.url.contains(needle))
            && self
                .text_contains
                .as_ref()
                .map_or(true, |needle| snapshot.text.contains(needle))
    }
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

pub(super) async fn capture_snapshot(
    view: &Webview,
    local_origin: Option<&str>,
) -> Result<PageSnapshotCapture, String> {
    let value = evaluate(view, SNAPSHOT_SCRIPT.to_string()).await?;
    let snapshot: BrowserSnapshot = serde_json::from_value(value)
        .map_err(|error| format!("Unable to decode browser snapshot: {error}"))?;
    if !browser_url_is_allowed_for_snapshot(&snapshot.url, local_origin) {
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
    Ok(PageSnapshotCapture {
        snapshot: BrowserSnapshot {
            url: snapshot.url,
            title: snapshot.title,
            text,
            elements,
        },
        refs,
    })
}

pub(super) async fn click_ref(
    window: &Webview,
    snapshot_url: &str,
    ref_id: &str,
    element: &BrowserRef,
) -> Result<String, String> {
    let expected_url = serde_json::to_string(snapshot_url).map_err(|error| error.to_string())?;
    let selector = serde_json::to_string(&format!("[data-melody-browser-ref=\"{ref_id}\"]"))
        .map_err(|error| error.to_string())?;
    let script = format!(
        "(() => {{ if (location.href !== {expected_url}) return JSON.stringify({{ok:false,error:'page changed'}}); const node = document.querySelector({selector}); if (!node || !node.isConnected) return JSON.stringify({{ok:false,error:'element disappeared'}}); node.click(); return JSON.stringify({{ok:true}}); }})()"
    );
    let result = evaluate(window, script).await?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Browser page changed or the selected element is no longer available; capture a new snapshot.".to_string());
    }
    Ok(format!(
        "Clicked {} ({}) {} on {}.",
        ref_id, element.role, element.name, snapshot_url
    ))
}

pub(super) async fn type_into_ref(
    window: &Webview,
    snapshot_url: &str,
    ref_id: &str,
    element: &BrowserRef,
    text: &str,
) -> Result<String, String> {
    if text.len() > MAX_TYPE_BYTES || text.chars().any(char::is_control) {
        return Err(
            "Browser input exceeds the 2 KB limit or contains control characters.".to_string(),
        );
    }
    if element.tag != "input" && element.tag != "textarea" && element.role != "textbox" {
        return Err("browser_type only supports text inputs and textareas.".to_string());
    }
    let expected_url = serde_json::to_string(snapshot_url).map_err(|error| error.to_string())?;
    let selector = serde_json::to_string(&format!("[data-melody-browser-ref=\"{ref_id}\"]"))
        .map_err(|error| error.to_string())?;
    let input = serde_json::to_string(text).map_err(|error| error.to_string())?;
    let script = format!(
        "(() => {{ if (location.href !== {expected_url}) return JSON.stringify({{ok:false}}); const node = document.querySelector({selector}); if (!node || !node.isConnected || node.disabled || node.readOnly || node.type === 'password' || node.type === 'file') return JSON.stringify({{ok:false}}); const allowedTypes = ['text','search','email','url','tel','number']; if (node.tagName === 'INPUT' && !allowedTypes.includes(node.type || 'text')) return JSON.stringify({{ok:false}}); node.focus(); if (node.isContentEditable) node.textContent = {input}; else node.value = {input}; node.dispatchEvent(new InputEvent('input', {{ bubbles:true, inputType:'insertText', data:{input} }})); node.dispatchEvent(new Event('change', {{ bubbles:true }})); return JSON.stringify({{ok:true}}); }})()"
    );
    let result = evaluate(window, script).await?;
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
