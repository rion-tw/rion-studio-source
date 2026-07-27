use rion_core::{AppCore, CoreCommand, RuntimeWindowPreferencesRecord};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
};

const TOOLBAR_ITEM: &str = "rion-always-show-fullscreen-toolbar";
const NEW_GAME_WINDOW_ITEM: &str = "rion-new-game-window";
const SHOW_GAME_WINDOW_PREFIX: &str = "rion-show-game-window:";
const TOGGLE_FULLSCREEN_ITEM: &str = "rion-toggle-fullscreen";
const ZOOM_RESET_ITEM: &str = "rion-browser-reset-zoom";
const ZOOM_IN_ITEM: &str = "rion-browser-zoom-in";
const ZOOM_OUT_ITEM: &str = "rion-browser-zoom-out";

#[derive(Clone, Copy)]
struct Labels {
    app: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    new_game_window: &'static str,
    toolbar: &'static str,
    fullscreen: &'static str,
    zoom_reset: &'static str,
    zoom_in: &'static str,
    zoom_out: &'static str,
}

pub fn install(app: &AppHandle, core: &AppCore, language: &str) -> Result<(), String> {
    let labels = labels(language);
    let preferences = preferences(core)?;
    let toolbar = CheckMenuItemBuilder::with_id(TOOLBAR_ITEM, labels.toolbar)
        .checked(preferences.always_show_toolbar_in_full_screen)
        .build(app)
        .map_err(|error| error.to_string())?;
    let reset_zoom = MenuItemBuilder::with_id(ZOOM_RESET_ITEM, labels.zoom_reset)
        .accelerator("CmdOrCtrl+0")
        .build(app)
        .map_err(|error| error.to_string())?;
    let zoom_in = MenuItemBuilder::with_id(ZOOM_IN_ITEM, labels.zoom_in)
        .accelerator("CmdOrCtrl+=")
        .build(app)
        .map_err(|error| error.to_string())?;
    let zoom_out = MenuItemBuilder::with_id(ZOOM_OUT_ITEM, labels.zoom_out)
        .accelerator("CmdOrCtrl+-")
        .build(app)
        .map_err(|error| error.to_string())?;
    let toggle_fullscreen = MenuItemBuilder::with_id(TOGGLE_FULLSCREEN_ITEM, labels.fullscreen)
        .accelerator(if cfg!(target_os = "macos") {
            "Ctrl+Cmd+F"
        } else {
            "F11"
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    let new_game_window = MenuItemBuilder::with_id(NEW_GAME_WINDOW_ITEM, labels.new_game_window)
        .accelerator("CmdOrCtrl+N")
        .build(app)
        .map_err(|error| error.to_string())?;

    let mut app_menu = SubmenuBuilder::new(app, labels.app).about(None).separator();
    #[cfg(target_os = "macos")]
    {
        app_menu = app_menu
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator();
    }
    app_menu = app_menu.quit();
    let app_menu = app_menu.build().map_err(|error| error.to_string())?;
    let edit_menu = SubmenuBuilder::new(app, labels.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
        .map_err(|error| error.to_string())?;
    let view_menu = SubmenuBuilder::new(app, labels.view)
        .item(&toolbar)
        .separator()
        .item(&reset_zoom)
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .item(&toggle_fullscreen)
        .build()
        .map_err(|error| error.to_string())?;
    let window_menu = SubmenuBuilder::new(app, labels.window)
        .item(&new_game_window)
        .separator()
        .minimize()
        .maximize()
        .close_window();
    #[cfg(target_os = "macos")]
    let mut window_menu = window_menu;
    #[cfg(target_os = "macos")]
    {
        window_menu = window_menu.separator().bring_all_to_front();
        let game_windows = core
            .invoke(CoreCommand::GameWindowsList)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        if !game_windows.is_empty() {
            window_menu = window_menu.separator();
            for game_window in game_windows {
                if let (Some(id), Some(name)) =
                    (game_window["id"].as_str(), game_window["name"].as_str())
                {
                    window_menu = window_menu.text(format!("{SHOW_GAME_WINDOW_PREFIX}{id}"), name);
                }
            }
        }
    }
    let window_menu = window_menu.build().map_err(|error| error.to_string())?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
        .map_err(|error| error.to_string())?;
    app.set_menu(menu)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn handle_event(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<crate::CoreState>() else {
        return;
    };
    let result = match id {
        TOOLBAR_ITEM => toggle_toolbar_preference(app, &state),
        NEW_GAME_WINDOW_ITEM => create_game_window(app, &state),
        TOGGLE_FULLSCREEN_ITEM => toggle_fullscreen(app, &state),
        ZOOM_RESET_ITEM => zoom(app, &state, "reset"),
        ZOOM_IN_ITEM => zoom(app, &state, "in"),
        ZOOM_OUT_ITEM => zoom(app, &state, "out"),
        _ if id.starts_with(SHOW_GAME_WINDOW_PREFIX) => {
            show_game_window(&state, id.trim_start_matches(SHOW_GAME_WINDOW_PREFIX));
            Ok(())
        }
        _ if crate::runtime_tab_menu::handle_event(app, id) => Ok(()),
        _ => Ok(()),
    };
    if let Err(message) = result {
        let _ = app.emit(
            "rion://shell-error",
            serde_json::json!({ "code": "TAURI_APPLICATION_MENU_FAILED", "message": message }),
        );
    }
}

fn create_game_window(app: &AppHandle, state: &crate::CoreState) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let target =
        crate::new_game_window_launch_target(app, state, &main).map_err(|error| error.message)?;
    let core = std::sync::Arc::clone(&state.core);
    tauri::async_runtime::spawn(async move {
        let window_id = target.window_id.clone();
        let _ = core
            .invoke_async(CoreCommand::EmbeddedWindowRegister { target })
            .await;
        let _ = core
            .invoke_async(CoreCommand::EmbeddedWindowsShow {
                window_id: Some(window_id),
            })
            .await;
    });
    Ok(())
}

fn show_game_window(state: &crate::CoreState, window_id: &str) {
    if window_id.is_empty() {
        return;
    }
    let core = std::sync::Arc::clone(&state.core);
    let window_id = window_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::EmbeddedWindowsShow {
                window_id: Some(window_id),
            })
            .await;
    });
}

fn toggle_toolbar_preference(app: &AppHandle, state: &crate::CoreState) -> Result<(), String> {
    let mut value = preferences(&state.core)?;
    value.always_show_toolbar_in_full_screen = !value.always_show_toolbar_in_full_screen;
    state
        .core
        .invoke(CoreCommand::RuntimeWindowPreferencesReplace { preferences: value })
        .map_err(|error| error.to_string())?;
    state.runtime.publish_projection();
    let language = state
        .menu_language
        .lock()
        .map_err(|_| "application menu language lock poisoned".to_owned())?
        .clone();
    install(app, &state.core, &language)
}

fn toggle_fullscreen(app: &AppHandle, state: &crate::CoreState) -> Result<(), String> {
    if state.runtime.toggle_focused_runtime_fullscreen()? {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(!fullscreen)
        .map_err(|error| error.to_string())
}

fn zoom(app: &AppHandle, state: &crate::CoreState, action: &str) -> Result<(), String> {
    if state.runtime.zoom_focused_runtime(action)? {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let mut zoom = state
        .main_window_zoom
        .lock()
        .map_err(|_| "main window zoom lock poisoned".to_owned())?;
    *zoom = next_zoom(*zoom, action);
    window.set_zoom(*zoom).map_err(|error| error.to_string())
}

fn preferences(core: &AppCore) -> Result<RuntimeWindowPreferencesRecord, String> {
    core.invoke(CoreCommand::RuntimeWindowPreferencesGet)
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}

fn next_zoom(value: f64, action: &str) -> f64 {
    match action {
        "in" => (value + 0.1).min(5.0),
        "out" => (value - 0.1).max(0.25),
        _ => 1.0,
    }
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            app: "Rion Studio",
            edit: "編輯",
            view: "顯示",
            window: "視窗",
            new_game_window: "新增遊戲視窗",
            toolbar: "全螢幕時一律顯示工具列",
            fullscreen: "切換全螢幕",
            zoom_reset: "實際大小",
            zoom_in: "放大",
            zoom_out: "縮小",
        },
        "zh-CN" => Labels {
            app: "Rion Studio",
            edit: "编辑",
            view: "视图",
            window: "窗口",
            new_game_window: "新建游戏窗口",
            toolbar: "全屏时始终显示工具栏",
            fullscreen: "切换全屏",
            zoom_reset: "实际大小",
            zoom_in: "放大",
            zoom_out: "缩小",
        },
        "ja" => Labels {
            app: "Rion Studio",
            edit: "編集",
            view: "表示",
            window: "ウインドウ",
            new_game_window: "新規ゲームウィンドウ",
            toolbar: "フルスクリーンでツールバーを常に表示",
            fullscreen: "フルスクリーンを切り替える",
            zoom_reset: "実際のサイズ",
            zoom_in: "拡大",
            zoom_out: "縮小",
        },
        _ => Labels {
            app: "Rion Studio",
            edit: "Edit",
            view: "View",
            window: "Window",
            new_game_window: "New Game Window",
            toolbar: "Always Show Toolbar in Full Screen",
            fullscreen: "Toggle Full Screen",
            zoom_reset: "Actual Size",
            zoom_in: "Zoom In",
            zoom_out: "Zoom Out",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localizes_all_supported_languages() {
        assert_eq!(labels("en").app, "Rion Studio");
        assert_eq!(labels("en").toolbar, "Always Show Toolbar in Full Screen");
        assert_eq!(labels("zh-TW").view, "顯示");
        assert_eq!(labels("zh-CN").window, "窗口");
        assert_eq!(labels("ja").fullscreen, "フルスクリーンを切り替える");
    }

    #[test]
    fn zoom_is_bounded_and_resettable() {
        assert_eq!(next_zoom(4.95, "in"), 5.0);
        assert_eq!(next_zoom(0.3, "out"), 0.25);
        assert_eq!(next_zoom(2.0, "reset"), 1.0);
    }
}
