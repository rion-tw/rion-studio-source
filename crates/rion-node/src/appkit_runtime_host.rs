use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_void},
    ptr::NonNull,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
};

use napi::{
    Status,
    bindgen_prelude::{Buffer, Function, Result},
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

mod errors;
mod platform;
mod trusted_input;
mod validation;
use errors::{
    adapter_error, host_destroyed_error, malformed_handle_error, malformed_projection_error,
    projection_readback_error, state_poisoned_error, workspace_divider_projection_readback_error,
};
#[cfg(feature = "desktop-e2e")]
use platform::{
    accessibility_close, accessibility_press, desktop_e2e_accessibility_show_menu,
    desktop_e2e_fullscreen_toolbar_state, desktop_e2e_status_presentation, desktop_e2e_tab_anchor,
    desktop_e2e_titlebar_geometry,
};
use platform::{
    apply_workspace_divider_projection, commit_projected_tabs, controller_pointer,
    create_controller, destroy_controller, dispatch_key_probe, dispatch_mouse_probe,
    ensure_appkit_main_thread, ensure_projected_tab, focus_native_window, phases_match,
    prepare_fullscreen, projection_matches, read_content_layout, read_native_view_tree,
    remove_projected_tab, resolve_native_window, set_fullscreen_policy, set_reveal_locked,
    set_tab_close_buttons_hidden, set_window_name, workspace_divider_projection_matches,
};
use trusted_input::{NativeInputSurface, PendingInputSurfaceCapture};
use validation::{decode_native_view_handle, parse_native_address, validate_identifier};

const APPKIT_EVENT_QUEUE_CAPACITY: usize = 64;
const MAX_NATIVE_FIELD_BYTES: usize = 4 * 1024;
const MAX_NATIVE_JSON_BYTES: usize = 64 * 1024;
const MAX_SERIALIZED_EVENT_BYTES: usize = 96 * 1024;
const MAX_PROJECTED_TABS: usize = 128;
const MAX_PROJECTED_WORKSPACE_DIVIDERS: usize = 128;

type AppKitEventCallback =
    ThreadsafeFunction<String, (), String, Status, false, false, APPKIT_EVENT_QUEUE_CAPACITY>;

#[napi(object)]
pub struct AppKitRuntimeHostIdentity {
    pub logical_window_id: String,
    pub launch_generation: String,
    pub native_generation: u32,
}

#[napi(object)]
pub struct AppKitRuntimeContentLayout {
    pub height_inset: f64,
    pub y_offset: f64,
    pub valid: bool,
}

#[napi(object)]
pub struct AppKitRuntimeTabProjection {
    pub tab_id: String,
    pub name: String,
    pub phase: String,
    pub tab_type: String,
    pub workspace_template: Option<String>,
}

#[napi(object)]
pub struct AppKitRuntimeTabProjectionReceipt {
    pub projection_revision: String,
    pub tab_count: u32,
    pub active_tab_id: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct AppKitWorkspaceDividerBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[napi(object)]
pub struct AppKitRuntimeWorkspaceDividerProjection {
    pub tab_id: String,
    pub attempt_generation: String,
    pub divider_index: u32,
    pub axis: String,
    pub bounds: AppKitWorkspaceDividerBounds,
    pub visible: bool,
}

#[napi(object)]
pub struct AppKitRuntimeWorkspaceDividerProjectionReceipt {
    pub projection_revision: String,
    pub divider_count: u32,
    pub content_bounds: AppKitWorkspaceDividerBounds,
}

#[cfg(feature = "desktop-e2e")]
#[napi(object)]
pub struct AppKitDesktopE2ETitlebarGeometry {
    pub root_min_x: f64,
    pub root_width: f64,
    pub tab_min_x: f64,
    pub tab_min_y: f64,
    pub tab_max_x: f64,
    pub tab_max_y: f64,
    pub window_name_max_x: f64,
    pub traffic_lights_max_x: f64,
    pub fullscreen_control_min_x: f64,
    pub fullscreen_control_min_y: f64,
    pub fullscreen_control_width: f64,
    pub fullscreen_control_height: f64,
    pub title_hidden: bool,
    pub valid: bool,
}

#[cfg(feature = "desktop-e2e")]
#[napi(object)]
pub struct AppKitDesktopE2ETabAnchor {
    pub x: f64,
    pub y: f64,
}

#[cfg(feature = "desktop-e2e")]
#[napi(object)]
pub struct AppKitDesktopE2EFullscreenToolbarState {
    pub accessory_visible_height: f64,
    pub always_hide_tab_close_button: bool,
    pub always_show_in_full_screen: bool,
    pub accessory_on_screen: bool,
    pub fullscreen: bool,
    pub fullscreen_host_ready: bool,
    pub presentation_auto_hide_toolbar: bool,
    pub reveal_locked: bool,
    pub tab_strip_on_screen: bool,
    pub toolbar_pinned: bool,
    pub tab_close_button_enabled_count: u32,
    pub visible_traffic_light_count: u32,
    pub valid: bool,
}

#[napi(object)]
pub struct AppKitNativeViewTreeNode {
    pub address: String,
    pub parent_address: Option<String>,
    pub depth: u32,
    pub class_name: String,
    pub hidden: bool,
    pub accepts_first_responder: bool,
    pub attached_to_window: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct AppKitKeyDispatchProbeReceipt {
    pub dispatched: bool,
    pub target_attached: bool,
    pub key_window_preserved: bool,
    pub key_window_first_responder_preserved: bool,
    pub target_first_responder_preserved: bool,
}

#[napi(object)]
pub struct AppKitMouseDispatchProbeReceipt {
    pub dispatched: bool,
    pub target_attached: bool,
    pub key_window_preserved: bool,
    pub key_window_first_responder_preserved: bool,
    pub target_first_responder_preserved: bool,
}

struct ValidatedTabProjection {
    tab_id: String,
    fingerprint: TabProjectionFingerprint,
    #[cfg(target_os = "macos")]
    tab_id_c: CString,
    #[cfg(target_os = "macos")]
    name_c: CString,
    #[cfg(target_os = "macos")]
    phase_c: CString,
    #[cfg(target_os = "macos")]
    tab_type_c: CString,
    #[cfg(target_os = "macos")]
    workspace_template_c: Option<CString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TabProjectionFingerprint {
    tab_id: String,
    name: String,
    phase: String,
    tab_type: String,
    workspace_template: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceDividerBoundsFingerprint {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceDividerFingerprint {
    tab_id: String,
    attempt_generation: String,
    divider_index: u32,
    axis: String,
    bounds: WorkspaceDividerBoundsFingerprint,
    visible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceDividerProjectionFingerprint {
    content_bounds: WorkspaceDividerBoundsFingerprint,
    dividers: Vec<WorkspaceDividerFingerprint>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ValidatedHostIdentity {
    logical_window_id: String,
    launch_generation: String,
    native_generation: u32,
}

impl ValidatedHostIdentity {
    fn validate(input: AppKitRuntimeHostIdentity) -> Result<Self> {
        validate_identifier(&input.logical_window_id, "logical window")?;
        validate_identifier(&input.launch_generation, "launch generation")?;
        if input.native_generation == 0 {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit native generation must be positive.",
            ));
        }
        Ok(Self {
            logical_window_id: input.logical_window_id,
            launch_generation: input.launch_generation,
            native_generation: input.native_generation,
        })
    }

    fn matches(&self, input: &AppKitRuntimeHostIdentity) -> bool {
        self.logical_window_id == input.logical_window_id
            && self.launch_generation == input.launch_generation
            && self.native_generation == input.native_generation
    }

    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "logicalWindowId": self.logical_window_id,
            "launchGeneration": self.launch_generation,
            "nativeGeneration": self.native_generation,
        })
    }
}

#[repr(u8)]
enum CallbackFailure {
    Healthy = 0,
    QueueRejected = 1,
    InvalidNativeEvent = 2,
    PanicContained = 3,
}

struct AppKitCallbackContext {
    accepting: AtomicBool,
    failure: AtomicU8,
    identity: ValidatedHostIdentity,
    callback: AppKitEventCallback,
}

impl AppKitCallbackContext {
    fn fail(&self, failure: CallbackFailure) {
        let _ = self.failure.compare_exchange(
            CallbackFailure::Healthy as u8,
            failure as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.accepting.store(false, Ordering::Release);
    }

    fn emit(&self, event: serde_json::Value) {
        if !self.accepting.load(Ordering::Acquire) {
            return;
        }
        let Ok(serialized) = serde_json::to_string(&event) else {
            self.fail(CallbackFailure::InvalidNativeEvent);
            return;
        };
        if serialized.len() > MAX_SERIALIZED_EVENT_BYTES {
            self.fail(CallbackFailure::InvalidNativeEvent);
            return;
        }
        if self
            .callback
            .call(serialized, ThreadsafeFunctionCallMode::NonBlocking)
            != Status::Ok
        {
            self.fail(CallbackFailure::QueueRejected);
        }
    }

    fn ensure_healthy(&self) -> Result<()> {
        match self.failure.load(Ordering::Acquire) {
            value if value == CallbackFailure::Healthy as u8 => Ok(()),
            value if value == CallbackFailure::QueueRejected as u8 => Err(adapter_error(
                Status::QueueFull,
                "The bounded AppKit callback queue rejected an authoritative event.",
            )),
            value if value == CallbackFailure::PanicContained as u8 => Err(adapter_error(
                Status::GenericFailure,
                "The AppKit callback boundary contained a native event failure.",
            )),
            _ => Err(adapter_error(
                Status::InvalidArg,
                "The AppKit adapter received malformed native event evidence.",
            )),
        }
    }
}

struct NativeHostState {
    context: Option<Box<AppKitCallbackContext>>,
    controller: Option<usize>,
    projection_revision: u64,
    projected_tab_ids: Vec<String>,
    projected_tab_fingerprints: Vec<TabProjectionFingerprint>,
    projected_active_tab_id: Option<String>,
    projection_poisoned: bool,
    failed_projected_tab_ids: Vec<String>,
    workspace_divider_projection_revision: u64,
    workspace_divider_projection: WorkspaceDividerProjectionFingerprint,
    workspace_divider_projection_poisoned: bool,
    next_input_capture_sequence: u64,
    pending_input_capture: Option<PendingInputSurfaceCapture>,
    input_surfaces: HashMap<String, NativeInputSurface>,
}

#[napi]
pub struct NativeAppKitRuntimeHost {
    identity: ValidatedHostIdentity,
    native_view: usize,
    native_window: usize,
    state: Mutex<NativeHostState>,
}

#[napi]
impl NativeAppKitRuntimeHost {
    #[napi(js_name = "focusWindow")]
    pub fn focus_window(&self, expected: AppKitRuntimeHostIdentity) -> Result<()> {
        self.require_identity(&expected)?;
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let native_window =
            NonNull::new(self.native_window as *mut c_void).ok_or_else(malformed_handle_error)?;
        focus_native_window(native_window)
    }

    #[napi(js_name = "probeDispatchMouse")]
    pub fn probe_dispatch_mouse(
        &self,
        expected: AppKitRuntimeHostIdentity,
        target_address: String,
        x: f64,
        y: f64,
        button: u32,
        modifier_flags: u32,
    ) -> Result<AppKitMouseDispatchProbeReceipt> {
        self.require_identity(&expected)?;
        let target_address = parse_native_address(&target_address)?;
        let button = u8::try_from(button).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit mouse-button probe value is invalid.",
            )
        })?;
        if !x.is_finite() || !y.is_finite() || button > 2 {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit mouse-dispatch probe value is invalid.",
            ));
        }
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        dispatch_mouse_probe(native_view, target_address, x, y, button, modifier_flags)
    }

    #[napi(js_name = "probeDispatchKey")]
    pub fn probe_dispatch_key(
        &self,
        expected: AppKitRuntimeHostIdentity,
        target_address: String,
        key_code: u32,
        characters: String,
        modifier_flags: u32,
        dispatch_mode: String,
    ) -> Result<AppKitKeyDispatchProbeReceipt> {
        self.require_identity(&expected)?;
        let target_address = parse_native_address(&target_address)?;
        let key_code = u16::try_from(key_code).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit key-code probe value is invalid.",
            )
        })?;
        if characters.is_empty()
            || characters.len() > 16
            || characters.chars().any(char::is_control)
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit key-character probe value is invalid.",
            ));
        }
        let characters = CString::new(characters).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit key-character probe contains an invalid null byte.",
            )
        })?;
        let dispatch_mode = match dispatch_mode.as_str() {
            "direct-view" => 0,
            "window-event" => 1,
            "temporary-key-direct-view" => 2,
            "temporary-key-window-event" => 3,
            _ => {
                return Err(adapter_error(
                    Status::InvalidArg,
                    "The AppKit key-dispatch probe mode is invalid.",
                ));
            }
        };
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        dispatch_key_probe(
            native_view,
            target_address,
            key_code,
            &characters,
            modifier_flags,
            dispatch_mode,
        )
    }

    #[napi(js_name = "snapshotNativeViewTree")]
    pub fn snapshot_native_view_tree(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<Vec<AppKitNativeViewTreeNode>> {
        self.require_identity(&expected)?;
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        read_native_view_tree(native_view)
    }

    #[napi(js_name = "applyTabProjection")]
    pub fn apply_tab_projection(
        &self,
        expected: AppKitRuntimeHostIdentity,
        projection_revision: String,
        tabs: Vec<AppKitRuntimeTabProjection>,
        active_tab_id: Option<String>,
    ) -> Result<AppKitRuntimeTabProjectionReceipt> {
        self.require_identity(&expected)?;
        let revision = validate_projection_revision(&projection_revision)?;
        let tabs = validate_tab_projection(tabs, active_tab_id.as_deref())?;
        let tab_ids = tabs
            .iter()
            .map(|tab| tab.tab_id.clone())
            .collect::<Vec<_>>();
        let tab_fingerprints = tabs
            .iter()
            .map(|tab| tab.fingerprint.clone())
            .collect::<Vec<_>>();
        let phases_json = tab_phases_json(&tabs)?;
        let order_json = CString::new(serde_json::to_vec(&tab_ids).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit tab projection could not be serialized.",
            )
        })?)
        .map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The AppKit tab projection contains an invalid null byte.",
            )
        })?;
        let active_tab_id_c = active_tab_id
            .as_deref()
            .map(CString::new)
            .transpose()
            .map_err(|_| {
                adapter_error(
                    Status::InvalidArg,
                    "The active AppKit tab contains an invalid null byte.",
                )
            })?;

        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        if state.projection_poisoned {
            return Err(adapter_error(
                Status::GenericFailure,
                "The AppKit tab projection is poisoned after an unverified native mutation.",
            ));
        }
        self.require_exact_native_window()?;
        if revision < state.projection_revision
            || (revision == state.projection_revision
                && (state.projected_tab_ids != tab_ids
                    || state.projected_tab_fingerprints != tab_fingerprints
                    || state.projected_active_tab_id != active_tab_id))
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit tab projection revision is stale or conflicts with its prior receipt.",
            ));
        }
        if revision == state.projection_revision {
            if !projection_matches(controller, &order_json, active_tab_id_c.as_deref())?
                || !phases_match(controller, &phases_json)?
            {
                state.projection_poisoned = true;
                return Err(projection_readback_error());
            }
            return Ok(projection_receipt(revision, &tab_ids, active_tab_id));
        }

        state.projection_poisoned = true;
        state.failed_projected_tab_ids.clone_from(&tab_ids);
        for tab in &tabs {
            ensure_projected_tab(controller, &self.identity, tab)?;
        }
        for stale_tab_id in state
            .projected_tab_ids
            .iter()
            .filter(|tab_id| !tab_ids.contains(tab_id))
        {
            let stale_tab_id = CString::new(stale_tab_id.as_str()).map_err(|_| {
                adapter_error(
                    Status::GenericFailure,
                    "A prior AppKit tab projection identity is malformed.",
                )
            })?;
            remove_projected_tab(controller, &stale_tab_id, active_tab_id_c.as_deref())?;
        }
        if !commit_projected_tabs(controller, &order_json, active_tab_id_c.as_deref())?
            || !phases_match(controller, &phases_json)?
        {
            return Err(projection_readback_error());
        }
        state.projection_revision = revision;
        state.projected_tab_ids.clone_from(&tab_ids);
        state
            .projected_tab_fingerprints
            .clone_from(&tab_fingerprints);
        state.projected_active_tab_id.clone_from(&active_tab_id);
        state.projection_poisoned = false;
        state.failed_projected_tab_ids.clear();
        Ok(projection_receipt(revision, &tab_ids, active_tab_id))
    }

    #[napi(js_name = "restoreLastVerifiedTabProjection")]
    pub fn restore_last_verified_tab_projection(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<AppKitRuntimeTabProjectionReceipt> {
        self.require_identity(&expected)?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;

        let active_tab_id = state.projected_active_tab_id.clone();
        let restored_tabs = validate_tab_projection(
            state
                .projected_tab_fingerprints
                .iter()
                .map(|tab| AppKitRuntimeTabProjection {
                    tab_id: tab.tab_id.clone(),
                    name: tab.name.clone(),
                    phase: tab.phase.clone(),
                    tab_type: tab.tab_type.clone(),
                    workspace_template: tab.workspace_template.clone(),
                })
                .collect(),
            active_tab_id.as_deref(),
        )?;
        let restored_ids = restored_tabs
            .iter()
            .map(|tab| tab.tab_id.clone())
            .collect::<Vec<_>>();
        let order_json = CString::new(serde_json::to_vec(&restored_ids).map_err(|_| {
            adapter_error(
                Status::InvalidArg,
                "The verified AppKit tab projection could not be serialized.",
            )
        })?)
        .map_err(|_| malformed_projection_error())?;
        let phases_json = tab_phases_json(&restored_tabs)?;
        let active_tab_id_c = active_tab_id
            .as_deref()
            .map(CString::new)
            .transpose()
            .map_err(|_| malformed_projection_error())?;

        if !state.projection_poisoned {
            if !projection_matches(controller, &order_json, active_tab_id_c.as_deref())?
                || !phases_match(controller, &phases_json)?
            {
                state.projection_poisoned = true;
                return Err(projection_readback_error());
            }
            return Ok(projection_receipt(
                state.projection_revision,
                &restored_ids,
                active_tab_id,
            ));
        }

        for tab in &restored_tabs {
            ensure_projected_tab(controller, &self.identity, tab)?;
        }
        for failed_tab_id in state
            .failed_projected_tab_ids
            .iter()
            .filter(|tab_id| !restored_ids.contains(tab_id))
        {
            let failed_tab_id =
                CString::new(failed_tab_id.as_str()).map_err(|_| malformed_projection_error())?;
            remove_projected_tab(controller, &failed_tab_id, active_tab_id_c.as_deref())?;
        }
        if !commit_projected_tabs(controller, &order_json, active_tab_id_c.as_deref())?
            || !phases_match(controller, &phases_json)?
        {
            return Err(projection_readback_error());
        }
        state.projection_poisoned = false;
        state.failed_projected_tab_ids.clear();
        Ok(projection_receipt(
            state.projection_revision,
            &restored_ids,
            active_tab_id,
        ))
    }

    #[napi(js_name = "applyWorkspaceDividerProjection")]
    pub fn apply_workspace_divider_projection(
        &self,
        expected: AppKitRuntimeHostIdentity,
        projection_revision: String,
        content_bounds: AppKitWorkspaceDividerBounds,
        dividers: Vec<AppKitRuntimeWorkspaceDividerProjection>,
    ) -> Result<AppKitRuntimeWorkspaceDividerProjectionReceipt> {
        self.require_identity(&expected)?;
        let revision = validate_projection_revision(&projection_revision)?;
        let projection = validate_workspace_divider_projection(content_bounds, dividers)?;
        let projection_json = workspace_divider_projection_json(&projection)?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        if state.workspace_divider_projection_poisoned {
            return Err(adapter_error(
                Status::GenericFailure,
                "The AppKit workspace-divider projection is poisoned after an unverified native mutation.",
            ));
        }
        if revision < state.workspace_divider_projection_revision
            || (revision == state.workspace_divider_projection_revision
                && state.workspace_divider_projection != projection)
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit workspace-divider projection revision is stale or conflicting.",
            ));
        }
        if revision == state.workspace_divider_projection_revision {
            if !workspace_divider_projection_matches(controller, &projection_json)? {
                state.workspace_divider_projection_poisoned = true;
                return Err(workspace_divider_projection_readback_error());
            }
            return Ok(workspace_divider_projection_receipt(revision, &projection));
        }

        let previous_json = (state.workspace_divider_projection_revision > 0)
            .then(|| workspace_divider_projection_json(&state.workspace_divider_projection))
            .transpose()?;
        state.workspace_divider_projection_poisoned = true;
        let applied = apply_workspace_divider_projection(controller, &projection_json)?
            && workspace_divider_projection_matches(controller, &projection_json)?;
        if !applied {
            let restored = previous_json.as_ref().is_some_and(|prior| {
                apply_workspace_divider_projection(controller, prior).unwrap_or(false)
                    && workspace_divider_projection_matches(controller, prior).unwrap_or(false)
            });
            if restored {
                state.workspace_divider_projection_poisoned = false;
            }
            return Err(workspace_divider_projection_readback_error());
        }
        state.workspace_divider_projection_revision = revision;
        state.workspace_divider_projection = projection.clone();
        state.workspace_divider_projection_poisoned = false;
        Ok(workspace_divider_projection_receipt(revision, &projection))
    }

    #[napi(js_name = "restoreLastVerifiedWorkspaceDividerProjection")]
    pub fn restore_last_verified_workspace_divider_projection(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<AppKitRuntimeWorkspaceDividerProjectionReceipt> {
        self.require_identity(&expected)?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        if state.workspace_divider_projection_revision == 0 {
            return Err(adapter_error(
                Status::InvalidArg,
                "No verified AppKit workspace-divider projection is available.",
            ));
        }
        let projection = state.workspace_divider_projection.clone();
        let projection_json = workspace_divider_projection_json(&projection)?;
        if !apply_workspace_divider_projection(controller, &projection_json)?
            || !workspace_divider_projection_matches(controller, &projection_json)?
        {
            state.workspace_divider_projection_poisoned = true;
            return Err(workspace_divider_projection_readback_error());
        }
        state.workspace_divider_projection_poisoned = false;
        Ok(workspace_divider_projection_receipt(
            state.workspace_divider_projection_revision,
            &projection,
        ))
    }

    #[napi(js_name = "prepareFullscreen")]
    pub fn prepare_fullscreen(
        &self,
        expected: AppKitRuntimeHostIdentity,
        fullscreen: bool,
    ) -> Result<()> {
        self.with_live_controller(&expected, |controller| {
            prepare_fullscreen(controller, fullscreen)
        })
    }

    #[napi(js_name = "setFullscreenPolicy")]
    pub fn set_fullscreen_policy(
        &self,
        expected: AppKitRuntimeHostIdentity,
        always_show: bool,
    ) -> Result<()> {
        self.with_live_controller(&expected, |controller| {
            set_fullscreen_policy(controller, always_show)
        })
    }

    #[napi(js_name = "setTabCloseButtonsHidden")]
    pub fn set_tab_close_buttons_hidden(
        &self,
        expected: AppKitRuntimeHostIdentity,
        always_hide: bool,
    ) -> Result<()> {
        self.with_live_controller(&expected, |controller| {
            set_tab_close_buttons_hidden(controller, always_hide)
        })
    }

    #[napi(js_name = "setRevealLocked")]
    pub fn set_reveal_locked(
        &self,
        expected: AppKitRuntimeHostIdentity,
        locked: bool,
    ) -> Result<()> {
        self.with_live_controller(&expected, |controller| {
            set_reveal_locked(controller, locked)
        })
    }

    #[napi(js_name = "setWindowName")]
    pub fn set_window_name(
        &self,
        expected: AppKitRuntimeHostIdentity,
        window_name: Option<String>,
    ) -> Result<()> {
        let window_name = window_name
            .map(|value| {
                if value.is_empty()
                    || value.len() > 512
                    || value.trim() != value
                    || value.chars().any(char::is_control)
                {
                    return Err(adapter_error(
                        Status::InvalidArg,
                        "The AppKit runtime-window name is invalid.",
                    ));
                }
                CString::new(value).map_err(|_| {
                    adapter_error(
                        Status::InvalidArg,
                        "The AppKit runtime-window name contains a null byte.",
                    )
                })
            })
            .transpose()?;
        self.with_live_controller(&expected, |controller| {
            set_window_name(controller, window_name.as_deref())
        })
    }

    #[napi(js_name = "snapshotContentLayout")]
    pub fn snapshot_content_layout(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<AppKitRuntimeContentLayout> {
        self.require_identity(&expected)?;
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        self.require_exact_native_window()?;
        let layout = read_content_layout(controller)?;
        Ok(AppKitRuntimeContentLayout {
            height_inset: layout.height_inset,
            y_offset: layout.y_offset,
            valid: layout.valid,
        })
    }

    /// Fences callbacks before destroying the exact controller. A repeated
    /// destroy for the same identity is idempotent and returns false.
    #[napi]
    pub fn destroy(&self, expected: AppKitRuntimeHostIdentity) -> Result<bool> {
        self.require_identity(&expected)?;
        let mut state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let Some(controller) = state.controller else {
            return Ok(false);
        };
        let controller =
            NonNull::new(controller as *mut c_void).ok_or_else(host_destroyed_error)?;
        ensure_appkit_main_thread()?;
        self.require_exact_native_window()?;
        if let Some(context) = state.context.as_ref() {
            context.accepting.store(false, Ordering::Release);
        }
        destroy_controller(controller)?;
        state.controller = None;
        state.context = None;
        Ok(true)
    }

    #[napi(getter, js_name = "logicalWindowId")]
    pub fn logical_window_id(&self) -> String {
        self.identity.logical_window_id.clone()
    }

    #[napi(getter, js_name = "launchGeneration")]
    pub fn launch_generation(&self) -> String {
        self.identity.launch_generation.clone()
    }

    #[napi(getter, js_name = "nativeGeneration")]
    pub fn native_generation(&self) -> u32 {
        self.identity.native_generation
    }

    fn require_identity(&self, expected: &AppKitRuntimeHostIdentity) -> Result<()> {
        if self.identity.matches(expected) {
            Ok(())
        } else {
            Err(adapter_error(
                Status::InvalidArg,
                "The AppKit host identity or generation is stale.",
            ))
        }
    }

    fn with_live_controller<T>(
        &self,
        expected: &AppKitRuntimeHostIdentity,
        operation: impl FnOnce(NonNull<c_void>) -> Result<T>,
    ) -> Result<T> {
        self.require_identity(expected)?;
        let state = self.state.lock().map_err(|_| state_poisoned_error())?;
        let controller = controller_pointer(&state)?;
        state
            .context
            .as_ref()
            .ok_or_else(host_destroyed_error)?
            .ensure_healthy()?;
        ensure_appkit_main_thread()?;
        self.require_exact_native_window()?;
        operation(controller)
    }

    fn require_exact_native_window(&self) -> Result<()> {
        let native_view =
            NonNull::new(self.native_view as *mut c_void).ok_or_else(malformed_handle_error)?;
        let window = resolve_native_window(native_view)?;
        if window.as_ptr() as usize != self.native_window {
            return Err(adapter_error(
                Status::InvalidArg,
                "The Electron NSView now belongs to a different AppKit window.",
            ));
        }
        Ok(())
    }
}

// Keep test-only native controls in a separately generated N-API surface. The
// napi macro expands every method in an impl as a unit, so method-level cfg
// attributes alone can leave callback references in production builds.
#[cfg(feature = "desktop-e2e")]
#[napi]
impl NativeAppKitRuntimeHost {
    #[napi(js_name = "desktopE2eAccessibilityPress")]
    pub fn desktop_e2e_accessibility_press(
        &self,
        expected: AppKitRuntimeHostIdentity,
        tab_id: String,
    ) -> Result<bool> {
        validate_identifier(&tab_id, "tab")?;
        let tab_id = CString::new(tab_id).map_err(|_| malformed_projection_error())?;
        self.with_live_controller(&expected, |controller| {
            accessibility_press(controller, &tab_id)
        })
    }

    #[napi(js_name = "desktopE2eAccessibilityClose")]
    pub fn desktop_e2e_accessibility_close(
        &self,
        expected: AppKitRuntimeHostIdentity,
        tab_id: String,
    ) -> Result<bool> {
        validate_identifier(&tab_id, "tab")?;
        let tab_id = CString::new(tab_id).map_err(|_| malformed_projection_error())?;
        self.with_live_controller(&expected, |controller| {
            accessibility_close(controller, &tab_id)
        })
    }

    #[napi(js_name = "desktopE2eAccessibilityShowMenu")]
    pub fn desktop_e2e_accessibility_show_menu(
        &self,
        expected: AppKitRuntimeHostIdentity,
        tab_id: String,
    ) -> Result<bool> {
        validate_identifier(&tab_id, "tab")?;
        let tab_id = CString::new(tab_id).map_err(|_| malformed_projection_error())?;
        self.with_live_controller(&expected, |controller| {
            desktop_e2e_accessibility_show_menu(controller, &tab_id)
        })
    }

    #[napi(js_name = "desktopE2eTitlebarGeometry")]
    pub fn desktop_e2e_titlebar_geometry(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<AppKitDesktopE2ETitlebarGeometry> {
        self.with_live_controller(&expected, desktop_e2e_titlebar_geometry)
    }

    #[napi(js_name = "desktopE2eTabAnchor")]
    pub fn desktop_e2e_tab_anchor(
        &self,
        expected: AppKitRuntimeHostIdentity,
        tab_id: String,
        grab_ratio_x: f64,
        grab_ratio_y: f64,
    ) -> Result<AppKitDesktopE2ETabAnchor> {
        validate_identifier(&tab_id, "tab")?;
        let tab_id = CString::new(tab_id).map_err(|_| malformed_projection_error())?;
        self.with_live_controller(&expected, |controller| {
            desktop_e2e_tab_anchor(controller, &tab_id, grab_ratio_x, grab_ratio_y)
        })
    }

    #[napi(js_name = "desktopE2eFullscreenToolbarState")]
    pub fn desktop_e2e_fullscreen_toolbar_state(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<AppKitDesktopE2EFullscreenToolbarState> {
        self.with_live_controller(&expected, desktop_e2e_fullscreen_toolbar_state)
    }

    #[napi(js_name = "desktopE2eStatusPresentation")]
    pub fn desktop_e2e_status_presentation(
        &self,
        expected: AppKitRuntimeHostIdentity,
    ) -> Result<i32> {
        self.with_live_controller(&expected, desktop_e2e_status_presentation)
    }
}

impl Drop for NativeAppKitRuntimeHost {
    fn drop(&mut self) {
        let Ok(state) = self.state.get_mut() else {
            return;
        };
        let Some(controller) = state.controller.take() else {
            return;
        };
        let Some(controller) = NonNull::new(controller as *mut c_void) else {
            return;
        };
        if let Some(context) = state.context.as_ref() {
            context.accepting.store(false, Ordering::Release);
        }
        if rion_appkit::runtime_tabs_is_main_thread() {
            let _ = destroy_controller(controller);
            state.context = None;
        } else if let Some(context) = state.context.take() {
            // Finalization must never dereference AppKit off-main. Keep the
            // callback context alive with the intentionally leaked controller;
            // explicit Electron-main teardown is the required product path.
            std::mem::forget(context);
        }
    }
}

#[napi(js_name = "attachAppKitRuntimeHost")]
pub fn attach_appkit_runtime_host(
    native_view_handle: Buffer,
    identity: AppKitRuntimeHostIdentity,
    callback: Function<'_, String, ()>,
) -> Result<NativeAppKitRuntimeHost> {
    let identity = ValidatedHostIdentity::validate(identity)?;
    ensure_appkit_main_thread()?;
    if rion_appkit::runtime_tabs_abi_version() != rion_appkit::RUNTIME_TABS_ABI_VERSION {
        return Err(adapter_error(
            Status::GenericFailure,
            "The linked AppKit runtime-tabs ABI does not match the Node adapter.",
        ));
    }
    let native_view = decode_native_view_handle(native_view_handle.as_ref())?;
    let native_window = resolve_native_window(native_view)?;
    let callback = callback
        .build_threadsafe_function::<String>()
        .max_queue_size::<APPKIT_EVENT_QUEUE_CAPACITY>()
        .build_callback(|context| Ok(context.value))?;
    let mut context = Box::new(AppKitCallbackContext {
        accepting: AtomicBool::new(true),
        failure: AtomicU8::new(CallbackFailure::Healthy as u8),
        identity: identity.clone(),
        callback,
    });
    let context_pointer = NonNull::from(context.as_mut()).cast::<c_void>();
    let identifier = CString::new(identity.logical_window_id.as_str()).map_err(|_| {
        adapter_error(
            Status::InvalidArg,
            "The logical AppKit window identifier contains a null byte.",
        )
    })?;
    let controller = create_controller(
        native_window,
        &identifier,
        context_pointer,
        appkit_action_callback,
        appkit_layout_callback,
    )?;
    if let Err(error) = read_content_layout(controller) {
        context.accepting.store(false, Ordering::Release);
        let _ = destroy_controller(controller);
        return Err(error);
    }
    Ok(NativeAppKitRuntimeHost {
        identity,
        native_view: native_view.as_ptr() as usize,
        native_window: native_window.as_ptr() as usize,
        state: Mutex::new(NativeHostState {
            context: Some(context),
            controller: Some(controller.as_ptr() as usize),
            projection_revision: 0,
            projected_tab_ids: Vec::new(),
            projected_tab_fingerprints: Vec::new(),
            projected_active_tab_id: None,
            projection_poisoned: false,
            failed_projected_tab_ids: Vec::new(),
            workspace_divider_projection_revision: 0,
            workspace_divider_projection: WorkspaceDividerProjectionFingerprint {
                content_bounds: WorkspaceDividerBoundsFingerprint {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                dividers: Vec::new(),
            },
            workspace_divider_projection_poisoned: false,
            next_input_capture_sequence: 0,
            pending_input_capture: None,
            input_surfaces: HashMap::new(),
        }),
    })
}

fn validate_projection_revision(value: &str) -> Result<u64> {
    let revision = value.parse::<u64>().map_err(|_| {
        adapter_error(
            Status::InvalidArg,
            "The AppKit tab projection revision must be a canonical positive integer.",
        )
    })?;
    if revision == 0 || revision.to_string() != value {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit tab projection revision must be a canonical positive integer.",
        ));
    }
    Ok(revision)
}

fn validate_tab_projection(
    tabs: Vec<AppKitRuntimeTabProjection>,
    active_tab_id: Option<&str>,
) -> Result<Vec<ValidatedTabProjection>> {
    if tabs.len() > MAX_PROJECTED_TABS {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit tab projection exceeds the bounded native tab count.",
        ));
    }
    let mut seen = std::collections::HashSet::with_capacity(tabs.len());
    let mut validated = Vec::with_capacity(tabs.len());
    for tab in tabs {
        validate_identifier(&tab.tab_id, "tab")?;
        if !seen.insert(tab.tab_id.clone())
            || tab.name.is_empty()
            || tab.name.len() > 512
            || tab.name.chars().any(char::is_control)
            || !matches!(
                tab.phase.as_str(),
                "dormant"
                    | "activating"
                    | "attaching"
                    | "loading"
                    | "ready"
                    | "degraded"
                    | "failed"
            )
            || !matches!(tab.tab_type.as_str(), "role" | "workspace" | "popup")
            || tab.workspace_template.as_ref().is_some_and(|template| {
                template.is_empty()
                    || template.len() > 128
                    || template.chars().any(char::is_control)
            })
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit tab projection contains malformed or duplicate metadata.",
            ));
        }
        #[cfg(target_os = "macos")]
        let tab_id_c =
            CString::new(tab.tab_id.as_str()).map_err(|_| malformed_projection_error())?;
        #[cfg(target_os = "macos")]
        let name_c = CString::new(tab.name.as_str()).map_err(|_| malformed_projection_error())?;
        #[cfg(target_os = "macos")]
        let phase_c = CString::new(tab.phase.as_str()).map_err(|_| malformed_projection_error())?;
        #[cfg(target_os = "macos")]
        let tab_type_c =
            CString::new(tab.tab_type.as_str()).map_err(|_| malformed_projection_error())?;
        #[cfg(target_os = "macos")]
        let workspace_template_c = tab
            .workspace_template
            .as_deref()
            .map(CString::new)
            .transpose()
            .map_err(|_| malformed_projection_error())?;
        validated.push(ValidatedTabProjection {
            fingerprint: TabProjectionFingerprint {
                tab_id: tab.tab_id.clone(),
                name: tab.name,
                phase: tab.phase,
                tab_type: tab.tab_type,
                workspace_template: tab.workspace_template,
            },
            tab_id: tab.tab_id,
            #[cfg(target_os = "macos")]
            tab_id_c,
            #[cfg(target_os = "macos")]
            name_c,
            #[cfg(target_os = "macos")]
            phase_c,
            #[cfg(target_os = "macos")]
            tab_type_c,
            #[cfg(target_os = "macos")]
            workspace_template_c,
        });
    }
    if active_tab_id.is_some_and(|active| !seen.contains(active))
        || (active_tab_id.is_none() && !validated.is_empty())
    {
        return Err(adapter_error(
            Status::InvalidArg,
            "The active AppKit tab must identify one exact projected tab.",
        ));
    }
    Ok(validated)
}

fn tab_phases_json(tabs: &[ValidatedTabProjection]) -> Result<CString> {
    let phases = tabs
        .iter()
        .map(|tab| (tab.tab_id.as_str(), tab.fingerprint.phase.as_str()))
        .collect::<std::collections::BTreeMap<_, _>>();
    CString::new(serde_json::to_vec(&phases).map_err(|_| malformed_projection_error())?)
        .map_err(|_| malformed_projection_error())
}

fn workspace_divider_bounds_fingerprint(
    bounds: AppKitWorkspaceDividerBounds,
    field: &str,
) -> Result<WorkspaceDividerBoundsFingerprint> {
    if bounds.x < 0
        || bounds.y < 0
        || bounds.width < 1
        || bounds.height < 1
        || bounds.x.checked_add(bounds.width).is_none()
        || bounds.y.checked_add(bounds.height).is_none()
    {
        return Err(adapter_error(
            Status::InvalidArg,
            format!("The AppKit {field} bounds are invalid."),
        ));
    }
    Ok(WorkspaceDividerBoundsFingerprint {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
    })
}

fn validate_workspace_divider_projection(
    content_bounds: AppKitWorkspaceDividerBounds,
    dividers: Vec<AppKitRuntimeWorkspaceDividerProjection>,
) -> Result<WorkspaceDividerProjectionFingerprint> {
    if dividers.len() > MAX_PROJECTED_WORKSPACE_DIVIDERS {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit workspace-divider projection exceeds its native bound.",
        ));
    }
    let content_bounds = workspace_divider_bounds_fingerprint(content_bounds, "content")?;
    let content_max_x = content_bounds
        .x
        .checked_add(content_bounds.width)
        .ok_or_else(malformed_projection_error)?;
    let content_max_y = content_bounds
        .y
        .checked_add(content_bounds.height)
        .ok_or_else(malformed_projection_error)?;
    let mut seen = std::collections::HashSet::with_capacity(dividers.len());
    let mut validated = Vec::with_capacity(dividers.len());
    for divider in dividers {
        validate_identifier(&divider.tab_id, "workspace-divider tab")?;
        validate_identifier(
            &divider.attempt_generation,
            "workspace-divider attempt generation",
        )?;
        if !matches!(divider.axis.as_str(), "horizontal" | "vertical")
            || !seen.insert((
                divider.tab_id.clone(),
                divider.attempt_generation.clone(),
                divider.divider_index,
            ))
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit workspace-divider identity is malformed or duplicated.",
            ));
        }
        let bounds = workspace_divider_bounds_fingerprint(divider.bounds, "divider")?;
        if bounds.x < content_bounds.x
            || bounds.y < content_bounds.y
            || bounds
                .x
                .checked_add(bounds.width)
                .is_none_or(|x| x > content_max_x)
            || bounds
                .y
                .checked_add(bounds.height)
                .is_none_or(|y| y > content_max_y)
        {
            return Err(adapter_error(
                Status::InvalidArg,
                "The AppKit workspace-divider hit rect escapes its exact content host.",
            ));
        }
        validated.push(WorkspaceDividerFingerprint {
            tab_id: divider.tab_id,
            attempt_generation: divider.attempt_generation,
            divider_index: divider.divider_index,
            axis: divider.axis,
            bounds,
            visible: divider.visible,
        });
    }
    Ok(WorkspaceDividerProjectionFingerprint {
        content_bounds,
        dividers: validated,
    })
}

fn workspace_divider_projection_json(
    projection: &WorkspaceDividerProjectionFingerprint,
) -> Result<CString> {
    let bounds_json = |bounds: &WorkspaceDividerBoundsFingerprint| {
        serde_json::json!({
            "x": bounds.x,
            "y": bounds.y,
            "width": bounds.width,
            "height": bounds.height,
        })
    };
    let value = serde_json::json!({
        "contentBounds": bounds_json(&projection.content_bounds),
        "dividers": projection.dividers.iter().map(|divider| serde_json::json!({
            "tabId": divider.tab_id,
            "attemptGeneration": divider.attempt_generation,
            "dividerIndex": divider.divider_index,
            "axis": divider.axis,
            "bounds": bounds_json(&divider.bounds),
            "visible": divider.visible,
        })).collect::<Vec<_>>(),
    });
    let serialized = serde_json::to_vec(&value).map_err(|_| malformed_projection_error())?;
    if serialized.len() > MAX_NATIVE_JSON_BYTES {
        return Err(adapter_error(
            Status::InvalidArg,
            "The AppKit workspace-divider projection is oversized.",
        ));
    }
    CString::new(serialized).map_err(|_| malformed_projection_error())
}

fn workspace_divider_projection_receipt(
    revision: u64,
    projection: &WorkspaceDividerProjectionFingerprint,
) -> AppKitRuntimeWorkspaceDividerProjectionReceipt {
    AppKitRuntimeWorkspaceDividerProjectionReceipt {
        projection_revision: revision.to_string(),
        divider_count: u32::try_from(projection.dividers.len())
            .expect("bounded AppKit workspace-divider projection"),
        content_bounds: AppKitWorkspaceDividerBounds {
            x: projection.content_bounds.x,
            y: projection.content_bounds.y,
            width: projection.content_bounds.width,
            height: projection.content_bounds.height,
        },
    }
}

fn projection_receipt(
    revision: u64,
    tab_ids: &[String],
    active_tab_id: Option<String>,
) -> AppKitRuntimeTabProjectionReceipt {
    AppKitRuntimeTabProjectionReceipt {
        projection_revision: revision.to_string(),
        tab_count: u32::try_from(tab_ids.len()).expect("bounded AppKit tab projection"),
        active_tab_id,
    }
}

unsafe extern "C" fn appkit_layout_callback(
    raw_context: *mut c_void,
    height_inset: f64,
    y_offset: f64,
    valid: bool,
) {
    // SAFETY: the native controller passes back the exact context retained by
    // `attach_appkit_runtime_host` for the duration of this callback.
    let Some(context) = (unsafe { callback_context(raw_context) }) else {
        return;
    };
    let emitted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !valid
            || !height_inset.is_finite()
            || !y_offset.is_finite()
            || height_inset < 0.0
            || y_offset < 0.0
            || y_offset > height_inset
        {
            context.fail(CallbackFailure::InvalidNativeEvent);
            return;
        }
        context.emit(serde_json::json!({
            "type": "layout",
            "identity": context.identity.json(),
            "layout": {
                "heightInset": height_inset,
                "yOffset": y_offset,
                "valid": true,
            },
        }));
    }));
    if emitted.is_err() {
        context.fail(CallbackFailure::PanicContained);
    }
}

#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn appkit_action_callback(
    raw_context: *mut c_void,
    action_type: *const c_char,
    session_identifier: *const c_char,
    tab_identifier: *const c_char,
    source_window_id: *const c_char,
    target_window_id: *const c_char,
    before_tab_identifier: *const c_char,
    ordered_tab_identifiers_json: *const c_char,
    status_identity_json: *const c_char,
    screen_x: f64,
    screen_y: f64,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
    tab_width: f64,
    tab_height: f64,
    modifier_count: u32,
    cancelled: bool,
    focused: bool,
    minimized: bool,
    visible: bool,
) {
    // SAFETY: the native controller passes back the exact context retained by
    // `attach_appkit_runtime_host` for the duration of this callback.
    let Some(context) = (unsafe { callback_context(raw_context) }) else {
        return;
    };
    let emitted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let event = (|| {
            // SAFETY: every string pointer comes from the native controller and
            // remains valid for this synchronous callback only.
            let action_type = unsafe { required_native_string(action_type) }?;
            Ok::<_, ()>(serde_json::json!({
                "type": "action",
                "identity": context.identity.json(),
                "action": {
                    "type": action_type,
                    "sessionId": unsafe { optional_native_string(session_identifier) }?,
                    "tabId": unsafe { optional_native_string(tab_identifier) }?,
                    "sourceWindowId": unsafe { optional_native_string(source_window_id) }?,
                    "targetWindowId": unsafe { optional_native_string(target_window_id) }?,
                    "beforeTabId": unsafe { optional_native_string(before_tab_identifier) }?,
                    "orderedTabIds": unsafe { optional_native_json(
                        ordered_tab_identifiers_json,
                        serde_json::Value::is_array,
                    ) }?,
                    "statusIdentity": unsafe { optional_native_json(
                        status_identity_json,
                        serde_json::Value::is_object,
                    ) }?,
                    "screenX": finite_number(screen_x),
                    "screenY": finite_number(screen_y),
                    "grabRatioX": finite_number(grab_ratio_x),
                    "grabRatioY": finite_number(grab_ratio_y),
                    "tabWidth": finite_number(tab_width),
                    "tabHeight": finite_number(tab_height),
                    "modifierCount": modifier_count,
                    "cancelled": cancelled,
                    "focused": focused,
                    "minimized": minimized,
                    "visible": visible,
                },
            }))
        })();
        match event {
            Ok(event) => context.emit(event),
            Err(()) => context.fail(CallbackFailure::InvalidNativeEvent),
        }
    }));
    if emitted.is_err() {
        context.fail(CallbackFailure::PanicContained);
    }
}

unsafe fn callback_context<'a>(raw_context: *mut c_void) -> Option<&'a AppKitCallbackContext> {
    let context = NonNull::new(raw_context)?.cast::<AppKitCallbackContext>();
    // SAFETY: the native controller retains this opaque context only until its
    // exact main-thread destroy, while the N-API host owns the backing Box.
    Some(unsafe { context.as_ref() })
}

unsafe fn required_native_string(value: *const c_char) -> std::result::Result<String, ()> {
    // SAFETY: inherited from this helper's callback-lifetime contract.
    unsafe { optional_native_string(value) }?.ok_or(())
}

unsafe fn optional_native_string(value: *const c_char) -> std::result::Result<Option<String>, ()> {
    if value.is_null() {
        return Ok(None);
    }
    // SAFETY: native callbacks provide null-terminated strings valid for the
    // duration of the callback.
    let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
    if bytes.len() > MAX_NATIVE_FIELD_BYTES {
        return Err(());
    }
    std::str::from_utf8(bytes)
        .map(|value| Some(value.to_owned()))
        .map_err(|_| ())
}

unsafe fn optional_native_json(
    value: *const c_char,
    validate: fn(&serde_json::Value) -> bool,
) -> std::result::Result<Option<serde_json::Value>, ()> {
    if value.is_null() {
        return Ok(None);
    }
    // SAFETY: native callbacks provide null-terminated JSON valid for the
    // duration of the callback.
    let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
    if bytes.len() > MAX_NATIVE_JSON_BYTES {
        return Err(());
    }
    let parsed = serde_json::from_slice(bytes).map_err(|_| ())?;
    validate(&parsed).then_some(Some(parsed)).ok_or(())
}

fn finite_number(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

#[cfg(test)]
mod tests;
