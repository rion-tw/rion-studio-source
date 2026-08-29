
use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use dispatch2::DispatchQueue;
use tauri::{AppHandle, Emitter, Manager, Window};

const CONTROLLER_CREATION_TIMEOUT: Duration = Duration::from_secs(10);
const APPKIT_TRACKING_DISPATCH_TIMEOUT: Duration = Duration::from_secs(2);
const APPKIT_TRACKING_TASK_QUEUED: u8 = 0;
const APPKIT_TRACKING_TASK_RUNNING: u8 = 1;
const APPKIT_TRACKING_TASK_CANCELLED: u8 = 2;
const APPKIT_TRACKING_TASK_FINISHED: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AppKitTrackingDispatchError {
    TimedOutBeforeStart,
    TimedOutAfterStart,
    CallbackLost,
}

impl AppKitTrackingDispatchError {
    pub(crate) const fn mutation_may_have_started(self) -> bool {
        matches!(self, Self::TimedOutAfterStart)
    }
}

impl std::fmt::Display for AppKitTrackingDispatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::TimedOutBeforeStart => {
                "The AppKit tracking-loop mutation was cancelled before it started."
            }
            Self::TimedOutAfterStart => {
                "The AppKit tracking-loop mutation started, but its result is unknown."
            }
            Self::CallbackLost => "The AppKit tracking-loop mutation callback was disconnected.",
        })
    }
}

struct AppKitTrackingTaskState(AtomicU8);

impl Default for AppKitTrackingTaskState {
    fn default() -> Self {
        Self(AtomicU8::new(APPKIT_TRACKING_TASK_QUEUED))
    }
}

fn execute_appkit_tracking_task<T>(
    state: &AppKitTrackingTaskState,
    sender: mpsc::SyncSender<T>,
    task: impl FnOnce() -> T,
) {
    if state
        .0
        .compare_exchange(
            APPKIT_TRACKING_TASK_QUEUED,
            APPKIT_TRACKING_TASK_RUNNING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return;
    }
    let result = task();
    let _ = sender.send(result);
    state
        .0
        .store(APPKIT_TRACKING_TASK_FINISHED, Ordering::Release);
}

fn wait_for_appkit_tracking_task<T>(
    receiver: &mpsc::Receiver<T>,
    state: &AppKitTrackingTaskState,
    timeout: Duration,
) -> Result<T, AppKitTrackingDispatchError> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => Ok(result),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(AppKitTrackingDispatchError::CallbackLost)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if state
                .0
                .compare_exchange(
                    APPKIT_TRACKING_TASK_QUEUED,
                    APPKIT_TRACKING_TASK_CANCELLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                return Err(AppKitTrackingDispatchError::TimedOutBeforeStart);
            }
            receiver
                .try_recv()
                .map_err(|_| AppKitTrackingDispatchError::TimedOutAfterStart)
        }
    }
}

pub(crate) fn run_on_appkit_tracking_main_classified<T>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppKitTrackingDispatchError>
where
    T: Send + 'static,
{
    if unsafe { rion_runtime_tabs_is_main_thread() } {
        return Ok(task());
    }
    let state = Arc::new(AppKitTrackingTaskState::default());
    let worker_state = Arc::clone(&state);
    let (sender, receiver) = mpsc::sync_channel(1);
    DispatchQueue::main().exec_async(move || {
        execute_appkit_tracking_task(&worker_state, sender, task);
    });
    wait_for_appkit_tracking_task(&receiver, &state, APPKIT_TRACKING_DISPATCH_TIMEOUT)
}

pub(crate) fn run_on_appkit_tracking_main<T>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    run_on_appkit_tracking_main_classified(task).map_err(|error| error.to_string())
}

fn submit_on_appkit_tracking_main(task: impl FnOnce() + Send + 'static) {
    if unsafe { rion_runtime_tabs_is_main_thread() } {
        task();
    } else {
        DispatchQueue::main().exec_async(task);
    }
}

pub(crate) fn request_window_hide(window: Window) {
    let label = window.label().to_owned();
    let app = window.app_handle().clone();
    DispatchQueue::main().exec_async(move || {
        if let Err(error) = window.hide() {
            eprintln!(
                "AppKit window retirement failed after submission: window={label} error={error}"
            );
            let _ = app.emit(
                "rion://shell-error",
                serde_json::json!({
                    "code": "SYSTEM_WINDOW_HIDE_FAILED",
                    "failureKind": "appkit-window-retirement",
                    "message": "Rion Studio could not hide the game window before background cleanup.",
                    "windowLabel": label,
                    "error": error.to_string(),
                }),
            );
        }
    });
}

#[repr(C)]
struct NativeTabInput {
    active: bool,
    audible: bool,
    audio_muted: bool,
    automatic_input_paused: bool,
    automatic_input_restart_required: bool,
    identifier: *const c_char,
    name: *const c_char,
    phase: *const c_char,
    failure_body: *const c_char,
    failure_title: *const c_char,
    loading_accessibility_label: *const c_char,
    retry_label: *const c_char,
    status_identity_json: *const c_char,
    tooltip: *const c_char,
    tab_type: *const c_char,
    icon_data_url: *const c_char,
    workspace_template: *const c_char,
}

#[cfg(feature = "desktop-e2e")]
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
struct NativeDesktopE2eTitlebarGeometry {
    root_min_x: f64,
    root_width: f64,
    tab_min_x: f64,
    tab_min_y: f64,
    tab_max_x: f64,
    tab_max_y: f64,
    window_name_max_x: f64,
    traffic_lights_max_x: f64,
    title_hidden: bool,
    valid: bool,
}

#[cfg(feature = "desktop-e2e")]
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
struct NativeDesktopE2eFullscreenToolbarState {
    accessory_visible_height: f64,
    always_show_in_full_screen: bool,
    accessory_on_screen: bool,
    fullscreen: bool,
    fullscreen_host_ready: bool,
    presentation_auto_hide_toolbar: bool,
    reveal_locked: bool,
    tab_strip_on_screen: bool,
    toolbar_pinned: bool,
    visible_traffic_light_count: u32,
    valid: bool,
}

#[cfg(feature = "desktop-e2e")]
#[derive(Clone, Copy, Debug)]
pub(crate) struct MacDesktopE2eTitlebarGeometry {
    pub(crate) root_min_x: f64,
    pub(crate) root_width: f64,
    pub(crate) tab_min_x: f64,
    pub(crate) tab_min_y: f64,
    pub(crate) tab_max_x: f64,
    pub(crate) tab_max_y: f64,
    pub(crate) window_name_max_x: f64,
    pub(crate) traffic_lights_max_x: f64,
    pub(crate) title_hidden: bool,
}

#[cfg(feature = "desktop-e2e")]
#[derive(Clone, Copy, Debug)]
pub(crate) struct MacDesktopE2eFullscreenToolbarState {
    pub(crate) accessory_visible_height: f64,
    pub(crate) always_show_in_full_screen: bool,
    pub(crate) accessory_on_screen: bool,
    pub(crate) fullscreen: bool,
    pub(crate) fullscreen_host_ready: bool,
    pub(crate) presentation_auto_hide_toolbar: bool,
    pub(crate) reveal_locked: bool,
    pub(crate) tab_strip_on_screen: bool,
    pub(crate) toolbar_pinned: bool,
    pub(crate) visible_traffic_light_count: u32,
}

type ActionCallback = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
    u32,
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
    fn rion_runtime_tabs_set_window_interaction(
        window: *mut c_void,
        pointer_passthrough: bool,
        focus_window: bool,
    ) -> bool;
    fn rion_runtime_tabs_set_active(controller: *mut c_void, tab_id: *const c_char);
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_accessibility_press(
        controller: *mut c_void,
        tab_id: *const c_char,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_accessibility_close(
        controller: *mut c_void,
        tab_id: *const c_char,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_accessibility_show_menu(
        controller: *mut c_void,
        tab_id: *const c_char,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_drag(
        source_controller: *mut c_void,
        tab_id: *const c_char,
        target_controller: *mut c_void,
        before_tab_id: *const c_char,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_select_menu_item(
        action: i32,
        target_rank: usize,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_status_presentation(controller: *mut c_void) -> i32;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_titlebar_geometry(
        controller: *mut c_void,
        geometry: *mut NativeDesktopE2eTitlebarGeometry,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_fullscreen_toolbar_state(
        controller: *mut c_void,
        state: *mut NativeDesktopE2eFullscreenToolbarState,
    ) -> bool;
    fn rion_runtime_tabs_hide_status(controller: *mut c_void);
    fn rion_runtime_tabs_set_window_name(controller: *mut c_void, window_name: *const c_char);
    fn rion_runtime_tabs_ensure(
        controller: *mut c_void,
        tab_id: *const c_char,
        name: *const c_char,
        tab_type: *const c_char,
        workspace_template: *const c_char,
        window_id: *const c_char,
    );
    fn rion_runtime_tabs_reserve(
        controller: *mut c_void,
        tab_id: *const c_char,
        name: *const c_char,
        tab_type: *const c_char,
        workspace_template: *const c_char,
        window_id: *const c_char,
    );
    fn rion_runtime_tabs_remove(
        controller: *mut c_void,
        tab_id: *const c_char,
        active_tab_id: *const c_char,
    );
    fn rion_runtime_tabs_reorder(controller: *mut c_void, tab_ids_json: *const c_char);
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
    fn rion_runtime_tabs_control_row_contains(
        controller: *mut c_void,
        screen_x: f64,
        screen_y: f64,
    ) -> bool;
    fn rion_runtime_tabs_drag_anchor(
        controller: *mut c_void,
        tab_id: *const c_char,
        grab_ratio_x: f64,
        grab_ratio_y: f64,
        window_offset_x: *mut f64,
        window_offset_y: *mut f64,
    ) -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_action_scope_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_drag_hysteresis_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_fullscreen_toolbar_policy_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_macro_fallback_event_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_overflow_layout_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_shortcut_self_test() -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_modifier_focus_self_test() -> bool;
}

pub(crate) fn set_appkit_window_interaction(
    window: &Window,
    pointer_passthrough: bool,
    focus_window: bool,
) -> Result<(), String> {
    let raw_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    run_on_appkit_tracking_main(move || unsafe {
        rion_runtime_tabs_set_window_interaction(
            raw_window as *mut c_void,
            pointer_passthrough,
            focus_window,
        )
    })?
    .then_some(())
    .ok_or_else(|| "The AppKit window interaction state could not be applied.".to_owned())
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
    pub automatic_input_paused: bool,
    pub automatic_input_restart_required: bool,
    pub audio_muted: bool,
    pub audible: bool,
    pub icon_data_url: Option<String>,
    pub id: String,
    pub loading_accessibility_label: String,
    pub name: String,
    pub phase: String,
    pub failure_body: String,
    pub failure_title: String,
    pub retry_label: String,
    pub status_identity_json: Option<String>,
    pub tooltip: String,
    pub tab_type: String,
    pub workspace_template: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct MacRuntimeTabDragAnchor {
    pub window_offset_x: f64,
    pub window_offset_y: f64,
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

    pub fn control_row_contains(&self, screen_x: f64, screen_y: f64) -> bool {
        let raw = self.inner.raw as usize;
        if unsafe { rion_runtime_tabs_is_main_thread() } {
            return unsafe {
                rion_runtime_tabs_control_row_contains(raw as *mut c_void, screen_x, screen_y)
            };
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        if self
            .inner
            .app
            .run_on_main_thread(move || {
                let value = unsafe {
                    rion_runtime_tabs_control_row_contains(raw as *mut c_void, screen_x, screen_y)
                };
                let _ = sender.send(value);
            })
            .is_err()
        {
            return false;
        }
        receiver
            .recv_timeout(Duration::from_millis(250))
            .unwrap_or(false)
    }

    pub fn drag_anchor(
        &self,
        tab_id: &str,
        grab_ratio_x: f64,
        grab_ratio_y: f64,
    ) -> Option<MacRuntimeTabDragAnchor> {
        let raw = self.inner.raw as usize;
        let tab_id = c_string(tab_id);
        let query = move || {
            let mut window_offset_x = 0.0;
            let mut window_offset_y = 0.0;
            let available = unsafe {
                rion_runtime_tabs_drag_anchor(
                    raw as *mut c_void,
                    tab_id.as_ptr(),
                    grab_ratio_x,
                    grab_ratio_y,
                    &mut window_offset_x,
                    &mut window_offset_y,
                )
            };
            available.then_some(MacRuntimeTabDragAnchor {
                window_offset_x,
                window_offset_y,
            })
        };
        if unsafe { rion_runtime_tabs_is_main_thread() } {
            return query();
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        if self
            .inner
            .app
            .run_on_main_thread(move || {
                let _ = sender.send(query());
            })
            .is_err()
        {
            return None;
        }
        receiver
            .recv_timeout(Duration::from_millis(250))
            .ok()
            .flatten()
    }

    #[cfg(feature = "desktop-e2e")]
    pub fn desktop_e2e_status_presentation(&self) -> &'static str {
        let raw = self.inner.raw as usize;
        let query = move || unsafe {
            rion_runtime_tabs_desktop_e2e_status_presentation(raw as *mut c_void)
        };
        let presentation = if unsafe { rion_runtime_tabs_is_main_thread() } {
            query()
        } else {
            let (sender, receiver) = mpsc::sync_channel(1);
            if self
                .inner
                .app
                .run_on_main_thread(move || {
                    let _ = sender.send(query());
                })
                .is_err()
            {
                return "hidden";
            }
            receiver
                .recv_timeout(Duration::from_millis(250))
                .unwrap_or_default()
        };
        match presentation {
            1 => "loading",
            2 => "failed",
            _ => "hidden",
        }
    }

    #[cfg(feature = "desktop-e2e")]
    pub(crate) fn desktop_e2e_titlebar_geometry(
        &self,
    ) -> Option<MacDesktopE2eTitlebarGeometry> {
        let raw = self.inner.raw as usize;
        let query = move || {
            let mut geometry = NativeDesktopE2eTitlebarGeometry::default();
            let available = unsafe {
                rion_runtime_tabs_desktop_e2e_titlebar_geometry(
                    raw as *mut c_void,
                    &mut geometry,
                )
            };
            (available && geometry.valid).then_some(geometry)
        };
        let geometry = if unsafe { rion_runtime_tabs_is_main_thread() } {
            query()
        } else {
            let (sender, receiver) = mpsc::sync_channel(1);
            if self
                .inner
                .app
                .run_on_main_thread(move || {
                    let _ = sender.send(query());
                })
                .is_err()
            {
                return None;
            }
            receiver
                .recv_timeout(Duration::from_millis(250))
                .ok()
                .flatten()
        }?;
        Some(MacDesktopE2eTitlebarGeometry {
            root_min_x: geometry.root_min_x,
            root_width: geometry.root_width,
            tab_min_x: geometry.tab_min_x,
            tab_min_y: geometry.tab_min_y,
            tab_max_x: geometry.tab_max_x,
            tab_max_y: geometry.tab_max_y,
            window_name_max_x: geometry.window_name_max_x,
            traffic_lights_max_x: geometry.traffic_lights_max_x,
            title_hidden: geometry.title_hidden,
        })
    }

    #[cfg(feature = "desktop-e2e")]
    pub(crate) fn desktop_e2e_fullscreen_toolbar_state(
        &self,
    ) -> Option<MacDesktopE2eFullscreenToolbarState> {
        let raw = self.inner.raw as usize;
        let query = move || {
            let mut state = NativeDesktopE2eFullscreenToolbarState::default();
            let available = unsafe {
                rion_runtime_tabs_desktop_e2e_fullscreen_toolbar_state(
                    raw as *mut c_void,
                    &mut state,
                )
            };
            (available && state.valid).then_some(state)
        };
        let state = if unsafe { rion_runtime_tabs_is_main_thread() } {
            query()
        } else {
            let (sender, receiver) = mpsc::sync_channel(1);
            self.inner
                .app
                .run_on_main_thread(move || {
                    let _ = sender.send(query());
                })
                .ok()?;
            receiver
                .recv_timeout(Duration::from_millis(250))
                .ok()
                .flatten()
        }?;
        Some(MacDesktopE2eFullscreenToolbarState {
            accessory_visible_height: state.accessory_visible_height,
            always_show_in_full_screen: state.always_show_in_full_screen,
            accessory_on_screen: state.accessory_on_screen,
            fullscreen: state.fullscreen,
            fullscreen_host_ready: state.fullscreen_host_ready,
            presentation_auto_hide_toolbar: state.presentation_auto_hide_toolbar,
            reveal_locked: state.reveal_locked,
            tab_strip_on_screen: state.tab_strip_on_screen,
            toolbar_pinned: state.toolbar_pinned,
            visible_traffic_light_count: state.visible_traffic_light_count,
        })
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

    #[cfg(feature = "desktop-e2e")]
    pub fn desktop_e2e_accessibility_press(&self, tab_id: &str) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_id = c_string(tab_id);
        run_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_accessibility_press(inner.raw, tab_id.as_ptr())
        })?
        .then_some(())
        .ok_or_else(|| {
            "The visible AppKit runtime tab did not accept its accessibility press.".to_owned()
        })
    }

    #[cfg(feature = "desktop-e2e")]
    pub fn desktop_e2e_accessibility_close(&self, tab_id: &str) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_id = c_string(tab_id);
        run_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_accessibility_close(inner.raw, tab_id.as_ptr())
        })?
        .then_some(())
        .ok_or_else(|| {
            "The visible AppKit runtime tab close control did not accept its accessibility press."
                .to_owned()
        })
    }

    #[cfg(feature = "desktop-e2e")]
    pub fn desktop_e2e_accessibility_show_menu(&self, tab_id: &str) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_id = c_string(tab_id);
        run_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_accessibility_show_menu(inner.raw, tab_id.as_ptr())
        })?
        .then_some(())
        .ok_or_else(|| {
            "The visible AppKit runtime tab did not expose its context menu.".to_owned()
        })
    }

    #[cfg(feature = "desktop-e2e")]
    pub fn desktop_e2e_native_drag(
        &self,
        tab_id: &str,
        target: &Self,
        before_tab_id: &str,
    ) -> Result<(), String> {
        let source = Arc::clone(&self.inner);
        let target = Arc::clone(&target.inner);
        let tab_id = c_string(tab_id);
        let before_tab_id = c_string(before_tab_id);
        run_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_desktop_e2e_drag(
                source.raw,
                tab_id.as_ptr(),
                target.raw,
                before_tab_id.as_ptr(),
            )
        })?
        .then_some(())
        .ok_or_else(|| "The AppKit runtime-tab drag was rejected.".to_owned())
    }

    #[cfg(feature = "desktop-e2e")]
    pub fn desktop_e2e_select_menu_item(action: &str, target_rank: usize) -> Result<(), String> {
        let action = match action {
            "hide" => 0,
            "moveToNewWindow" => 1,
            "move" => 2,
            _ => return Err("The runtime tab menu action is invalid.".to_owned()),
        };
        // Arm the one-shot NSMenu tracking notification from the command
        // thread. Once the menu is visible, the native observer posts the real
        // keyboard input without trying to re-enter the blocked Tauri lane.
        unsafe { rion_runtime_tabs_desktop_e2e_select_menu_item(action, target_rank) }
            .then_some(())
            .ok_or_else(|| "The AppKit runtime-tab menu action was rejected.".to_owned())
    }

    pub fn hide_status(&self) {
        let inner = Arc::clone(&self.inner);
        let app = inner.app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_hide_status(inner.raw);
        });
    }

    pub fn set_window_name(&self, window_name: Option<&str>) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let window_name = window_name.map(c_string);
        let app = inner.app.clone();
        app.run_on_main_thread(move || unsafe {
            rion_runtime_tabs_set_window_name(
                inner.raw,
                window_name
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            );
        })
        .map_err(|error| error.to_string())
    }

    pub fn remember_active(&self, tab_id: Option<&str>) {
        if let Ok(mut latest) = self.inner.latest_active_tab_id.lock() {
            *latest = Some(tab_id.map(str::to_owned));
        }
    }

    pub fn ensure(
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
        submit_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_ensure(
                inner.raw,
                tab_id.as_ptr(),
                name.as_ptr(),
                tab_type.as_ptr(),
                workspace_template
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                window_id.as_ptr(),
            );
        });
        Ok(())
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
        submit_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_remove(
                inner.raw,
                tab_id.as_ptr(),
                active_tab_id
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            );
        });
        Ok(())
    }

    pub fn reorder(&self, tab_ids: &[String]) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_ids = serde_json::to_string(tab_ids)
            .map(|value| c_string(&value))
            .map_err(|error| error.to_string())?;
        submit_on_appkit_tracking_main(move || unsafe {
            rion_runtime_tabs_reorder(inner.raw, tab_ids.as_ptr());
        });
        Ok(())
    }

    pub(crate) fn reorder_fenced(
        &self,
        tab_ids: &[String],
        window_id: &str,
        parent_operation_id: Option<&str>,
        drag_intents: Arc<crate::system_runtime::TabDragIntentCoordinator>,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let tab_ids = serde_json::to_string(tab_ids)
            .map(|value| c_string(&value))
            .map_err(|error| error.to_string())?;
        let window_id = window_id.to_owned();
        let parent_operation_id = parent_operation_id.map(str::to_owned);
        let app = inner.app.clone();
        app.run_on_main_thread(move || {
            if drag_intents
                .projection_is_superseded(parent_operation_id.as_deref(), &window_id)
            {
                return;
            }
            unsafe {
                rion_runtime_tabs_reorder(inner.raw, tab_ids.as_ptr());
            }
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
        phase: c_string(&tab.phase),
        tab_type: c_string(&tab.tab_type),
        tooltip: c_string(&tab.tooltip),
        workspace_template: tab.workspace_template.as_deref().map(c_string),
    };
    let failure_body = c_string(&tab.failure_body);
    let failure_title = c_string(&tab.failure_title);
    let loading_accessibility_label = c_string(&tab.loading_accessibility_label);
    let retry_label = c_string(&tab.retry_label);
    let status_identity_json = tab.status_identity_json.as_deref().map(c_string);
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
        automatic_input_paused: tab.automatic_input_paused,
        automatic_input_restart_required: tab.automatic_input_restart_required,
        identifier: strings.id.as_ptr(),
        name: strings.name.as_ptr(),
        phase: strings.phase.as_ptr(),
        failure_body: failure_body.as_ptr(),
        failure_title: failure_title.as_ptr(),
        loading_accessibility_label: loading_accessibility_label.as_ptr(),
        retry_label: retry_label.as_ptr(),
        status_identity_json: status_identity_json
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr()),
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
