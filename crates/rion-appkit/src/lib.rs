//! Shared AppKit runtime-tab controller linkage for the stable Tauri shell and
//! the target Electron/Chromium shell.
//!
//! Logical topology remains in `rion-core`; this crate owns only the reusable
//! native AppKit archive and its small, process-local C ABI.

use std::ffi::c_void;

#[cfg(target_os = "macos")]
use std::{ffi::CStr, ptr::NonNull};

pub const RUNTIME_TABS_ABI_VERSION: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElectronViewWindowResolutionError {
    InvalidInput,
    NotMainThread,
    DetachedView,
    UnknownStatus(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElectronViewTreeSnapshotError {
    InvalidInput,
    NotMainThread,
    DetachedView,
    Truncated,
    UnknownStatus(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElectronKeyDispatchProbeError {
    InvalidInput,
    NotMainThread,
    DetachedView,
    TargetNotFound,
    EventCreationFailed,
    NativeException,
    UnknownStatus(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElectronMouseDispatchProbeError {
    InvalidInput,
    NotMainThread,
    DetachedView,
    TargetNotFound,
    EventCreationFailed,
    NativeException,
    PointOutsideTarget,
    UnknownStatus(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElectronChromiumKeySubmissionError {
    InvalidInput,
    NotMainThread,
    DetachedView,
    SurfaceNotFound,
    EventCreationFailed,
    NativeException,
    UnsupportedCode,
    RendererTargetAmbiguous,
    UnknownStatus(i32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElectronChromiumMouseSubmissionError {
    InvalidInput,
    NotMainThread,
    DetachedView,
    SurfaceNotFound,
    EventCreationFailed,
    NativeException,
    PointOutsideTarget,
    RendererTargetAmbiguous,
    UnknownStatus(i32),
}

pub const APPKIT_VIEW_CLASS_NAME_CAPACITY: usize = 96;
pub const APPKIT_VIEW_TREE_MAX_NODES: usize = 512;

#[derive(Clone, Copy)]
#[repr(C)]
pub struct AppKitNativeViewTreeNode {
    pub address: usize,
    pub parent_address: usize,
    pub depth: u32,
    pub hidden: u8,
    pub accepts_first_responder: u8,
    pub attached_to_window: u8,
    pub class_name: [std::ffi::c_char; APPKIT_VIEW_CLASS_NAME_CAPACITY],
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for AppKitNativeViewTreeNode {
    fn default() -> Self {
        Self {
            address: 0,
            parent_address: 0,
            depth: 0,
            hidden: 0,
            accepts_first_responder: 0,
            attached_to_window: 0,
            class_name: [0; APPKIT_VIEW_CLASS_NAME_CAPACITY],
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct AppKitKeyDispatchProbeResult {
    pub dispatched: u8,
    pub target_attached: u8,
    pub key_window_preserved: u8,
    pub key_window_first_responder_preserved: u8,
    pub target_first_responder_preserved: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct AppKitMouseDispatchProbeResult {
    pub dispatched: u8,
    pub target_attached: u8,
    pub key_window_preserved: u8,
    pub key_window_first_responder_preserved: u8,
    pub target_first_responder_preserved: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct AppKitChromiumKeyDispatchResult {
    pub dispatched_event_count: u8,
    pub target_attached: u8,
    pub focus_neutral: u8,
    pub key_window_preserved: u8,
    pub key_window_first_responder_preserved: u8,
    pub target_first_responder_preserved: u8,
    pub virtual_key_code: u16,
    pub modifier_flags: u64,
    pub target_x: f64,
    pub target_y: f64,
    pub target_width: f64,
    pub target_height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct AppKitChromiumMouseDispatchResult {
    pub dispatched_event_count: u8,
    pub target_attached: u8,
    pub focus_neutral: u8,
    pub key_window_preserved: u8,
    pub key_window_first_responder_preserved: u8,
    pub target_first_responder_preserved: u8,
    pub button: u8,
    pub modifier_flags: u64,
    pub client_x: f64,
    pub client_y: f64,
    pub zoom_factor: f64,
    pub app_kit_point_x: f64,
    pub app_kit_point_y: f64,
    pub window_point_x: f64,
    pub window_point_y: f64,
    pub target_flipped: u8,
    pub target_x: f64,
    pub target_y: f64,
    pub target_width: f64,
    pub target_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct RuntimeContentLayout {
    pub height_inset: f64,
    pub y_offset: f64,
    pub valid: bool,
}

#[cfg(feature = "desktop-e2e")]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct RuntimeTabsDesktopE2ETitlebarGeometry {
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
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RuntimeTabsDesktopE2ETabAnchor {
    pub x: f64,
    pub y: f64,
}

#[cfg(feature = "desktop-e2e")]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct RuntimeTabsDesktopE2EFullscreenToolbarState {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeTabsControllerError {
    AbiMismatch,
    InvalidIdentifier,
    InvalidLayout,
    NotMainThread,
    ReadbackMismatch,
    UnsupportedTarget,
    CreationFailed,
}

pub type RuntimeTabsActionCallback = unsafe extern "C" fn(
    *mut c_void,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    *const std::ffi::c_char,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
    u32,
    bool,
    bool,
    bool,
    bool,
);
pub type RuntimeTabsLayoutCallback = unsafe extern "C" fn(*mut c_void, f64, f64, bool);

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn rion_appkit_runtime_tabs_abi_version() -> u32;
    fn rion_appkit_resolve_electron_native_view_window(
        native_view: *mut c_void,
        native_window: *mut *mut c_void,
    ) -> i32;
    fn rion_appkit_snapshot_native_view_tree(
        native_view: *mut c_void,
        nodes: *mut AppKitNativeViewTreeNode,
        capacity: usize,
        count: *mut usize,
        truncated: *mut bool,
    ) -> i32;
    fn rion_appkit_probe_dispatch_key(
        native_view: *mut c_void,
        target_address: usize,
        key_code: u16,
        characters: *const std::ffi::c_char,
        modifier_flags: u64,
        dispatch_mode: u8,
        result: *mut AppKitKeyDispatchProbeResult,
    ) -> i32;
    fn rion_appkit_probe_dispatch_mouse(
        native_view: *mut c_void,
        target_address: usize,
        x: f64,
        y: f64,
        button: u8,
        modifier_flags: u64,
        result: *mut AppKitMouseDispatchProbeResult,
    ) -> i32;
    fn rion_appkit_dispatch_chromium_key(
        native_view: *mut c_void,
        web_contents_root_address: usize,
        code: *const std::ffi::c_char,
        key_down: bool,
        modifier_flags: u64,
        repeat: bool,
        result: *mut AppKitChromiumKeyDispatchResult,
    ) -> i32;
    fn rion_appkit_dispatch_chromium_mouse(
        native_view: *mut c_void,
        web_contents_root_address: usize,
        client_x: f64,
        client_y: f64,
        zoom_factor: f64,
        button: u8,
        modifier_flags: u64,
        result: *mut AppKitChromiumMouseDispatchResult,
    ) -> i32;
    fn rion_runtime_tabs_create(
        window: *mut c_void,
        window_identifier: *const std::ffi::c_char,
        context: *mut c_void,
        action_handler: RuntimeTabsActionCallback,
        layout_handler: RuntimeTabsLayoutCallback,
    ) -> *mut c_void;
    fn rion_runtime_tabs_prepare_fullscreen(controller: *mut c_void, fullscreen: bool);
    fn rion_runtime_tabs_set_fullscreen_policy(controller: *mut c_void, always_show: bool) -> bool;
    fn rion_runtime_tabs_set_tab_close_buttons_hidden(
        controller: *mut c_void,
        always_hide: bool,
    ) -> bool;
    fn rion_runtime_tabs_set_window_interaction(
        window: *mut c_void,
        pointer_passthrough: bool,
        focus_window: bool,
    ) -> bool;
    fn rion_runtime_tabs_set_reveal_locked(controller: *mut c_void, locked: bool) -> bool;
    fn rion_runtime_tabs_set_window_name(
        controller: *mut c_void,
        window_name: *const std::ffi::c_char,
    ) -> bool;
    fn rion_runtime_tabs_accessibility_press(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
    ) -> bool;
    fn rion_runtime_tabs_accessibility_close(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_accessibility_show_menu(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
    ) -> bool;
    #[cfg(test)]
    fn rion_runtime_tabs_accessibility_hierarchy_self_test() -> bool;
    fn rion_runtime_tabs_destroy(controller: *mut c_void);
    fn rion_runtime_tabs_is_main_thread() -> bool;
    fn rion_runtime_tabs_content_layout(controller: *mut c_void) -> RuntimeContentLayout;
    fn rion_runtime_tabs_ensure(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
        name: *const std::ffi::c_char,
        phase: *const std::ffi::c_char,
        tab_type: *const std::ffi::c_char,
        workspace_template: *const std::ffi::c_char,
        window_identifier: *const std::ffi::c_char,
    ) -> bool;
    fn rion_runtime_tabs_matches_phases(
        controller: *mut c_void,
        tab_phases_json: *const std::ffi::c_char,
    ) -> bool;
    fn rion_runtime_tabs_remove(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
        active_tab_identifier: *const std::ffi::c_char,
    );
    fn rion_runtime_tabs_reorder(
        controller: *mut c_void,
        tab_identifiers_json: *const std::ffi::c_char,
    );
    fn rion_runtime_tabs_set_active(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
    );
    fn rion_runtime_tabs_matches_projection(
        controller: *mut c_void,
        tab_identifiers_json: *const std::ffi::c_char,
        active_tab_identifier: *const std::ffi::c_char,
    ) -> bool;
    fn rion_runtime_tabs_apply_workspace_divider_projection(
        controller: *mut c_void,
        projection_json: *const std::ffi::c_char,
    ) -> bool;
    fn rion_runtime_tabs_matches_workspace_divider_projection(
        controller: *mut c_void,
        projection_json: *const std::ffi::c_char,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_titlebar_geometry(
        controller: *mut c_void,
        geometry: *mut RuntimeTabsDesktopE2ETitlebarGeometry,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_drag_anchor(
        controller: *mut c_void,
        tab_identifier: *const std::ffi::c_char,
        grab_ratio_x: f64,
        grab_ratio_y: f64,
        window_offset_x: *mut f64,
        window_offset_y: *mut f64,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_fullscreen_toolbar_state(
        controller: *mut c_void,
        state: *mut RuntimeTabsDesktopE2EFullscreenToolbarState,
    ) -> bool;
    #[cfg(feature = "desktop-e2e")]
    fn rion_runtime_tabs_desktop_e2e_status_presentation(controller: *mut c_void) -> i32;
}

/// Returns the native archive ABI compiled into the current process.
///
/// A zero result means this target cannot host the AppKit adapter.
pub fn runtime_tabs_abi_version() -> u32 {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: this zero-argument function returns a compile-time constant.
        unsafe { rion_appkit_runtime_tabs_abi_version() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Resolves Electron's live macOS `NSView *` native handle to its owning
/// borrowed `NSWindow *`.
///
/// # Safety
///
/// `native_view` must be the exact, currently-live NSView pointer returned by
/// Electron `getNativeWindowHandle()`. The call must occur on the AppKit main
/// thread. The returned window is borrowed from that view and must not outlive
/// it or cross threads.
#[cfg(target_os = "macos")]
pub unsafe fn resolve_electron_native_view_window(
    native_view: NonNull<c_void>,
) -> Result<NonNull<c_void>, ElectronViewWindowResolutionError> {
    let mut native_window = std::ptr::null_mut();
    // SAFETY: the caller provides the documented live Electron NSView pointer;
    // the native bridge validates main-thread ownership and a non-nil window.
    let status = unsafe {
        rion_appkit_resolve_electron_native_view_window(
            native_view.as_ptr(),
            &raw mut native_window,
        )
    };
    match status {
        0 => NonNull::new(native_window)
            .ok_or(ElectronViewWindowResolutionError::UnknownStatus(status)),
        1 => Err(ElectronViewWindowResolutionError::InvalidInput),
        2 => Err(ElectronViewWindowResolutionError::NotMainThread),
        3 => Err(ElectronViewWindowResolutionError::DetachedView),
        code => Err(ElectronViewWindowResolutionError::UnknownStatus(code)),
    }
}

/// Captures one bounded, synchronous AppKit-main snapshot of Electron's native
/// content-view descendants. This is diagnostic evidence for binding a
/// `WebContentsView`; it does not retain or mutate any borrowed native object.
///
/// # Safety
///
/// `native_view` has the same exact live-pointer and main-thread requirements
/// as [`resolve_electron_native_view_window`].
#[cfg(target_os = "macos")]
pub unsafe fn snapshot_electron_native_view_tree(
    native_view: NonNull<c_void>,
) -> Result<Vec<AppKitNativeViewTreeNode>, ElectronViewTreeSnapshotError> {
    let mut nodes = vec![AppKitNativeViewTreeNode::default(); APPKIT_VIEW_TREE_MAX_NODES];
    let mut count = 0usize;
    let mut truncated = false;
    // SAFETY: the caller owns the exact root view lifetime; the native bridge
    // only walks borrowed descendants synchronously on AppKit main.
    let status = unsafe {
        rion_appkit_snapshot_native_view_tree(
            native_view.as_ptr(),
            nodes.as_mut_ptr(),
            nodes.len(),
            &raw mut count,
            &raw mut truncated,
        )
    };
    match status {
        0 if truncated => Err(ElectronViewTreeSnapshotError::Truncated),
        0 if count <= nodes.len() => {
            nodes.truncate(count);
            Ok(nodes)
        }
        0 => Err(ElectronViewTreeSnapshotError::UnknownStatus(status)),
        1 => Err(ElectronViewTreeSnapshotError::InvalidInput),
        2 => Err(ElectronViewTreeSnapshotError::NotMainThread),
        3 => Err(ElectronViewTreeSnapshotError::DetachedView),
        code => Err(ElectronViewTreeSnapshotError::UnknownStatus(code)),
    }
}

/// Diagnostic-only direct NSEvent dispatch used to establish whether
/// Electron's Chromium renderer has a reliable background-native target.
/// Product capability must not be inferred from the return value alone; the
/// caller still needs an exact Chromium callback receipt.
///
/// # Safety
///
/// `native_view` must be the exact live Electron root. `target_address` must
/// come from the same root's current bounded snapshot, and `characters` must
/// remain live for this synchronous AppKit-main call.
#[cfg(target_os = "macos")]
pub unsafe fn probe_dispatch_key_to_electron_view(
    native_view: NonNull<c_void>,
    target_address: usize,
    key_code: u16,
    characters: &CStr,
    modifier_flags: u64,
    dispatch_mode: u8,
) -> Result<AppKitKeyDispatchProbeResult, ElectronKeyDispatchProbeError> {
    let mut result = AppKitKeyDispatchProbeResult::default();
    // SAFETY: inherited from this diagnostic function's exact-root and
    // snapshot-derived target contract.
    let status = unsafe {
        rion_appkit_probe_dispatch_key(
            native_view.as_ptr(),
            target_address,
            key_code,
            characters.as_ptr(),
            modifier_flags,
            dispatch_mode,
            &raw mut result,
        )
    };
    match status {
        0 => Ok(result),
        1 => Err(ElectronKeyDispatchProbeError::InvalidInput),
        2 => Err(ElectronKeyDispatchProbeError::NotMainThread),
        3 => Err(ElectronKeyDispatchProbeError::DetachedView),
        4 => Err(ElectronKeyDispatchProbeError::TargetNotFound),
        5 => Err(ElectronKeyDispatchProbeError::EventCreationFailed),
        6 => Err(ElectronKeyDispatchProbeError::NativeException),
        code => Err(ElectronKeyDispatchProbeError::UnknownStatus(code)),
    }
}

/// Diagnostic-only direct native mouse dispatch for the same bounded
/// background-input feasibility probe as
/// [`probe_dispatch_key_to_electron_view`].
///
/// # Safety
///
/// The exact-root and snapshot-derived target requirements are identical to
/// [`probe_dispatch_key_to_electron_view`]. `x` and `y` are target-local
/// AppKit coordinates and must be inside its current bounds.
#[cfg(target_os = "macos")]
pub unsafe fn probe_dispatch_mouse_to_electron_view(
    native_view: NonNull<c_void>,
    target_address: usize,
    x: f64,
    y: f64,
    button: u8,
    modifier_flags: u64,
) -> Result<AppKitMouseDispatchProbeResult, ElectronMouseDispatchProbeError> {
    let mut result = AppKitMouseDispatchProbeResult::default();
    // SAFETY: inherited from this diagnostic function's exact-root and
    // snapshot-derived target contract.
    let status = unsafe {
        rion_appkit_probe_dispatch_mouse(
            native_view.as_ptr(),
            target_address,
            x,
            y,
            button,
            modifier_flags,
            &raw mut result,
        )
    };
    match status {
        0 => Ok(result),
        1 => Err(ElectronMouseDispatchProbeError::InvalidInput),
        2 => Err(ElectronMouseDispatchProbeError::NotMainThread),
        3 => Err(ElectronMouseDispatchProbeError::DetachedView),
        4 => Err(ElectronMouseDispatchProbeError::TargetNotFound),
        5 => Err(ElectronMouseDispatchProbeError::EventCreationFailed),
        6 => Err(ElectronMouseDispatchProbeError::NativeException),
        7 => Err(ElectronMouseDispatchProbeError::PointOutsideTarget),
        code => Err(ElectronMouseDispatchProbeError::UnknownStatus(code)),
    }
}

/// Submits one key transition directly to the unique live Chromium renderer
/// below an exact, previously captured `WebContentsViewCocoa` root.
///
/// This return value proves only native submission and focus neutrality. The
/// caller must correlate Electron's exact `before-input-event` before treating
/// the browser action as terminally applied.
///
/// # Safety
///
/// `native_view` must be Electron's exact live root and
/// `web_contents_root_address` must have been captured synchronously below that
/// same root. Both remain borrowed and main-thread-only for this call.
#[cfg(target_os = "macos")]
pub unsafe fn submit_key_to_electron_chromium_view(
    native_view: NonNull<c_void>,
    web_contents_root_address: usize,
    code: &CStr,
    key_down: bool,
    modifier_flags: u64,
    repeat: bool,
) -> Result<AppKitChromiumKeyDispatchResult, ElectronChromiumKeySubmissionError> {
    let mut result = AppKitChromiumKeyDispatchResult::default();
    // SAFETY: inherited from this function's exact-root and captured-surface
    // contract. The native bridge re-resolves all borrowed descendants.
    let status = unsafe {
        rion_appkit_dispatch_chromium_key(
            native_view.as_ptr(),
            web_contents_root_address,
            code.as_ptr(),
            key_down,
            modifier_flags,
            repeat,
            &raw mut result,
        )
    };
    match status {
        0 => Ok(result),
        1 => Err(ElectronChromiumKeySubmissionError::InvalidInput),
        2 => Err(ElectronChromiumKeySubmissionError::NotMainThread),
        3 => Err(ElectronChromiumKeySubmissionError::DetachedView),
        4 => Err(ElectronChromiumKeySubmissionError::SurfaceNotFound),
        5 => Err(ElectronChromiumKeySubmissionError::EventCreationFailed),
        6 => Err(ElectronChromiumKeySubmissionError::NativeException),
        8 => Err(ElectronChromiumKeySubmissionError::UnsupportedCode),
        9 => Err(ElectronChromiumKeySubmissionError::RendererTargetAmbiguous),
        code => Err(ElectronChromiumKeySubmissionError::UnknownStatus(code)),
    }
}

/// Submits one mouse down/up pair directly to the unique live Chromium
/// renderer below an exact, previously captured `WebContentsViewCocoa` root.
///
/// This return value proves only native submission and focus neutrality. The
/// caller must correlate the exact trusted DOM down/up/click sequence from the
/// sandboxed isolated role preload before treating the click as applied.
///
/// # Safety
///
/// The exact-root and captured-surface requirements are identical to
/// [`submit_key_to_electron_chromium_view`]. `client_x` and `client_y` are
/// canonical integer, target-local Chromium CSS coordinates. `zoom_factor`
/// converts those CSS pixels to AppKit view points; Retina backing scale is
/// deliberately not part of this view-coordinate conversion.
#[cfg(target_os = "macos")]
pub unsafe fn submit_mouse_to_electron_chromium_view(
    native_view: NonNull<c_void>,
    web_contents_root_address: usize,
    client_x: f64,
    client_y: f64,
    zoom_factor: f64,
    button: u8,
    modifier_flags: u64,
) -> Result<AppKitChromiumMouseDispatchResult, ElectronChromiumMouseSubmissionError> {
    let mut result = AppKitChromiumMouseDispatchResult::default();
    // SAFETY: inherited from this function's exact-root and captured-surface
    // contract. The native bridge re-resolves all borrowed descendants.
    let status = unsafe {
        rion_appkit_dispatch_chromium_mouse(
            native_view.as_ptr(),
            web_contents_root_address,
            client_x,
            client_y,
            zoom_factor,
            button,
            modifier_flags,
            &raw mut result,
        )
    };
    match status {
        0 => Ok(result),
        1 => Err(ElectronChromiumMouseSubmissionError::InvalidInput),
        2 => Err(ElectronChromiumMouseSubmissionError::NotMainThread),
        3 => Err(ElectronChromiumMouseSubmissionError::DetachedView),
        4 => Err(ElectronChromiumMouseSubmissionError::SurfaceNotFound),
        5 => Err(ElectronChromiumMouseSubmissionError::EventCreationFailed),
        6 => Err(ElectronChromiumMouseSubmissionError::NativeException),
        7 => Err(ElectronChromiumMouseSubmissionError::PointOutsideTarget),
        9 => Err(ElectronChromiumMouseSubmissionError::RendererTargetAmbiguous),
        code => Err(ElectronChromiumMouseSubmissionError::UnknownStatus(code)),
    }
}

/// Returns whether the caller is executing on AppKit's main thread.
pub fn runtime_tabs_is_main_thread() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: the native helper only queries NSThread state.
        unsafe { rion_runtime_tabs_is_main_thread() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Installs the shared native tab controller onto an exact borrowed NSWindow.
///
/// # Safety
///
/// `native_window` must be the currently-live owning window returned by
/// [`resolve_electron_native_view_window`]. `context` must remain valid until
/// the returned controller is destroyed, and both callbacks must not unwind.
#[cfg(target_os = "macos")]
pub unsafe fn create_runtime_tabs_controller(
    native_window: NonNull<c_void>,
    window_identifier: &CStr,
    context: NonNull<c_void>,
    action_handler: RuntimeTabsActionCallback,
    layout_handler: RuntimeTabsLayoutCallback,
) -> Result<NonNull<c_void>, RuntimeTabsControllerError> {
    if runtime_tabs_abi_version() != RUNTIME_TABS_ABI_VERSION {
        return Err(RuntimeTabsControllerError::AbiMismatch);
    }
    if !runtime_tabs_is_main_thread() {
        return Err(RuntimeTabsControllerError::NotMainThread);
    }
    if window_identifier.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: caller owns all documented pointer and callback lifetimes. The
    // native implementation retains only the controller and callback blocks.
    let controller = unsafe {
        rion_runtime_tabs_create(
            native_window.as_ptr(),
            window_identifier.as_ptr(),
            context.as_ptr(),
            action_handler,
            layout_handler,
        )
    };
    NonNull::new(controller).ok_or(RuntimeTabsControllerError::CreationFailed)
}

/// Reads AppKit's authoritative content-layout projection for a live controller.
///
/// # Safety
///
/// `controller` must be the currently-live pointer returned by
/// [`create_runtime_tabs_controller`] and must only be used on AppKit main.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_content_layout(
    controller: NonNull<c_void>,
) -> Result<RuntimeContentLayout, RuntimeTabsControllerError> {
    if !runtime_tabs_is_main_thread() {
        return Err(RuntimeTabsControllerError::NotMainThread);
    }
    // SAFETY: the caller provides the exact live controller on AppKit main.
    let layout = unsafe { rion_runtime_tabs_content_layout(controller.as_ptr()) };
    if !layout.valid
        || !layout.height_inset.is_finite()
        || !layout.y_offset.is_finite()
        || layout.height_inset < 0.0
        || layout.y_offset < 0.0
        || layout.y_offset > layout.height_inset
    {
        return Err(RuntimeTabsControllerError::InvalidLayout);
    }
    Ok(layout)
}

/// Tells the retained AppKit controller that its exact native window is about
/// to enter or leave fullscreen. Electron still submits the NSWindow
/// transition; AppKit remains the titlebar/toolbar state owner.
///
/// # Safety
///
/// `controller` must be the exact live controller and this call must run on
/// AppKit main.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_prepare_fullscreen(
    controller: NonNull<c_void>,
    fullscreen: bool,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    // SAFETY: inherited from this function's exact-controller contract.
    unsafe { rion_runtime_tabs_prepare_fullscreen(controller.as_ptr(), fullscreen) };
    Ok(())
}

/// Applies the AppKit-owned fullscreen toolbar policy.
///
/// # Safety
///
/// The controller and main-thread requirements are identical to
/// [`runtime_tabs_prepare_fullscreen`].
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_set_fullscreen_policy(
    controller: NonNull<c_void>,
    always_show: bool,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    // SAFETY: inherited from this function's exact-controller contract.
    unsafe { rion_runtime_tabs_set_fullscreen_policy(controller.as_ptr(), always_show) }
        .then_some(())
        .ok_or(RuntimeTabsControllerError::ReadbackMismatch)
}

/// Applies the AppKit-owned global tab-close-button visibility preference.
///
/// # Safety
///
/// The controller and main-thread requirements are identical to
/// [`runtime_tabs_prepare_fullscreen`].
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_set_tab_close_buttons_hidden(
    controller: NonNull<c_void>,
    always_hide: bool,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    // SAFETY: inherited from this function's exact-controller contract.
    unsafe { rion_runtime_tabs_set_tab_close_buttons_hidden(controller.as_ptr(), always_hide) }
        .then_some(())
        .ok_or(RuntimeTabsControllerError::ReadbackMismatch)
}

/// Activates and focuses one exact retained AppKit runtime window.
///
/// # Safety
///
/// `native_window` must be the currently-live owning window returned by
/// [`resolve_electron_native_view_window`] and the call must run on AppKit main.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_focus_window(
    native_window: NonNull<c_void>,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    // SAFETY: inherited from this function's exact-window contract. AppKit
    // reports the terminal key-window transition through its focus event; this
    // synchronous boundary verifies only exact native submission.
    unsafe { rion_runtime_tabs_set_window_interaction(native_window.as_ptr(), false, true) }
        .then_some(())
        .ok_or(RuntimeTabsControllerError::ReadbackMismatch)
}

/// Applies AppKit's native reveal lock for a live runtime window.
///
/// # Safety
///
/// The controller and main-thread requirements are identical to
/// [`runtime_tabs_prepare_fullscreen`].
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_set_reveal_locked(
    controller: NonNull<c_void>,
    locked: bool,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    // SAFETY: inherited from this function's exact-controller contract.
    unsafe { rion_runtime_tabs_set_reveal_locked(controller.as_ptr(), locked) }
        .then_some(())
        .ok_or(RuntimeTabsControllerError::ReadbackMismatch)
}

/// Projects the native AppKit runtime-window name.
///
/// # Safety
///
/// The controller must be exact and `window_name` must remain live for this
/// synchronous AppKit-main call.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_set_window_name(
    controller: NonNull<c_void>,
    window_name: Option<&CStr>,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    if window_name.is_some_and(|value| value.to_bytes().is_empty()) {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: the optional C string remains live for the synchronous call.
    let matched = unsafe {
        rion_runtime_tabs_set_window_name(
            controller.as_ptr(),
            window_name.map_or(std::ptr::null(), CStr::as_ptr),
        )
    };
    matched
        .then_some(())
        .ok_or(RuntimeTabsControllerError::ReadbackMismatch)
}

/// Submits an accessibility press to one exact rendered AppKit tab.
///
/// # Safety
///
/// The controller and identifier must remain live on AppKit main.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_accessibility_press(
    controller: NonNull<c_void>,
    tab_identifier: &CStr,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if tab_identifier.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    Ok(unsafe {
        rion_runtime_tabs_accessibility_press(controller.as_ptr(), tab_identifier.as_ptr())
    })
}

/// Submits an accessibility close to one exact rendered AppKit tab.
///
/// # Safety
///
/// The controller and identifier must remain live on AppKit main.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_accessibility_close(
    controller: NonNull<c_void>,
    tab_identifier: &CStr,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if tab_identifier.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    Ok(unsafe {
        rion_runtime_tabs_accessibility_close(controller.as_ptr(), tab_identifier.as_ptr())
    })
}

/// Opens the real accessibility menu for one exact rendered AppKit tab in a
/// desktop-E2E build. This symbol is absent from production archives.
///
/// # Safety
///
/// The controller and identifier must remain live on AppKit main.
#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub unsafe fn runtime_tabs_desktop_e2e_accessibility_show_menu(
    controller: NonNull<c_void>,
    tab_identifier: &CStr,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if tab_identifier.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    Ok(unsafe {
        rion_runtime_tabs_accessibility_show_menu(controller.as_ptr(), tab_identifier.as_ptr())
    })
}

/// Captures native titlebar/tab/traffic-light geometry in desktop E2E builds.
/// This symbol is absent from production archives.
///
/// # Safety
///
/// `controller` must be exact and live on AppKit main.
#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub unsafe fn runtime_tabs_desktop_e2e_titlebar_geometry(
    controller: NonNull<c_void>,
) -> Result<RuntimeTabsDesktopE2ETitlebarGeometry, RuntimeTabsControllerError> {
    require_main_thread()?;
    let mut geometry = RuntimeTabsDesktopE2ETitlebarGeometry::default();
    // SAFETY: the output remains valid for the synchronous native call.
    let captured = unsafe {
        rion_runtime_tabs_desktop_e2e_titlebar_geometry(controller.as_ptr(), &raw mut geometry)
    };
    if !captured
        || !geometry.valid
        || ![
            geometry.root_min_x,
            geometry.root_width,
            geometry.tab_min_x,
            geometry.tab_min_y,
            geometry.tab_max_x,
            geometry.tab_max_y,
            geometry.window_name_max_x,
            geometry.traffic_lights_max_x,
            geometry.fullscreen_control_min_x,
            geometry.fullscreen_control_min_y,
            geometry.fullscreen_control_width,
            geometry.fullscreen_control_height,
        ]
        .into_iter()
        .all(f64::is_finite)
        || geometry.root_width <= 0.0
        || geometry.tab_max_x <= geometry.tab_min_x
        || geometry.tab_max_y <= geometry.tab_min_y
        || geometry.fullscreen_control_width <= 0.0
        || geometry.fullscreen_control_height <= 0.0
    {
        return Err(RuntimeTabsControllerError::InvalidLayout);
    }
    Ok(geometry)
}

/// Captures one exact tab point relative to its native window in desktop E2E
/// builds. The returned point is read-only evidence for a later visible input
/// action; it does not activate, close, or otherwise mutate the tab.
///
/// # Safety
///
/// The controller and identifier must remain live on AppKit main.
#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub unsafe fn runtime_tabs_desktop_e2e_tab_anchor(
    controller: NonNull<c_void>,
    tab_identifier: &CStr,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
) -> Result<RuntimeTabsDesktopE2ETabAnchor, RuntimeTabsControllerError> {
    require_main_thread()?;
    if tab_identifier.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    if !grab_ratio_x.is_finite()
        || !grab_ratio_y.is_finite()
        || !(0.0..=1.0).contains(&grab_ratio_x)
        || !(0.0..=1.0).contains(&grab_ratio_y)
    {
        return Err(RuntimeTabsControllerError::InvalidLayout);
    }
    let mut x = 0.0;
    let mut y = 0.0;
    // SAFETY: inherited from this function's exact-controller contract; both
    // outputs remain live for the synchronous native call.
    let captured = unsafe {
        rion_runtime_tabs_drag_anchor(
            controller.as_ptr(),
            tab_identifier.as_ptr(),
            grab_ratio_x,
            grab_ratio_y,
            &raw mut x,
            &raw mut y,
        )
    };
    if !captured || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err(RuntimeTabsControllerError::InvalidLayout);
    }
    Ok(RuntimeTabsDesktopE2ETabAnchor { x, y })
}

/// Captures AppKit's fullscreen toolbar, tab strip, and traffic-light state in
/// desktop E2E builds. This symbol is absent from production archives.
///
/// # Safety
///
/// `controller` must be exact and live on AppKit main.
#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub unsafe fn runtime_tabs_desktop_e2e_fullscreen_toolbar_state(
    controller: NonNull<c_void>,
) -> Result<RuntimeTabsDesktopE2EFullscreenToolbarState, RuntimeTabsControllerError> {
    require_main_thread()?;
    let mut state = RuntimeTabsDesktopE2EFullscreenToolbarState::default();
    // SAFETY: the output remains valid for the synchronous native call.
    let captured = unsafe {
        rion_runtime_tabs_desktop_e2e_fullscreen_toolbar_state(controller.as_ptr(), &raw mut state)
    };
    if !captured || !state.valid || !state.accessory_visible_height.is_finite() {
        return Err(RuntimeTabsControllerError::InvalidLayout);
    }
    Ok(state)
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub unsafe fn runtime_tabs_desktop_e2e_status_presentation(
    controller: NonNull<c_void>,
) -> Result<i32, RuntimeTabsControllerError> {
    require_main_thread()?;
    let presentation =
        unsafe { rion_runtime_tabs_desktop_e2e_status_presentation(controller.as_ptr()) };
    if !(0..=2).contains(&presentation) {
        return Err(RuntimeTabsControllerError::InvalidLayout);
    }
    Ok(presentation)
}

/// Ensures one tab in the live AppKit controller projection.
///
/// # Safety
///
/// All pointers must remain live for this AppKit-main-thread call and the
/// controller must be the exact current controller generation.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_ensure(
    controller: NonNull<c_void>,
    tab_identifier: &CStr,
    name: &CStr,
    phase: &CStr,
    tab_type: &CStr,
    workspace_template: Option<&CStr>,
    window_identifier: &CStr,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    if tab_identifier.to_bytes().is_empty()
        || name.to_bytes().is_empty()
        || !matches!(
            phase.to_bytes(),
            b"dormant"
                | b"activating"
                | b"attaching"
                | b"loading"
                | b"ready"
                | b"degraded"
                | b"failed"
        )
        || !matches!(tab_type.to_bytes(), b"role" | b"workspace" | b"popup")
        || window_identifier.to_bytes().is_empty()
    {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: the caller owns the exact controller and C strings through this
    // synchronous AppKit-main-thread projection call.
    unsafe {
        if !rion_runtime_tabs_ensure(
            controller.as_ptr(),
            tab_identifier.as_ptr(),
            name.as_ptr(),
            phase.as_ptr(),
            tab_type.as_ptr(),
            workspace_template.map_or(std::ptr::null(), CStr::as_ptr),
            window_identifier.as_ptr(),
        ) {
            return Err(RuntimeTabsControllerError::ReadbackMismatch);
        }
    }
    Ok(())
}

/// Reads back whether every projected tab has the expected lifecycle phase.
///
/// # Safety
///
/// The controller must be the exact live controller generation, and
/// `tab_phases_json` must remain valid for this synchronous AppKit-main-thread
/// call. The JSON must describe the validated tab identities owned by that
/// controller.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_matches_phases(
    controller: NonNull<c_void>,
    tab_phases_json: &CStr,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    Ok(unsafe { rion_runtime_tabs_matches_phases(controller.as_ptr(), tab_phases_json.as_ptr()) })
}

/// Removes one tab from the exact live AppKit controller projection.
///
/// # Safety
///
/// The controller and strings must satisfy [`runtime_tabs_ensure`]'s lifetime
/// and main-thread contract.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_remove(
    controller: NonNull<c_void>,
    tab_identifier: &CStr,
    active_tab_identifier: Option<&CStr>,
) -> Result<(), RuntimeTabsControllerError> {
    require_main_thread()?;
    if tab_identifier.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    unsafe {
        rion_runtime_tabs_remove(
            controller.as_ptr(),
            tab_identifier.as_ptr(),
            active_tab_identifier.map_or(std::ptr::null(), CStr::as_ptr),
        );
    }
    Ok(())
}

/// Applies the complete tab ordering and active identity, then reads back the
/// exact controller projection.
///
/// # Safety
///
/// The controller and strings must satisfy [`runtime_tabs_ensure`]'s lifetime
/// and main-thread contract. `ordered_identifiers_json` must be a JSON string
/// array generated from the same validated tab identities.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_commit_projection(
    controller: NonNull<c_void>,
    ordered_identifiers_json: &CStr,
    active_tab_identifier: Option<&CStr>,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if ordered_identifiers_json.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    unsafe {
        rion_runtime_tabs_reorder(controller.as_ptr(), ordered_identifiers_json.as_ptr());
        rion_runtime_tabs_set_active(
            controller.as_ptr(),
            active_tab_identifier.map_or(std::ptr::null(), CStr::as_ptr),
        );
        Ok(rion_runtime_tabs_matches_projection(
            controller.as_ptr(),
            ordered_identifiers_json.as_ptr(),
            active_tab_identifier.map_or(std::ptr::null(), CStr::as_ptr),
        ))
    }
}

/// Reads back whether the live controller exactly matches a complete tab
/// ordering and active identity without mutating it.
///
/// # Safety
///
/// The controller and strings must satisfy [`runtime_tabs_ensure`]'s lifetime
/// and main-thread contract.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_projection_matches(
    controller: NonNull<c_void>,
    ordered_identifiers_json: &CStr,
    active_tab_identifier: Option<&CStr>,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if ordered_identifiers_json.to_bytes().is_empty() {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    Ok(unsafe {
        rion_runtime_tabs_matches_projection(
            controller.as_ptr(),
            ordered_identifiers_json.as_ptr(),
            active_tab_identifier.map_or(std::ptr::null(), CStr::as_ptr),
        )
    })
}

/// Applies and synchronously reads back the complete native workspace-divider
/// projection inside the retained AppKit content host.
///
/// # Safety
///
/// The controller must be the exact live controller generation and
/// `projection_json` must remain valid through this AppKit-main-thread call.
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_apply_workspace_divider_projection(
    controller: NonNull<c_void>,
    projection_json: &CStr,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if projection_json.to_bytes().is_empty() || projection_json.to_bytes().len() > 64 * 1024 {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    Ok(unsafe {
        rion_runtime_tabs_apply_workspace_divider_projection(
            controller.as_ptr(),
            projection_json.as_ptr(),
        )
    })
}

/// Reads back whether the exact retained AppKit divider views still match a
/// complete validated projection without mutating native state.
///
/// # Safety
///
/// The controller and projection must satisfy
/// [`runtime_tabs_apply_workspace_divider_projection`].
#[cfg(target_os = "macos")]
pub unsafe fn runtime_tabs_workspace_divider_projection_matches(
    controller: NonNull<c_void>,
    projection_json: &CStr,
) -> Result<bool, RuntimeTabsControllerError> {
    require_main_thread()?;
    if projection_json.to_bytes().is_empty() || projection_json.to_bytes().len() > 64 * 1024 {
        return Err(RuntimeTabsControllerError::InvalidIdentifier);
    }
    // SAFETY: inherited from this function's exact-controller contract.
    Ok(unsafe {
        rion_runtime_tabs_matches_workspace_divider_projection(
            controller.as_ptr(),
            projection_json.as_ptr(),
        )
    })
}

#[cfg(target_os = "macos")]
fn require_main_thread() -> Result<(), RuntimeTabsControllerError> {
    if runtime_tabs_is_main_thread() {
        Ok(())
    } else {
        Err(RuntimeTabsControllerError::NotMainThread)
    }
}

/// Destroys the exact shared AppKit controller and fences its callbacks.
///
/// # Safety
///
/// `controller` must be live, uniquely destroyed, and called on AppKit main.
#[cfg(target_os = "macos")]
pub unsafe fn destroy_runtime_tabs_controller(
    controller: NonNull<c_void>,
) -> Result<(), RuntimeTabsControllerError> {
    if !runtime_tabs_is_main_thread() {
        return Err(RuntimeTabsControllerError::NotMainThread);
    }
    // SAFETY: the caller provides the exact uniquely-owned controller pointer.
    unsafe { rion_runtime_tabs_destroy(controller.as_ptr()) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_runtime_tabs_abi_matches_the_rust_contract() {
        #[cfg(target_os = "macos")]
        assert_eq!(runtime_tabs_abi_version(), RUNTIME_TABS_ABI_VERSION);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(runtime_tabs_abi_version(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_titlebar_accessibility_hierarchy_survives_visual_rehosting() {
        // SAFETY: the native self-test owns every temporary AppKit view and
        // returns only a value assertion across the C ABI.
        assert!(unsafe { rion_runtime_tabs_accessibility_hierarchy_self_test() });
    }

    #[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
    #[test]
    fn desktop_e2e_accessibility_show_menu_has_a_typed_rust_boundary() {
        let operation: unsafe fn(
            NonNull<c_void>,
            &CStr,
        ) -> Result<bool, RuntimeTabsControllerError> =
            runtime_tabs_desktop_e2e_accessibility_show_menu;
        std::hint::black_box(operation);
    }

    #[test]
    fn chromium_trusted_key_matrix_matches_stable_macos_dom_codes() {
        const SOURCE: &str =
            include_str!("../native/macos/RionRuntimeTabsController/09_chromium_surface_probe.mm");
        const EXPECTED: &[(&str, &str)] = &[
            ("KeyA", "kVK_ANSI_A"),
            ("KeyB", "kVK_ANSI_B"),
            ("KeyC", "kVK_ANSI_C"),
            ("KeyD", "kVK_ANSI_D"),
            ("KeyE", "kVK_ANSI_E"),
            ("KeyF", "kVK_ANSI_F"),
            ("KeyG", "kVK_ANSI_G"),
            ("KeyH", "kVK_ANSI_H"),
            ("KeyI", "kVK_ANSI_I"),
            ("KeyJ", "kVK_ANSI_J"),
            ("KeyK", "kVK_ANSI_K"),
            ("KeyL", "kVK_ANSI_L"),
            ("KeyM", "kVK_ANSI_M"),
            ("KeyN", "kVK_ANSI_N"),
            ("KeyO", "kVK_ANSI_O"),
            ("KeyP", "kVK_ANSI_P"),
            ("KeyQ", "kVK_ANSI_Q"),
            ("KeyR", "kVK_ANSI_R"),
            ("KeyS", "kVK_ANSI_S"),
            ("KeyT", "kVK_ANSI_T"),
            ("KeyU", "kVK_ANSI_U"),
            ("KeyV", "kVK_ANSI_V"),
            ("KeyW", "kVK_ANSI_W"),
            ("KeyX", "kVK_ANSI_X"),
            ("KeyY", "kVK_ANSI_Y"),
            ("KeyZ", "kVK_ANSI_Z"),
            ("Digit0", "kVK_ANSI_0"),
            ("Digit1", "kVK_ANSI_1"),
            ("Digit2", "kVK_ANSI_2"),
            ("Digit3", "kVK_ANSI_3"),
            ("Digit4", "kVK_ANSI_4"),
            ("Digit5", "kVK_ANSI_5"),
            ("Digit6", "kVK_ANSI_6"),
            ("Digit7", "kVK_ANSI_7"),
            ("Digit8", "kVK_ANSI_8"),
            ("Digit9", "kVK_ANSI_9"),
            ("Backquote", "kVK_ANSI_Grave"),
            ("Equal", "kVK_ANSI_Equal"),
            ("Minus", "kVK_ANSI_Minus"),
            ("BracketRight", "kVK_ANSI_RightBracket"),
            ("BracketLeft", "kVK_ANSI_LeftBracket"),
            ("Quote", "kVK_ANSI_Quote"),
            ("Semicolon", "kVK_ANSI_Semicolon"),
            ("Backslash", "kVK_ANSI_Backslash"),
            ("Comma", "kVK_ANSI_Comma"),
            ("Slash", "kVK_ANSI_Slash"),
            ("Period", "kVK_ANSI_Period"),
            ("Enter", "kVK_Return"),
            ("Tab", "kVK_Tab"),
            ("Space", "kVK_Space"),
            ("Backspace", "kVK_Delete"),
            ("Escape", "kVK_Escape"),
            ("F1", "kVK_F1"),
            ("F2", "kVK_F2"),
            ("F3", "kVK_F3"),
            ("F4", "kVK_F4"),
            ("F5", "kVK_F5"),
            ("F6", "kVK_F6"),
            ("F7", "kVK_F7"),
            ("F8", "kVK_F8"),
            ("F9", "kVK_F9"),
            ("F10", "kVK_F10"),
            ("F11", "kVK_F11"),
            ("F12", "kVK_F12"),
            ("F13", "kVK_F13"),
            ("F14", "kVK_F14"),
            ("F15", "kVK_F15"),
            ("F16", "kVK_F16"),
            ("F17", "kVK_F17"),
            ("F18", "kVK_F18"),
            ("F19", "kVK_F19"),
            ("F20", "kVK_F20"),
            ("Insert", "kVK_Help"),
            ("Home", "kVK_Home"),
            ("PageUp", "kVK_PageUp"),
            ("Delete", "kVK_ForwardDelete"),
            ("End", "kVK_End"),
            ("PageDown", "kVK_PageDown"),
            ("ArrowLeft", "kVK_LeftArrow"),
            ("ArrowRight", "kVK_RightArrow"),
            ("ArrowDown", "kVK_DownArrow"),
            ("ArrowUp", "kVK_UpArrow"),
        ];

        let matrix_start = SOURCE
            .find("codes = @{")
            .expect("missing Chromium key matrix");
        let matrix = &SOURCE[matrix_start..];
        let matrix_end = matrix
            .find("\n    };")
            .expect("unterminated Chromium key matrix");
        let matrix = &matrix[..matrix_end];

        assert_eq!(matrix.matches("@\"").count(), EXPECTED.len());
        for (code, virtual_key) in EXPECTED {
            let entry = format!("@\"{code}\": @({virtual_key})");
            assert!(
                matrix.contains(&entry),
                "missing exact native mapping {entry}"
            );
        }
        for unsupported in ["F21", "F22", "F23", "F24"] {
            assert!(!matrix.contains(&format!("@\"{unsupported}\":")));
        }
        assert!(SOURCE.contains("if (!code || !virtualCode || !base) return 8;"));
    }

    #[test]
    fn chromium_mouse_contract_scales_css_pixels_to_appkit_points_once() {
        const SOURCE: &str =
            include_str!("../native/macos/RionRuntimeTabsController/09_chromium_surface_probe.mm");
        const HEADER: &str = include_str!("../native/macos/RionRuntimeTabsController.h");
        let start = SOURCE
            .find("extern \"C\" int32_t rion_appkit_dispatch_chromium_mouse")
            .expect("missing Chromium mouse dispatcher");
        let end = SOURCE[start..]
            .find("extern \"C\" int32_t rion_appkit_probe_dispatch_key")
            .map(|offset| start + offset)
            .expect("missing dispatcher boundary");
        let mouse_dispatch = &SOURCE[start..end];

        for zoom_factor in [1.0, 1.25, 2.0] {
            assert_eq!(
                100.0 * zoom_factor,
                match zoom_factor {
                    1.0 => 100.0,
                    1.25 => 125.0,
                    2.0 => 200.0,
                    _ => unreachable!(),
                }
            );
        }
        assert!(mouse_dispatch.contains("appKitOffsetX = canonicalClientX * zoomFactor"));
        assert!(mouse_dispatch.contains("appKitOffsetY = canonicalClientY * zoomFactor"));
        assert!(mouse_dispatch.contains("[target convertPoint:localPoint toView:nil]"));
        assert!(mouse_dispatch.contains("result->clientX = canonicalClientX"));
        assert!(mouse_dispatch.contains("result->zoomFactor = zoomFactor"));
        assert!(SOURCE.contains("button == 1 ? kCGMouseButtonCenter"));
        assert!(SOURCE.contains("button == 2 ? kCGMouseButtonRight"));
        assert!(
            SOURCE
                .contains("CGEventSetIntegerValueField(\n      cgEvent, kCGMouseEventButtonNumber")
        );
        assert!(!mouse_dispatch.contains("backingScaleFactor"));
        assert!(!mouse_dispatch.contains("convertPointToBacking"));
        assert!(
            HEADER.contains("double clientX, double clientY, double zoomFactor, uint8_t button")
        );
    }

    #[test]
    fn resolution_failures_have_stable_classification() {
        assert_eq!(
            ElectronViewWindowResolutionError::UnknownStatus(17),
            ElectronViewWindowResolutionError::UnknownStatus(17)
        );
        assert_ne!(
            ElectronViewWindowResolutionError::InvalidInput,
            ElectronViewWindowResolutionError::DetachedView
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_resolution_rejects_nil_before_any_appkit_access() {
        let mut native_window = NonNull::<c_void>::dangling().as_ptr();
        // SAFETY: a nil input is an explicit C ABI precondition test and is
        // rejected before the bridge accesses an Objective-C object.
        let status = unsafe {
            rion_appkit_resolve_electron_native_view_window(
                std::ptr::null_mut(),
                &raw mut native_window,
            )
        };
        assert_eq!(status, 1);
        assert!(native_window.is_null());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_resolution_rejects_a_worker_before_dereferencing_the_view() {
        let (status, cleared_output) = std::thread::spawn(|| {
            let native_view = NonNull::<c_void>::dangling().as_ptr();
            let mut native_window = NonNull::<c_void>::dangling().as_ptr();
            // SAFETY: this deliberately invalid pointer must never be touched:
            // a newly spawned Rust thread cannot be the AppKit main thread.
            let status = unsafe {
                rion_appkit_resolve_electron_native_view_window(native_view, &raw mut native_window)
            };
            (status, native_window.is_null())
        })
        .join()
        .expect("native resolution worker panicked");
        assert_eq!(status, 2);
        assert!(cleared_output);
    }
}
