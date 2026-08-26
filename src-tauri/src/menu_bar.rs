use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

pub const TRAY_ID: &str = "main-tray";

#[derive(Default)]
pub struct MenuBarState {
    enabled: AtomicBool,
}

impl MenuBarState {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn set_menu_bar_visibility(
    app: AppHandle,
    state: State<'_, MenuBarState>,
    visible: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let tray = app
            .tray_by_id(TRAY_ID)
            .ok_or_else(|| "菜单栏图标尚未初始化。".to_string())?;
        tray.set_visible(visible)
            .map_err(|error| format!("更新菜单栏图标失败：{error}"))?;
    }

    #[cfg(not(desktop))]
    let _ = app;

    state.set_enabled(visible);
    Ok(())
}

#[cfg(desktop)]
pub fn initialize(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{MenuBuilder, MenuItemBuilder},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_item = MenuItemBuilder::with_id("show", "显示 MelodyWork").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出 MelodyWork").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &quit_item])
        .build()?;

    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id() {
            id if id == "show" => show_main_window(app),
            id if id == "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // The web app applies the persisted preference immediately after startup.
    // Keep the icon hidden until that value has been received from the frontend.
    tray.set_visible(false)?;
    Ok(())
}

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
