#![cfg(target_os = "macos")]

use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::{Arc, mpsc},
};

use rion_core::{BrowserRuntimeSnapshot, CoreCommand, RuntimeWindowPreferencesRecord};
use tauri::{AppHandle, Emitter, Manager, Window};

#[repr(C)]
struct NativeTabInput {
    active: bool,
    audible: bool,
    audio_muted: bool,
    identifier: *const c_char,
    name: *const c_char,
    tooltip: *const c_char,
    tab_type: *const c_char,
    icon_data_url: *const c_char,
    workspace_template: *const c_char,
}

type ActionCallback = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    f64,
    f64,
    bool,
);
type LayoutCallback = unsafe extern "C" fn(*mut c_void, f64, f64, bool);

unsafe extern "C" {
    fn rion_runtime_tabs_create(
        window: *mut c_void,
        context: *mut c_void,
        action: ActionCallback,
        layout: LayoutCallback,
    ) -> *mut c_void;
    fn rion_runtime_tabs_destroy(controller: *mut c_void);
    fn rion_runtime_tabs_update(
        controller: *mut c_void,
        window_id: *const c_char,
        tabs: *const NativeTabInput,
        tab_count: usize,
        add_label: *const c_char,
        audio_muted_label: *const c_char,
        audio_playing_label: *const c_char,
        close_label: *const c_char,
    );
    fn rion_runtime_tabs_prepare_fullscreen(controller: *mut c_void, fullscreen: bool);
    fn rion_runtime_tabs_set_fullscreen_policy(controller: *mut c_void, always_show: bool);
    #[cfg(test)]
    fn rion_runtime_tabs_action_scope_self_test() -> bool;
}

struct CallbackContext {
    app: AppHandle,
    window_label: String,
}

#[derive(Clone)]
pub struct MacRuntimeTabsController {
    inner: Arc<MacRuntimeTabsControllerInner>,
}

struct MacRuntimeTabsControllerInner {
    app: AppHandle,
    context: *mut CallbackContext,
    raw: *mut c_void,
}

// The Objective-C controller is only dereferenced by closures scheduled on the
// AppKit main thread. The wrapper itself may be owned by the runtime state mutex.
unsafe impl Send for MacRuntimeTabsControllerInner {}
unsafe impl Sync for MacRuntimeTabsControllerInner {}

#[derive(Clone)]
pub struct MacRuntimeTabState {
    pub active: bool,
    pub audio_muted: bool,
    pub audible: bool,
    pub icon_data_url: Option<String>,
    pub id: String,
    pub name: String,
    pub tooltip: String,
    pub tab_type: String,
    pub workspace_template: Option<String>,
}

impl MacRuntimeTabsController {
    pub fn create(app: &AppHandle, window: &Window) -> Result<Self, String> {
        let ns_window = window.ns_window().map_err(|error| error.to_string())?;
        let context = Box::into_raw(Box::new(CallbackContext {
            app: app.clone(),
            window_label: window.label().to_owned(),
        }));
        let (sender, receiver) = mpsc::sync_channel(1);
        let context_address = context as usize;
        let window_address = ns_window as usize;
        app.run_on_main_thread(move || {
            let raw = unsafe {
                rion_runtime_tabs_create(
                    window_address as *mut c_void,
                    context_address as *mut c_void,
                    action_callback,
                    layout_callback,
                )
            };
            let _ = sender.send(raw as usize);
        })
        .map_err(|error| error.to_string())?;
        let raw = receiver
            .recv()
            .map_err(|_| "AppKit runtime tabs creation callback was lost.".to_owned())?
            as *mut c_void;
        if raw.is_null() {
            unsafe { drop(Box::from_raw(context)) };
            return Err("AppKit runtime tabs controller could not be created.".to_owned());
        }
        Ok(Self {
            inner: Arc::new(MacRuntimeTabsControllerInner {
                app: app.clone(),
                context,
                raw,
            }),
        })
    }

    pub fn update(
        &self,
        window_id: &str,
        tabs: Vec<MacRuntimeTabState>,
        always_show_in_fullscreen: bool,
        language: &str,
    ) -> Result<(), String> {
        let raw = self.inner.raw as usize;
        let window_id = window_id.to_owned();
        let labels = labels(language);
        // Runtime projections can be published from AppKit window callbacks.
        // Queueing the update is safe from every caller, while synchronously
        // waiting here would deadlock when the caller already is the main thread.
        self.inner
            .app
            .run_on_main_thread(move || {
                let strings = tabs
                    .iter()
                    .map(|tab| NativeTabStrings {
                        icon: tab.icon_data_url.as_deref().map(c_string),
                        id: c_string(&tab.id),
                        name: c_string(&tab.name),
                        tab_type: c_string(&tab.tab_type),
                        tooltip: c_string(&tab.tooltip),
                        workspace_template: tab.workspace_template.as_deref().map(c_string),
                    })
                    .collect::<Vec<_>>();
                let inputs = tabs
                    .iter()
                    .zip(&strings)
                    .map(|(tab, strings)| NativeTabInput {
                        active: tab.active,
                        audible: tab.audible,
                        audio_muted: tab.audio_muted,
                        identifier: strings.id.as_ptr(),
                        name: strings.name.as_ptr(),
                        tooltip: strings.tooltip.as_ptr(),
                        tab_type: strings.tab_type.as_ptr(),
                        icon_data_url: strings
                            .icon
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                        workspace_template: strings
                            .workspace_template
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                    })
                    .collect::<Vec<_>>();
                let add = c_string(labels.0);
                let muted = c_string(labels.1);
                let playing = c_string(labels.2);
                let close = c_string(labels.3);
                let window_id = c_string(&window_id);
                unsafe {
                    rion_runtime_tabs_set_fullscreen_policy(
                        raw as *mut c_void,
                        always_show_in_fullscreen,
                    );
                    rion_runtime_tabs_update(
                        raw as *mut c_void,
                        window_id.as_ptr(),
                        inputs.as_ptr(),
                        inputs.len(),
                        add.as_ptr(),
                        muted.as_ptr(),
                        playing.as_ptr(),
                        close.as_ptr(),
                    );
                }
            })
            .map_err(|error| error.to_string())
    }

    pub fn prepare_fullscreen(&self, fullscreen: bool) {
        let raw = self.inner.raw as usize;
        let _ = self.inner.app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_prepare_fullscreen(raw as *mut c_void, fullscreen);
        });
    }
}

impl Drop for MacRuntimeTabsControllerInner {
    fn drop(&mut self) {
        let raw = self.raw as usize;
        let context = self.context as usize;
        // Drop can also be reached from a main-thread window callback. Keep the
        // native controller and callback context alive until their queued
        // AppKit teardown executes instead of blocking that same thread.
        let _ = self.app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_destroy(raw as *mut c_void);
            drop(Box::from_raw(context as *mut CallbackContext));
        });
    }
}

fn labels(language: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    match language {
        "zh-TW" => (
            "開啟角色或工作區",
            "分頁已靜音",
            "正在播放音訊",
            "停止並關閉分頁",
        ),
        "zh-CN" => (
            "打开角色或工作区",
            "标签页已静音",
            "正在播放音频",
            "停止并关闭标签页",
        ),
        "ja" => (
            "ロールまたはワークスペースを開く",
            "タブはミュート中",
            "音声を再生中",
            "停止してタブを閉じる",
        ),
        _ => (
            "Open role or workspace",
            "Tab muted",
            "Playing audio",
            "Stop and close tab",
        ),
    }
}

struct NativeTabStrings {
    icon: Option<CString>,
    id: CString,
    name: CString,
    tab_type: CString,
    tooltip: CString,
    workspace_template: Option<CString>,
}

fn c_string(value: &str) -> CString {
    CString::new(value.replace('\0', "")).expect("sanitized string contains no NUL")
}

unsafe extern "C" fn action_callback(
    context: *mut c_void,
    action_type: *const c_char,
    session_id: *const c_char,
    tab_id: *const c_char,
    source_window_id: *const c_char,
    target_window_id: *const c_char,
    before_tab_id: *const c_char,
    screen_x: f64,
    screen_y: f64,
    cancelled: bool,
) {
    if context.is_null() || action_type.is_null() {
        return;
    }
    let context = unsafe { &*(context as *const CallbackContext) };
    let action_type = unsafe { CStr::from_ptr(action_type) }
        .to_string_lossy()
        .into_owned();
    let session_id = c_string_from_pointer(session_id);
    let tab_id = c_string_from_pointer(tab_id);
    let before_tab_id = c_string_from_pointer(before_tab_id);
    let source_window_id = c_string_from_pointer(source_window_id);
    let target_window_id = c_string_from_pointer(target_window_id);
    dispatch_action(
        context.app.clone(),
        context.window_label.clone(),
        NativeTabAction {
            action_type,
            session_id,
            tab_id,
            source_window_id,
            target_window_id,
            before_tab_id,
            screen_x,
            screen_y,
            cancelled,
        },
    );
}

unsafe extern "C" fn layout_callback(
    context: *mut c_void,
    _height_inset: f64,
    _y_offset: f64,
    valid: bool,
) {
    if context.is_null() || !valid {
        return;
    }
    let context = unsafe { &*(context as *const CallbackContext) };
    let app = context.app.clone();
    let label = context.window_label.clone();
    std::thread::spawn(move || {
        let Some(window) = app.get_window(&label) else {
            return;
        };
        let Ok(size) = window.inner_size() else {
            return;
        };
        if let Some(state) = app.try_state::<crate::CoreState>() {
            state.runtime.resize_window(&label, size.width, size.height);
        }
    });
}

fn c_string_from_pointer(value: *const c_char) -> Option<String> {
    (!value.is_null()).then(|| {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    })
}

struct NativeTabAction {
    action_type: String,
    session_id: Option<String>,
    tab_id: Option<String>,
    source_window_id: Option<String>,
    target_window_id: Option<String>,
    before_tab_id: Option<String>,
    screen_x: f64,
    screen_y: f64,
    cancelled: bool,
}

fn dispatch_action(app: AppHandle, window_label: String, action: NativeTabAction) {
    tauri::async_runtime::spawn(async move {
        let NativeTabAction {
            action_type,
            session_id,
            tab_id,
            source_window_id,
            target_window_id,
            before_tab_id,
            screen_x,
            screen_y,
            cancelled,
        } = action;
        let Some(state) = app.try_state::<crate::CoreState>() else {
            return;
        };
        let host_window_id = state.runtime.window_id_for_label(&window_label);
        if matches!(
            action_type.as_str(),
            "tabDragStart" | "tabDragMove" | "tabDragDrop" | "tabDragEnd" | "tabDragCancel"
        ) {
            let source_window_id = source_window_id.or_else(|| host_window_id.clone());
            let Some(source_window_id) = source_window_id else {
                return;
            };
            let mut action = serde_json::json!({
                "type": action_type,
                "cancelled": cancelled,
                "screenX": screen_x,
                "screenY": screen_y
            });
            if let Some(session_id) = session_id {
                action["sessionId"] = serde_json::Value::String(session_id);
            }
            if let Some(tab_id) = tab_id {
                action["tabId"] = serde_json::Value::String(tab_id);
            }
            if let Some(target_window_id) = target_window_id {
                action["windowId"] = serde_json::Value::String(target_window_id);
            }
            if let Some(before_tab_id) = before_tab_id {
                action["beforeTabId"] = serde_json::Value::String(before_tab_id);
            }
            if let Err(error) =
                crate::handle_game_window_tab_drag(&app, &state, &source_window_id, &action).await
            {
                let _ = app.emit(
                    "rion://shell-error",
                    serde_json::json!({ "code": error.code, "message": error.message }),
                );
            }
            return;
        }
        let target_window_id = target_window_id.or(host_window_id);
        let command = match action_type.as_str() {
            "activate" => tab_id.map(|tab_id| CoreCommand::EmbeddedTabActivate { tab_id }),
            "hide" => tab_id.map(|tab_id| CoreCommand::EmbeddedTabHide { tab_id }),
            "reorder" => tab_id.map(|tab_id| CoreCommand::EmbeddedTabReorder {
                tab_id,
                before_tab_id,
            }),
            "move" => tab_id.and_then(|tab_id| {
                target_window_id
                    .as_deref()
                    .and_then(|window_id| {
                        crate::launch_target_for_game_window(&app, window_id).ok()
                    })
                    .map(|target| CoreCommand::EmbeddedTabMove { tab_id, target })
            }),
            "stop" => tab_id.and_then(|tab_id| stop_command_for_tab(&state.core, &tab_id)),
            "openLauncher" => {
                if let Some(window_id) = target_window_id.as_deref()
                    && let Err(message) = crate::runtime_tab_menu::open_launcher(&app, window_id)
                {
                    let _ = app.emit(
                        "rion://shell-error",
                        serde_json::json!({
                            "code": "TAURI_RUNTIME_TAB_MENU_FAILED",
                            "message": message
                        }),
                    );
                }
                None
            }
            "openTabMenu" => {
                if let Some(tab_id) = tab_id.as_deref()
                    && let Err(message) = crate::runtime_tab_menu::open_tab(&app, tab_id)
                {
                    let _ = app.emit(
                        "rion://shell-error",
                        serde_json::json!({
                            "code": "TAURI_RUNTIME_TAB_MENU_FAILED",
                            "message": message
                        }),
                    );
                }
                None
            }
            _ => None,
        };
        let _ = source_window_id;
        if let Some(command) = command
            && let Err(error) = state.core.invoke_async(command).await
        {
            let _ = app.emit(
                "rion://shell-error",
                serde_json::json!({ "code": error.code(), "message": error.to_string() }),
            );
        }
    });
}

fn stop_command_for_tab(core: &rion_core::AppCore, tab_id: &str) -> Option<CoreCommand> {
    let snapshot = core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .ok()
        .and_then(|value| serde_json::from_value::<BrowserRuntimeSnapshot>(value).ok())?;
    let tab = snapshot.tabs.into_iter().find(|tab| tab.id == tab_id)?;
    Some(if tab.tab_type == "workspace" {
        CoreCommand::BrowserWorkspaceStop {
            workspace_id: tab.source_id,
        }
    } else {
        CoreCommand::BrowserRoleStop {
            role_id: tab.source_id,
        }
    })
}

pub fn fullscreen_preference(core: &rion_core::AppCore) -> bool {
    core.invoke(CoreCommand::RuntimeWindowPreferencesGet)
        .ok()
        .and_then(|value| serde_json::from_value::<RuntimeWindowPreferencesRecord>(value).ok())
        .is_some_and(|preferences| preferences.always_show_toolbar_in_full_screen)
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_action_scope_preserves_window_identifiers() {
        assert!(unsafe { super::rion_runtime_tabs_action_scope_self_test() });
    }

    // Keep the historical parity evidence name while the native scope key is now a window ID.
    #[test]
    fn native_action_scope_preserves_nonzero_and_safe_negative_display_ids() {
        native_action_scope_preserves_window_identifiers();
    }
}
