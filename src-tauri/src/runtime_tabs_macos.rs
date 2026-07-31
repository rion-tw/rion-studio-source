#![cfg(target_os = "macos")]

use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use rion_core::{CoreCommand, RuntimeWindowPreferencesRecord};
use tauri::{AppHandle, Manager, Window};

const CONTROLLER_CREATION_TIMEOUT: Duration = Duration::from_secs(10);

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
    fn rion_runtime_tabs_install_safe_tao_event_dispatch() -> bool;
    fn rion_runtime_tabs_create(
        window: *mut c_void,
        window_id: *const c_char,
        context: *mut c_void,
        action: ActionCallback,
        layout: LayoutCallback,
    ) -> *mut c_void;
    fn rion_runtime_tabs_destroy(controller: *mut c_void);
    fn rion_runtime_tabs_prepare_fullscreen(controller: *mut c_void, fullscreen: bool);
    fn rion_runtime_tabs_set_fullscreen_policy(controller: *mut c_void, always_show: bool);
    fn rion_runtime_tabs_is_main_thread() -> bool;
    fn rion_runtime_tabs_set_active(controller: *mut c_void, tab_id: *const c_char);
    fn rion_runtime_tabs_reserve(
        controller: *mut c_void,
        tab_id: *const c_char,
        name: *const c_char,
        tab_type: *const c_char,
        workspace_template: *const c_char,
        window_id: *const c_char,
    );
    fn rion_runtime_tabs_replace(
        controller: *mut c_void,
        provisional_id: *const c_char,
        tab_id: *const c_char,
        name: *const c_char,
        tab_type: *const c_char,
        workspace_template: *const c_char,
        active_tab_id: *const c_char,
    );
    fn rion_runtime_tabs_remove(
        controller: *mut c_void,
        tab_id: *const c_char,
        active_tab_id: *const c_char,
    );
    fn rion_runtime_tabs_update_metadata(
        controller: *mut c_void,
        tab: *const NativeTabInput,
        always_hide_tab_close_button: bool,
        audio_muted_label: *const c_char,
        audio_playing_label: *const c_char,
        close_label: *const c_char,
        add_label: *const c_char,
        scroll_left_label: *const c_char,
        scroll_right_label: *const c_char,
    );
    #[cfg(test)]
    fn rion_runtime_tabs_action_scope_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_overflow_layout_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_shortcut_self_test() -> bool;
}

pub fn install_safe_tao_event_dispatch() -> Result<(), String> {
    if unsafe { rion_runtime_tabs_install_safe_tao_event_dispatch() } {
        Ok(())
    } else {
        Err("TaoWindow was unavailable for safe macOS event dispatch.".to_owned())
    }
}

struct CallbackContext {
    app: AppHandle,
    layout_updates: Arc<LayoutUpdateState>,
    window_label: String,
}

#[derive(Default)]
struct LayoutUpdateState {
    requested: AtomicBool,
    running: AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
enum ControllerCreationWaitError {
    CallbackLost,
    TimedOut,
}

#[derive(Clone)]
pub struct MacRuntimeTabsController {
    inner: Arc<MacRuntimeTabsControllerInner>,
}

struct MacRuntimeTabsControllerInner {
    app: AppHandle,
    context: *mut CallbackContext,
    latest_active_tab_id: Mutex<Option<Option<String>>>,
    metadata_pending: Mutex<HashMap<String, PendingMacTabMetadata>>,
    metadata_scheduled: AtomicBool,
    raw: *mut c_void,
    selection_generation: AtomicU64,
}

struct PendingMacTabMetadata {
    always_hide_tab_close_button: bool,
    always_show_in_fullscreen: bool,
    language: String,
    tab: MacRuntimeTabState,
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
    pub fn create(app: &AppHandle, window: &Window, window_id: &str) -> Result<Self, String> {
        let ns_window = window.ns_window().map_err(|error| error.to_string())?;
        let window_id = c_string(window_id);
        let context = Box::into_raw(Box::new(CallbackContext {
            app: app.clone(),
            layout_updates: Arc::new(LayoutUpdateState::default()),
            window_label: window.label().to_owned(),
        }));
        let (sender, receiver) = mpsc::sync_channel(1);
        let context_address = context as usize;
        let window_address = ns_window as usize;
        if let Err(error) = app.run_on_main_thread(move || {
            let raw = unsafe {
                rion_runtime_tabs_create(
                    window_address as *mut c_void,
                    window_id.as_ptr(),
                    context_address as *mut c_void,
                    action_callback,
                    layout_callback,
                )
            };
            if sender.send(raw as usize).is_err() {
                unsafe {
                    if !raw.is_null() {
                        rion_runtime_tabs_destroy(raw);
                    }
                    drop(Box::from_raw(context_address as *mut CallbackContext));
                }
            }
        }) {
            unsafe { drop(Box::from_raw(context)) };
            return Err(error.to_string());
        }
        let raw = match wait_for_controller(&receiver, CONTROLLER_CREATION_TIMEOUT) {
            Ok(raw) => raw as *mut c_void,
            Err(ControllerCreationWaitError::CallbackLost) => {
                unsafe { drop(Box::from_raw(context)) };
                return Err("AppKit runtime tabs creation callback was lost.".to_owned());
            }
            Err(ControllerCreationWaitError::TimedOut) => {
                return Err(format!(
                    "AppKit runtime tabs creation timed out after {} milliseconds.",
                    CONTROLLER_CREATION_TIMEOUT.as_millis()
                ));
            }
        };
        if raw.is_null() {
            unsafe { drop(Box::from_raw(context)) };
            return Err("AppKit runtime tabs controller could not be created.".to_owned());
        }
        Ok(Self {
            inner: Arc::new(MacRuntimeTabsControllerInner {
                app: app.clone(),
                context,
                latest_active_tab_id: Mutex::new(None),
                metadata_pending: Mutex::new(HashMap::new()),
                metadata_scheduled: AtomicBool::new(false),
                raw,
                selection_generation: AtomicU64::new(0),
            }),
        })
    }

    pub fn prepare_fullscreen(&self, fullscreen: bool) {
        let raw = self.inner.raw as usize;
        let _ = self.inner.app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_prepare_fullscreen(raw as *mut c_void, fullscreen);
        });
    }

    pub fn update_metadata(
        &self,
        tab: MacRuntimeTabState,
        always_show_in_fullscreen: bool,
        always_hide_tab_close_button: bool,
        language: &str,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        inner
            .metadata_pending
            .lock()
            .map_err(|_| "AppKit tab metadata queue is unavailable.".to_owned())?
            .insert(
                tab.id.clone(),
                PendingMacTabMetadata {
                    always_hide_tab_close_button,
                    always_show_in_fullscreen,
                    language: language.to_owned(),
                    tab,
                },
            );
        if inner
            .metadata_scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            schedule_metadata_batch(inner)?;
        }
        Ok(())
    }

    pub fn set_active(&self, tab_id: Option<&str>) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let generation = inner.selection_generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(mut latest) = inner.latest_active_tab_id.lock() {
            *latest = Some(tab_id.map(str::to_owned));
        }
        let tab_id = tab_id.map(c_string);
        let app = inner.app.clone();
        app.run_on_main_thread(move || {
            if inner.selection_generation.load(Ordering::Acquire) != generation {
                return;
            }
            unsafe {
                rion_runtime_tabs_set_active(
                    inner.raw,
                    tab_id
                        .as_ref()
                        .map_or(std::ptr::null(), |value| value.as_ptr()),
                );
            }
        })
        .map_err(|error| error.to_string())
    }

    pub fn remember_active(&self, tab_id: Option<&str>) {
        if let Ok(mut latest) = self.inner.latest_active_tab_id.lock() {
            *latest = Some(tab_id.map(str::to_owned));
        }
    }

    pub fn reserve(
        &self,
        window_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_id = c_string(tab_id);
        let name = c_string(name);
        let tab_type = c_string(tab_type);
        let workspace_template = workspace_template.map(c_string);
        let window_id = c_string(window_id);
        if unsafe { rion_runtime_tabs_is_main_thread() } {
            unsafe {
                rion_runtime_tabs_reserve(
                    inner.raw,
                    tab_id.as_ptr(),
                    name.as_ptr(),
                    tab_type.as_ptr(),
                    workspace_template
                        .as_ref()
                        .map_or(std::ptr::null(), |value| value.as_ptr()),
                    window_id.as_ptr(),
                );
            }
            return Ok(());
        }
        let app = inner.app.clone();
        app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_reserve(
                inner.raw,
                tab_id.as_ptr(),
                name.as_ptr(),
                tab_type.as_ptr(),
                workspace_template
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                window_id.as_ptr(),
            );
        })
        .map_err(|error| error.to_string())
    }

    pub fn remove(&self, tab_id: &str, active_tab_id: Option<&str>) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_id = c_string(tab_id);
        let active_tab_id = active_tab_id.map(c_string);
        let app = inner.app.clone();
        app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_remove(
                inner.raw,
                tab_id.as_ptr(),
                active_tab_id
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            );
        })
        .map_err(|error| error.to_string())
    }

    pub fn replace_reservation(
        &self,
        provisional_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
        active_tab_id: Option<&str>,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let provisional_id = c_string(provisional_id);
        let tab_id = c_string(tab_id);
        let name = c_string(name);
        let tab_type = c_string(tab_type);
        let workspace_template = workspace_template.map(c_string);
        let active_tab_id = active_tab_id.map(c_string);
        let app = inner.app.clone();
        app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_replace(
                inner.raw,
                provisional_id.as_ptr(),
                tab_id.as_ptr(),
                name.as_ptr(),
                tab_type.as_ptr(),
                workspace_template
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                active_tab_id
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            );
        })
        .map_err(|error| error.to_string())
    }
}

fn schedule_metadata_batch(inner: Arc<MacRuntimeTabsControllerInner>) -> Result<(), String> {
    let app = inner.app.clone();
    let error_inner = Arc::clone(&inner);
    app.run_on_main_thread(move || {
        let pending = inner
            .metadata_pending
            .lock()
            .ok()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for update in pending.into_values() {
            apply_metadata_update(&inner, update);
        }
        inner.metadata_scheduled.store(false, Ordering::Release);
        let has_pending = inner
            .metadata_pending
            .lock()
            .ok()
            .is_some_and(|pending| !pending.is_empty());
        if has_pending
            && inner
                .metadata_scheduled
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            && let Err(error) = schedule_metadata_batch(Arc::clone(&inner))
        {
            inner.metadata_scheduled.store(false, Ordering::Release);
            eprintln!("AppKit tab metadata batch could not be rescheduled: {error}");
        }
    })
    .map_err(|error| {
        error_inner
            .metadata_scheduled
            .store(false, Ordering::Release);
        error.to_string()
    })
}

fn apply_metadata_update(inner: &MacRuntimeTabsControllerInner, update: PendingMacTabMetadata) {
    let tab = update.tab;
    let strings = NativeTabStrings {
        icon: tab.icon_data_url.as_deref().map(c_string),
        id: c_string(&tab.id),
        name: c_string(&tab.name),
        tab_type: c_string(&tab.tab_type),
        tooltip: c_string(&tab.tooltip),
        workspace_template: tab.workspace_template.as_deref().map(c_string),
    };
    let labels = labels(&update.language);
    let muted = c_string(labels.muted);
    let playing = c_string(labels.playing);
    let close = c_string(labels.close);
    let add = c_string(labels.add);
    let scroll_left = c_string(labels.scroll_left);
    let scroll_right = c_string(labels.scroll_right);
    let input = NativeTabInput {
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
    };
    unsafe {
        rion_runtime_tabs_set_fullscreen_policy(inner.raw, update.always_show_in_fullscreen);
        rion_runtime_tabs_update_metadata(
            inner.raw,
            &input,
            update.always_hide_tab_close_button,
            muted.as_ptr(),
            playing.as_ptr(),
            close.as_ptr(),
            add.as_ptr(),
            scroll_left.as_ptr(),
            scroll_right.as_ptr(),
        );
    }
}

fn wait_for_controller(
    receiver: &mpsc::Receiver<usize>,
    timeout: Duration,
) -> Result<usize, ControllerCreationWaitError> {
    receiver.recv_timeout(timeout).map_err(|error| match error {
        mpsc::RecvTimeoutError::Timeout => ControllerCreationWaitError::TimedOut,
        mpsc::RecvTimeoutError::Disconnected => ControllerCreationWaitError::CallbackLost,
    })
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

struct Labels {
    add: &'static str,
    muted: &'static str,
    playing: &'static str,
    close: &'static str,
    scroll_left: &'static str,
    scroll_right: &'static str,
}

fn labels(language: &str) -> Labels {
    match language {
        "zh-TW" => Labels {
            add: "開啟角色或工作區",
            muted: "分頁已靜音",
            playing: "正在播放音訊",
            close: "停止並關閉分頁",
            scroll_left: "向左捲動分頁",
            scroll_right: "向右捲動分頁",
        },
        "zh-CN" => Labels {
            add: "打开角色或工作区",
            muted: "标签页已静音",
            playing: "正在播放音频",
            close: "停止并关闭标签页",
            scroll_left: "向左滚动标签页",
            scroll_right: "向右滚动标签页",
        },
        "ja" => Labels {
            add: "ロールまたはワークスペースを開く",
            muted: "タブはミュート中",
            playing: "音声を再生中",
            close: "停止してタブを閉じる",
            scroll_left: "タブを左へスクロール",
            scroll_right: "タブを右へスクロール",
        },
        _ => Labels {
            add: "Open role or workspace",
            muted: "Tab muted",
            playing: "Playing audio",
            close: "Stop and close tab",
            scroll_left: "Scroll tabs left",
            scroll_right: "Scroll tabs right",
        },
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
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        if action_type == "openLauncher" {
            // AppKit invokes this callback inside the plus button's mouse event. The launcher
            // model and native Menu are prebuilt, so popup can run in this same event turn
            // instead of entering Tauri's async queue behind surface setup or navigation work.
            let Some(window_id) = source_window_id else {
                return;
            };
            if let Err(message) = crate::runtime_tab_menu::open_launcher(&context.app, &window_id) {
                crate::reveal_shell_error(
                    &context.app,
                    crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                );
            }
            return;
        }
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
    }));
}

unsafe extern "C" fn layout_callback(
    context: *mut c_void,
    _height_inset: f64,
    _y_offset: f64,
    valid: bool,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() || !valid {
            return;
        }
        let context = unsafe { &*(context as *const CallbackContext) };
        let app = context.app.clone();
        let label = context.window_label.clone();
        let layout_updates = Arc::clone(&context.layout_updates);
        if !request_layout_update(&layout_updates) {
            return;
        }
        tauri::async_runtime::spawn_blocking(move || {
            loop {
                layout_updates.requested.store(false, Ordering::Release);
                if let Some(window) = app.get_window(&label)
                    && let Ok(size) = window.inner_size()
                    && let Some(state) = app.try_state::<crate::CoreState>()
                {
                    state.runtime.resize_window(&label, size.width, size.height);
                }
                if !continue_layout_updates(&layout_updates) {
                    break;
                }
            }
        });
    }));
}

fn request_layout_update(state: &LayoutUpdateState) -> bool {
    state.requested.store(true, Ordering::Release);
    state
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn continue_layout_updates(state: &LayoutUpdateState) -> bool {
    if state.requested.swap(false, Ordering::AcqRel) {
        return true;
    }
    state.running.store(false, Ordering::Release);
    state.requested.load(Ordering::Acquire)
        && state
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
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
            crate::reveal_shell_error(
                &app,
                crate::shell_error("SHELL_STATE_UNAVAILABLE", "App state is unavailable."),
            );
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
                crate::reveal_shell_error(
                    &app,
                    rion_core::CoreErrorPayload {
                        code: error.code,
                        message: error.message,
                    },
                );
            }
            return;
        }
        let target_window_id = target_window_id.or(host_window_id);
        let preview_tab_id = tab_id.clone();
        if matches!(
            action_type.as_str(),
            "activate" | "hide" | "reorder" | "move" | "stop" | "openTabMenu"
        ) && tab_id.is_none()
        {
            crate::reveal_shell_error(
                &app,
                crate::shell_error(
                    "TAURI_RUNTIME_TAB_MENU_FAILED",
                    "Runtime tab ID is required.",
                ),
            );
            return;
        }
        if action_type == "activate" {
            if let Some(tab_id) = tab_id.as_deref()
                && let Err(message) =
                    crate::preview_and_commit_native_tab_selection(&app, &state, tab_id)
            {
                crate::reveal_shell_error(
                    &app,
                    crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                );
            }
            return;
        }
        if action_type == "stop"
            && let Some(tab_id) = tab_id.as_deref()
            && state.runtime.cancel_provisional_tab_launch(tab_id)
        {
            return;
        }
        let previewed_stop_command = if action_type == "stop" {
            let Some(tab_id) = tab_id.as_deref() else {
                return;
            };
            match state.runtime.preview_tab_close(tab_id) {
                Ok(intent) => Some(intent.into_core_command()),
                Err(message) => {
                    crate::reveal_shell_error(
                        &app,
                        crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                    );
                    return;
                }
            }
        } else {
            None
        };
        let command = match action_type.as_str() {
            "hide" => tab_id.map(|tab_id| CoreCommand::EmbeddedTabHide { tab_id }),
            "reorder" => tab_id.map(|tab_id| CoreCommand::EmbeddedTabReorder {
                tab_id,
                before_tab_id,
            }),
            "move" => tab_id.and_then(|tab_id| {
                let Some(window_id) = target_window_id.as_deref() else {
                    crate::reveal_shell_error(
                        &app,
                        crate::shell_error(
                            "TAURI_RUNTIME_TAB_MENU_FAILED",
                            "Target Game Window was not found.",
                        ),
                    );
                    return None;
                };
                match crate::launch_target_for_game_window(&app, window_id) {
                    Ok(target) => Some(CoreCommand::EmbeddedTabMove { tab_id, target }),
                    Err(error) => {
                        crate::reveal_shell_error(&app, error);
                        None
                    }
                }
            }),
            "stop" => previewed_stop_command,
            "openLauncher" => {
                if let Some(window_id) = target_window_id.as_deref()
                    && let Err(message) = crate::runtime_tab_menu::open_launcher(&app, window_id)
                {
                    crate::reveal_shell_error(
                        &app,
                        crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                    );
                }
                None
            }
            "openTabMenu" => {
                if let Some(tab_id) = tab_id.as_deref()
                    && let Err(message) = crate::runtime_tab_menu::open_tab(&app, tab_id)
                {
                    crate::reveal_shell_error(
                        &app,
                        crate::shell_error("TAURI_RUNTIME_TAB_MENU_FAILED", message),
                    );
                }
                None
            }
            _ => None,
        };
        let _ = source_window_id;
        if let Some(command) = command {
            let result = state.core.invoke_async(command).await;
            if action_type == "stop"
                && let Some(tab_id) = preview_tab_id.as_deref()
            {
                state
                    .runtime
                    .resolve_tab_close_preview(tab_id, result.is_ok());
            }
            if let Err(error) = result {
                crate::reveal_shell_error(&app, error.payload());
            }
        } else if action_type == "stop"
            && let Some(tab_id) = preview_tab_id.as_deref()
        {
            // The native control already removed the item optimistically. If the
            // scoped command could not be created, repaint the authoritative tab.
            state.runtime.cancel_tab_close_preview(tab_id);
        }
    });
}

pub fn runtime_window_preferences(core: &rion_core::AppCore) -> RuntimeWindowPreferencesRecord {
    core.invoke(CoreCommand::RuntimeWindowPreferencesGet)
        .ok()
        .and_then(|value| serde_json::from_value::<RuntimeWindowPreferencesRecord>(value).ok())
        .unwrap_or(RuntimeWindowPreferencesRecord {
            always_hide_tab_close_button: false,
            always_show_toolbar_in_full_screen: false,
            restore_game_windows_on_startup: true,
        })
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use super::{
        ControllerCreationWaitError, LayoutUpdateState, continue_layout_updates,
        request_layout_update, wait_for_controller,
    };

    #[test]
    fn controller_creation_wait_is_bounded_and_distinguishes_disconnect() {
        let (sender, receiver) = mpsc::sync_channel(1);

        assert_eq!(
            wait_for_controller(&receiver, Duration::ZERO),
            Err(ControllerCreationWaitError::TimedOut)
        );

        drop(sender);
        assert_eq!(
            wait_for_controller(&receiver, Duration::ZERO),
            Err(ControllerCreationWaitError::CallbackLost)
        );
    }

    #[test]
    fn layout_updates_coalesce_while_one_worker_is_running() {
        let state = LayoutUpdateState::default();

        assert!(request_layout_update(&state));
        assert!(!request_layout_update(&state));
        assert!(continue_layout_updates(&state));
        assert!(!continue_layout_updates(&state));
        assert!(request_layout_update(&state));
    }

    #[test]
    fn native_action_scope_preserves_window_identifiers() {
        assert!(unsafe { super::rion_runtime_tabs_action_scope_self_test() });
    }

    // Keep the historical parity evidence name while the native scope key is now a window ID.
    #[test]
    fn native_action_scope_preserves_nonzero_and_safe_negative_display_ids() {
        native_action_scope_preserves_window_identifiers();
    }

    #[test]
    fn native_tab_overflow_layout_clamps_and_reclaims_hidden_close_width() {
        assert!(unsafe { super::rion_runtime_tabs_overflow_layout_self_test() });
    }

    #[test]
    fn native_control_tab_shortcut_is_scoped_and_does_not_capture_command_tab() {
        assert!(unsafe { super::rion_runtime_tabs_shortcut_self_test() });
    }
}
