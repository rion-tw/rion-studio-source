use rion_core::{AppCore, CoreCommand, RuntimeWindowPreferencesRecord};
#[cfg(target_os = "macos")]
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const TOOLBAR_ITEM: &str = "rion-always-show-fullscreen-toolbar";
const QUIT_ITEM: &str = "rion-application-quit";
const NEW_GAME_WINDOW_ITEM: &str = "rion-new-game-window";
const SHOW_GAME_WINDOW_PREFIX: &str = "rion-show-game-window:";
const TOGGLE_FULLSCREEN_ITEM: &str = "rion-toggle-fullscreen";
const ZOOM_RESET_ITEM: &str = "rion-browser-reset-zoom";
const ZOOM_IN_ITEM: &str = "rion-browser-zoom-in";
const ZOOM_OUT_ITEM: &str = "rion-browser-zoom-out";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApplicationShortcutCommand {
    NewGameWindow,
    QuitApplication,
    ToggleFullscreen,
    ZoomReset,
    ZoomIn,
    ZoomOut,
}

impl ApplicationShortcutCommand {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "newGameWindow" => Some(Self::NewGameWindow),
            "quitApplication" => Some(Self::QuitApplication),
            "toggleFullscreen" => Some(Self::ToggleFullscreen),
            "zoomReset" => Some(Self::ZoomReset),
            "zoomIn" => Some(Self::ZoomIn),
            "zoomOut" => Some(Self::ZoomOut),
            _ => None,
        }
    }

    fn zoom_action(self) -> Option<&'static str> {
        match self {
            Self::ZoomReset => Some("reset"),
            Self::ZoomIn => Some("in"),
            Self::ZoomOut => Some("out"),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ApplicationShortcutTarget<'a> {
    Focused,
    MainWindow(&'a WebviewWindow),
    #[cfg(windows)]
    RoleWebview(&'a str),
    RuntimeWindow(&'a str),
}

#[derive(Clone, Copy)]
#[cfg(target_os = "macos")]
struct Labels {
    app: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    quit: &'static str,
    new_game_window: &'static str,
    toolbar: &'static str,
    fullscreen: &'static str,
    zoom_reset: &'static str,
    zoom_in: &'static str,
    zoom_out: &'static str,
}

#[cfg(target_os = "macos")]
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
        .accelerator("Ctrl+Cmd+F")
        .build(app)
        .map_err(|error| error.to_string())?;
    let new_game_window = MenuItemBuilder::with_id(NEW_GAME_WINDOW_ITEM, labels.new_game_window)
        .accelerator("CmdOrCtrl+N")
        .build(app)
        .map_err(|error| error.to_string())?;
    let quit = MenuItemBuilder::with_id(QUIT_ITEM, labels.quit)
        .accelerator("CmdOrCtrl+Q")
        .build(app)
        .map_err(|error| error.to_string())?;

    let app_menu = SubmenuBuilder::new(app, labels.app)
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit);
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
    let mut window_menu = SubmenuBuilder::new(app, labels.window)
        .item(&new_game_window)
        .separator()
        .minimize()
        .maximize()
        .close_window()
        .separator()
        .bring_all_to_front();
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

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle, _core: &AppCore, _language: &str) -> Result<(), String> {
    Ok(())
}

pub fn handle_event(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<crate::CoreState>() else {
        return;
    };
    let result = match id {
        TOOLBAR_ITEM => toggle_toolbar_preference(app, &state),
        QUIT_ITEM => {
            crate::request_application_shutdown(app, &state);
            Ok(())
        }
        NEW_GAME_WINDOW_ITEM => execute_shortcut(
            app,
            &state,
            ApplicationShortcutCommand::NewGameWindow,
            ApplicationShortcutTarget::Focused,
        ),
        TOGGLE_FULLSCREEN_ITEM => execute_shortcut(
            app,
            &state,
            ApplicationShortcutCommand::ToggleFullscreen,
            ApplicationShortcutTarget::Focused,
        ),
        ZOOM_RESET_ITEM => execute_shortcut(
            app,
            &state,
            ApplicationShortcutCommand::ZoomReset,
            ApplicationShortcutTarget::Focused,
        ),
        ZOOM_IN_ITEM => execute_shortcut(
            app,
            &state,
            ApplicationShortcutCommand::ZoomIn,
            ApplicationShortcutTarget::Focused,
        ),
        ZOOM_OUT_ITEM => execute_shortcut(
            app,
            &state,
            ApplicationShortcutCommand::ZoomOut,
            ApplicationShortcutTarget::Focused,
        ),
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

pub(crate) fn execute_shortcut(
    app: &AppHandle,
    state: &crate::CoreState,
    command: ApplicationShortcutCommand,
    target: ApplicationShortcutTarget<'_>,
) -> Result<(), String> {
    match command {
        ApplicationShortcutCommand::NewGameWindow => create_game_window(app, state),
        ApplicationShortcutCommand::QuitApplication => {
            crate::request_application_shutdown(app, state);
            Ok(())
        }
        ApplicationShortcutCommand::ToggleFullscreen => toggle_fullscreen(app, state, target),
        command => zoom(app, state, command.zoom_action().unwrap_or("reset"), target),
    }
}

fn create_game_window(app: &AppHandle, state: &crate::CoreState) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let target =
        crate::new_game_window_launch_target(state, &main).map_err(|error| error.message)?;
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
    state.runtime.refresh_projection_metadata()?;
    state.runtime.publish_projection();
    let language = state
        .menu_language
        .lock()
        .map_err(|_| "application menu language lock poisoned".to_owned())?
        .clone();
    install(app, &state.core, &language)
}

fn toggle_fullscreen(
    _app: &AppHandle,
    state: &crate::CoreState,
    target: ApplicationShortcutTarget<'_>,
) -> Result<(), String> {
    match target {
        ApplicationShortcutTarget::Focused => {
            if state
                .runtime
                .request_focused_runtime_fullscreen()?
                .is_some()
            {
                return Ok(());
            }
            state
                .runtime
                .request_main_window_toggle_fullscreen("native-menu")
                .map(|_| ())
                .map_err(|error| error.message)
        }
        ApplicationShortcutTarget::MainWindow(_) => state
            .runtime
            .request_main_window_toggle_fullscreen("renderer-shortcut")
            .map(|_| ())
            .map_err(|error| error.message),
        #[cfg(windows)]
        ApplicationShortcutTarget::RoleWebview(webview_label) => {
            let window_id = state
                .runtime
                .window_id_for_webview(webview_label)
                .ok_or_else(|| "runtime WebView is not associated with a window".to_owned())?;
            state
                .runtime
                .toggle_runtime_window_fullscreen(&window_id)
                .and_then(crate::runtime_operation_receipt_result)
        }
        ApplicationShortcutTarget::RuntimeWindow(window_id) => state
            .runtime
            .toggle_runtime_window_fullscreen(window_id)
            .and_then(crate::runtime_operation_receipt_result),
    }
}

fn zoom(
    app: &AppHandle,
    state: &crate::CoreState,
    action: &str,
    target: ApplicationShortcutTarget<'_>,
) -> Result<(), String> {
    match target {
        ApplicationShortcutTarget::Focused => {
            if state.runtime.zoom_focused_runtime(action)? {
                return Ok(());
            }
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window is unavailable".to_owned())?;
            zoom_main_window(state, &window, action)
        }
        ApplicationShortcutTarget::MainWindow(window) => zoom_main_window(state, window, action),
        #[cfg(windows)]
        ApplicationShortcutTarget::RoleWebview(webview_label) => state
            .runtime
            .zoom_role_for_webview(webview_label, action)
            .map(|_| ()),
        ApplicationShortcutTarget::RuntimeWindow(window_id) => {
            zoom_runtime_window(state, window_id, action)
        }
    }
}

fn zoom_runtime_window(
    state: &crate::CoreState,
    window_id: &str,
    action: &str,
) -> Result<(), String> {
    if state.runtime.zoom_runtime_window(window_id, action)? {
        Ok(())
    } else {
        Err("Runtime window was not found.".to_owned())
    }
}

fn zoom_main_window(
    state: &crate::CoreState,
    window: &WebviewWindow,
    action: &str,
) -> Result<(), String> {
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

#[cfg(target_os = "macos")]
fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            app: "Rion Studio",
            edit: "編輯",
            view: "顯示",
            window: "視窗",
            quit: "結束 Rion Studio",
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
            quit: "退出 Rion Studio",
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
            quit: "Rion Studioを終了",
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
            quit: "Quit Rion Studio",
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

    #[cfg(target_os = "macos")]
    #[test]
    fn localizes_all_supported_languages() {
        assert_eq!(labels("en").app, "Rion Studio");
        assert_eq!(labels("en").toolbar, "Always Show Toolbar in Full Screen");
        assert_eq!(labels("en").quit, "Quit Rion Studio");
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

    #[test]
    fn parses_only_supported_application_shortcuts() {
        assert_eq!(
            ApplicationShortcutCommand::parse("newGameWindow"),
            Some(ApplicationShortcutCommand::NewGameWindow)
        );
        assert_eq!(
            ApplicationShortcutCommand::parse("zoomIn"),
            Some(ApplicationShortcutCommand::ZoomIn)
        );
        assert_eq!(
            ApplicationShortcutCommand::parse("quitApplication"),
            Some(ApplicationShortcutCommand::QuitApplication)
        );
        assert_eq!(ApplicationShortcutCommand::parse("quit"), None);
    }
}
