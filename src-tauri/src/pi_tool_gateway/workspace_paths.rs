use std::path::Path;

use serde_json::Value;

/// Validate a workspace-relative path before any filesystem resolution.
///
/// This is deliberately lexical: callers still have to canonicalize the
/// resolved path and enforce the Host-authorized root before accessing it.
pub(super) fn relative_path(value: Option<&Value>, field: &str) -> Result<String, String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be a string"))?;
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("{field} must stay inside the workspace"));
    }
    Ok(value.to_string())
}
