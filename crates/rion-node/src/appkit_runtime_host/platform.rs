#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::{
    ffi::{CStr, c_void},
    ptr::NonNull,
};

use napi::{
    Status,
    bindgen_prelude::{Error, Result},
};

#[cfg(feature = "desktop-e2e")]
use super::{
    AppKitDesktopE2EFullscreenToolbarState, AppKitDesktopE2ETabAnchor,
    AppKitDesktopE2ETitlebarGeometry,
};
use super::{
    AppKitKeyDispatchProbeReceipt, AppKitMouseDispatchProbeReceipt, AppKitNativeViewTreeNode,
    NativeHostState, ValidatedHostIdentity, ValidatedTabProjection, adapter_error,
    host_destroyed_error, malformed_projection_error,
};

pub(super) fn controller_pointer(state: &NativeHostState) -> Result<NonNull<c_void>> {
    NonNull::new(state.controller.ok_or_else(host_destroyed_error)? as *mut c_void)
        .ok_or_else(host_destroyed_error)
}

pub(super) fn ensure_appkit_main_thread() -> Result<()> {
    if rion_appkit::runtime_tabs_is_main_thread() {
        Ok(())
    } else {
        Err(adapter_error(
            Status::GenericFailure,
            "The AppKit runtime host must be accessed on the macOS main thread.",
        ))
    }
}

#[cfg(target_os = "macos")]
pub(super) fn ensure_projected_tab(
    controller: NonNull<c_void>,
    identity: &ValidatedHostIdentity,
    tab: &ValidatedTabProjection,
) -> Result<()> {
    let window_id = CString::new(identity.logical_window_id.as_str())
        .map_err(|_| malformed_projection_error())?;
    // SAFETY: all C strings and the exact controller remain live through this
    // synchronous main-thread call.
    unsafe {
        rion_appkit::runtime_tabs_ensure(
            controller,
            &tab.tab_id_c,
            &tab.name_c,
            &tab.phase_c,
            &tab.tab_type_c,
            tab.workspace_template_c.as_deref(),
            &window_id,
        )
    }
    .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn ensure_projected_tab(
    _controller: NonNull<c_void>,
    _identity: &ValidatedHostIdentity,
    _tab: &ValidatedTabProjection,
) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn phases_match(controller: NonNull<c_void>, phases_json: &CStr) -> Result<bool> {
    unsafe { rion_appkit::runtime_tabs_matches_phases(controller, phases_json) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn phases_match(_controller: NonNull<c_void>, _phases_json: &CStr) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn remove_projected_tab(
    controller: NonNull<c_void>,
    tab_id: &CStr,
    active_tab_id: Option<&CStr>,
) -> Result<()> {
    // SAFETY: the exact controller and C strings remain live through this
    // synchronous main-thread call.
    unsafe { rion_appkit::runtime_tabs_remove(controller, tab_id, active_tab_id) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn remove_projected_tab(
    _controller: NonNull<c_void>,
    _tab_id: &CStr,
    _active_tab_id: Option<&CStr>,
) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn commit_projected_tabs(
    controller: NonNull<c_void>,
    order_json: &CStr,
    active_tab_id: Option<&CStr>,
) -> Result<bool> {
    // SAFETY: the exact controller and C strings remain live through this
    // synchronous main-thread call.
    unsafe { rion_appkit::runtime_tabs_commit_projection(controller, order_json, active_tab_id) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn commit_projected_tabs(
    _controller: NonNull<c_void>,
    _order_json: &CStr,
    _active_tab_id: Option<&CStr>,
) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn projection_matches(
    controller: NonNull<c_void>,
    order_json: &CStr,
    active_tab_id: Option<&CStr>,
) -> Result<bool> {
    // SAFETY: the exact controller and C strings remain live through this
    // synchronous main-thread readback.
    unsafe { rion_appkit::runtime_tabs_projection_matches(controller, order_json, active_tab_id) }
        .map_err(native_controller_error)
}

#[cfg(target_os = "macos")]
pub(super) fn apply_workspace_divider_projection(
    controller: NonNull<c_void>,
    projection_json: &CStr,
) -> Result<bool> {
    // SAFETY: the N-API host validates the exact controller generation and
    // retains this C string through the synchronous AppKit-main call.
    unsafe {
        rion_appkit::runtime_tabs_apply_workspace_divider_projection(controller, projection_json)
    }
    .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn apply_workspace_divider_projection(
    _controller: NonNull<c_void>,
    _projection_json: &CStr,
) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn workspace_divider_projection_matches(
    controller: NonNull<c_void>,
    projection_json: &CStr,
) -> Result<bool> {
    // SAFETY: the N-API host validates the exact controller generation and
    // retains this C string through the synchronous AppKit-main readback.
    unsafe {
        rion_appkit::runtime_tabs_workspace_divider_projection_matches(controller, projection_json)
    }
    .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn workspace_divider_projection_matches(
    _controller: NonNull<c_void>,
    _projection_json: &CStr,
) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn projection_matches(
    _controller: NonNull<c_void>,
    _order_json: &CStr,
    _active_tab_id: Option<&CStr>,
) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn resolve_native_window(native_view: NonNull<c_void>) -> Result<NonNull<c_void>> {
    // SAFETY: strict pointer-width decoding precedes this call and the native
    // bridge verifies AppKit main plus the exact view's owning window.
    unsafe { rion_appkit::resolve_electron_native_view_window(native_view) }.map_err(|error| {
        adapter_error(
            Status::InvalidArg,
            format!("Electron's AppKit native view is unavailable: {error:?}."),
        )
    })
}

#[cfg(target_os = "macos")]
pub(super) fn focus_native_window(native_window: NonNull<c_void>) -> Result<()> {
    // SAFETY: the N-API host re-resolves the exact live Electron NSView owner
    // immediately before this synchronous AppKit-main focus transition.
    unsafe { rion_appkit::runtime_tabs_focus_window(native_window) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn focus_native_window(_native_window: NonNull<c_void>) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn resolve_native_window(_native_view: NonNull<c_void>) -> Result<NonNull<c_void>> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn read_native_view_tree(
    native_view: NonNull<c_void>,
) -> Result<Vec<AppKitNativeViewTreeNode>> {
    // SAFETY: the exact native root remains owned by the live N-API host and
    // `snapshot_native_view_tree` has revalidated its AppKit window.
    let nodes = unsafe { rion_appkit::snapshot_electron_native_view_tree(native_view) }.map_err(
        |error| {
            adapter_error(
                Status::GenericFailure,
                format!("The AppKit native-view feasibility snapshot failed: {error:?}."),
            )
        },
    )?;
    nodes
        .into_iter()
        .map(|node| {
            // SAFETY: the native bridge always null-terminates the fixed class
            // buffer, even when the Objective-C class name is truncated.
            let class_name = unsafe { CStr::from_ptr(node.class_name.as_ptr()) }
                .to_str()
                .map_err(|_| {
                    adapter_error(
                        Status::GenericFailure,
                        "The AppKit native-view class identity is malformed.",
                    )
                })?
                .to_owned();
            Ok(AppKitNativeViewTreeNode {
                address: format!("{:x}", node.address),
                parent_address: (node.parent_address != 0)
                    .then(|| format!("{:x}", node.parent_address)),
                depth: node.depth,
                class_name,
                hidden: node.hidden != 0,
                accepts_first_responder: node.accepts_first_responder != 0,
                attached_to_window: node.attached_to_window != 0,
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
            })
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
pub(super) fn read_native_view_tree(
    _native_view: NonNull<c_void>,
) -> Result<Vec<AppKitNativeViewTreeNode>> {
    Err(adapter_error(
        Status::GenericFailure,
        "The AppKit native-view feasibility snapshot is unavailable on this platform.",
    ))
}

#[cfg(target_os = "macos")]
pub(super) fn dispatch_key_probe(
    native_view: NonNull<c_void>,
    target_address: usize,
    key_code: u16,
    characters: &CStr,
    modifier_flags: u32,
    dispatch_mode: u8,
) -> Result<AppKitKeyDispatchProbeReceipt> {
    // SAFETY: the target address is re-resolved by walking the exact live root;
    // it is never dereferenced directly from JavaScript input.
    let receipt = unsafe {
        rion_appkit::probe_dispatch_key_to_electron_view(
            native_view,
            target_address,
            key_code,
            characters,
            u64::from(modifier_flags),
            dispatch_mode,
        )
    }
    .map_err(|error| {
        adapter_error(
            Status::GenericFailure,
            format!("The AppKit direct-key feasibility probe failed: {error:?}."),
        )
    })?;
    Ok(AppKitKeyDispatchProbeReceipt {
        dispatched: receipt.dispatched != 0,
        target_attached: receipt.target_attached != 0,
        key_window_preserved: receipt.key_window_preserved != 0,
        key_window_first_responder_preserved: receipt.key_window_first_responder_preserved != 0,
        target_first_responder_preserved: receipt.target_first_responder_preserved != 0,
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn dispatch_key_probe(
    _native_view: NonNull<c_void>,
    _target_address: usize,
    _key_code: u16,
    _characters: &CStr,
    _modifier_flags: u32,
    _dispatch_mode: u8,
) -> Result<AppKitKeyDispatchProbeReceipt> {
    Err(adapter_error(
        Status::GenericFailure,
        "The AppKit direct-key feasibility probe is unavailable on this platform.",
    ))
}

#[cfg(target_os = "macos")]
pub(super) fn dispatch_mouse_probe(
    native_view: NonNull<c_void>,
    target_address: usize,
    x: f64,
    y: f64,
    button: u8,
    modifier_flags: u32,
) -> Result<AppKitMouseDispatchProbeReceipt> {
    // SAFETY: the native bridge re-resolves the snapshot-derived address under
    // the exact root and validates the point against current target bounds.
    let receipt = unsafe {
        rion_appkit::probe_dispatch_mouse_to_electron_view(
            native_view,
            target_address,
            x,
            y,
            button,
            u64::from(modifier_flags),
        )
    }
    .map_err(|error| {
        adapter_error(
            Status::GenericFailure,
            format!("The AppKit direct-mouse feasibility probe failed: {error:?}."),
        )
    })?;
    Ok(AppKitMouseDispatchProbeReceipt {
        dispatched: receipt.dispatched != 0,
        target_attached: receipt.target_attached != 0,
        key_window_preserved: receipt.key_window_preserved != 0,
        key_window_first_responder_preserved: receipt.key_window_first_responder_preserved != 0,
        target_first_responder_preserved: receipt.target_first_responder_preserved != 0,
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn dispatch_mouse_probe(
    _native_view: NonNull<c_void>,
    _target_address: usize,
    _x: f64,
    _y: f64,
    _button: u8,
    _modifier_flags: u32,
) -> Result<AppKitMouseDispatchProbeReceipt> {
    Err(adapter_error(
        Status::GenericFailure,
        "The AppKit direct-mouse feasibility probe is unavailable on this platform.",
    ))
}

#[cfg(target_os = "macos")]
pub(super) fn create_controller(
    native_window: NonNull<c_void>,
    identifier: &CStr,
    context: NonNull<c_void>,
    action: rion_appkit::RuntimeTabsActionCallback,
    layout: rion_appkit::RuntimeTabsLayoutCallback,
) -> Result<NonNull<c_void>> {
    // SAFETY: attach owns the callback context until exact controller destroy.
    unsafe {
        rion_appkit::create_runtime_tabs_controller(
            native_window,
            identifier,
            context,
            action,
            layout,
        )
    }
    .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn create_controller(
    _native_window: NonNull<c_void>,
    _identifier: &CStr,
    _context: NonNull<c_void>,
    _action: rion_appkit::RuntimeTabsActionCallback,
    _layout: rion_appkit::RuntimeTabsLayoutCallback,
) -> Result<NonNull<c_void>> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn read_content_layout(
    controller: NonNull<c_void>,
) -> Result<rion_appkit::RuntimeContentLayout> {
    // SAFETY: the N-API host retains the exact live controller and validates
    // AppKit main before every access.
    unsafe { rion_appkit::runtime_tabs_content_layout(controller) }.map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn read_content_layout(
    _controller: NonNull<c_void>,
) -> Result<rion_appkit::RuntimeContentLayout> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn prepare_fullscreen(controller: NonNull<c_void>, fullscreen: bool) -> Result<()> {
    // SAFETY: `with_live_controller` validates exact identity, window
    // ownership, and AppKit-main execution before this call.
    unsafe { rion_appkit::runtime_tabs_prepare_fullscreen(controller, fullscreen) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn prepare_fullscreen(_controller: NonNull<c_void>, _fullscreen: bool) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn set_fullscreen_policy(controller: NonNull<c_void>, always_show: bool) -> Result<()> {
    // SAFETY: inherited from `with_live_controller`.
    unsafe { rion_appkit::runtime_tabs_set_fullscreen_policy(controller, always_show) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_fullscreen_policy(
    _controller: NonNull<c_void>,
    _always_show: bool,
) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn set_tab_close_buttons_hidden(
    controller: NonNull<c_void>,
    always_hide: bool,
) -> Result<()> {
    // SAFETY: inherited from `with_live_controller`.
    unsafe { rion_appkit::runtime_tabs_set_tab_close_buttons_hidden(controller, always_hide) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_tab_close_buttons_hidden(
    _controller: NonNull<c_void>,
    _always_hide: bool,
) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn set_reveal_locked(controller: NonNull<c_void>, locked: bool) -> Result<()> {
    // SAFETY: inherited from `with_live_controller`.
    unsafe { rion_appkit::runtime_tabs_set_reveal_locked(controller, locked) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_reveal_locked(_controller: NonNull<c_void>, _locked: bool) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn set_window_name(
    controller: NonNull<c_void>,
    window_name: Option<&CStr>,
) -> Result<()> {
    // SAFETY: inherited from `with_live_controller`; the C string remains live
    // for this synchronous call.
    unsafe { rion_appkit::runtime_tabs_set_window_name(controller, window_name) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_window_name(
    _controller: NonNull<c_void>,
    _window_name: Option<&CStr>,
) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn accessibility_press(controller: NonNull<c_void>, tab_id: &CStr) -> Result<bool> {
    // SAFETY: inherited from `with_live_controller`; the tab identifier is a
    // validated, live C string.
    unsafe { rion_appkit::runtime_tabs_accessibility_press(controller, tab_id) }
        .map_err(native_controller_error)
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn accessibility_press(_controller: NonNull<c_void>, _tab_id: &CStr) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn accessibility_close(controller: NonNull<c_void>, tab_id: &CStr) -> Result<bool> {
    // SAFETY: inherited from `with_live_controller`; the tab identifier is a
    // validated, live C string.
    unsafe { rion_appkit::runtime_tabs_accessibility_close(controller, tab_id) }
        .map_err(native_controller_error)
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn accessibility_close(_controller: NonNull<c_void>, _tab_id: &CStr) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_accessibility_show_menu(
    controller: NonNull<c_void>,
    tab_id: &CStr,
) -> Result<bool> {
    // SAFETY: inherited from `with_live_controller`; the tab identifier is a
    // validated, live C string.
    unsafe { rion_appkit::runtime_tabs_desktop_e2e_accessibility_show_menu(controller, tab_id) }
        .map_err(native_controller_error)
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_accessibility_show_menu(
    _controller: NonNull<c_void>,
    _tab_id: &CStr,
) -> Result<bool> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_titlebar_geometry(
    controller: NonNull<c_void>,
) -> Result<AppKitDesktopE2ETitlebarGeometry> {
    // SAFETY: inherited from `with_live_controller`.
    let geometry = unsafe { rion_appkit::runtime_tabs_desktop_e2e_titlebar_geometry(controller) }
        .map_err(native_controller_error)?;
    Ok(AppKitDesktopE2ETitlebarGeometry {
        root_min_x: geometry.root_min_x,
        root_width: geometry.root_width,
        tab_min_x: geometry.tab_min_x,
        tab_min_y: geometry.tab_min_y,
        tab_max_x: geometry.tab_max_x,
        tab_max_y: geometry.tab_max_y,
        window_name_max_x: geometry.window_name_max_x,
        traffic_lights_max_x: geometry.traffic_lights_max_x,
        fullscreen_control_min_x: geometry.fullscreen_control_min_x,
        fullscreen_control_min_y: geometry.fullscreen_control_min_y,
        fullscreen_control_width: geometry.fullscreen_control_width,
        fullscreen_control_height: geometry.fullscreen_control_height,
        title_hidden: geometry.title_hidden,
        valid: geometry.valid,
    })
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_tab_anchor(
    controller: NonNull<c_void>,
    tab_id: &CStr,
    grab_ratio_x: f64,
    grab_ratio_y: f64,
) -> Result<AppKitDesktopE2ETabAnchor> {
    // SAFETY: inherited from `with_live_controller`; the tab identifier is a
    // validated, live C string and the native call is read-only.
    let anchor = unsafe {
        rion_appkit::runtime_tabs_desktop_e2e_tab_anchor(
            controller,
            tab_id,
            grab_ratio_x,
            grab_ratio_y,
        )
    }
    .map_err(native_controller_error)?;
    Ok(AppKitDesktopE2ETabAnchor {
        x: anchor.x,
        y: anchor.y,
    })
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_tab_anchor(
    _controller: NonNull<c_void>,
    _tab_id: &CStr,
    _grab_ratio_x: f64,
    _grab_ratio_y: f64,
) -> Result<AppKitDesktopE2ETabAnchor> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_titlebar_geometry(
    _controller: NonNull<c_void>,
) -> Result<AppKitDesktopE2ETitlebarGeometry> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_fullscreen_toolbar_state(
    controller: NonNull<c_void>,
) -> Result<AppKitDesktopE2EFullscreenToolbarState> {
    // SAFETY: inherited from `with_live_controller`.
    let state =
        unsafe { rion_appkit::runtime_tabs_desktop_e2e_fullscreen_toolbar_state(controller) }
            .map_err(native_controller_error)?;
    Ok(AppKitDesktopE2EFullscreenToolbarState {
        accessory_visible_height: state.accessory_visible_height,
        always_hide_tab_close_button: state.always_hide_tab_close_button,
        always_show_in_full_screen: state.always_show_in_full_screen,
        accessory_on_screen: state.accessory_on_screen,
        fullscreen: state.fullscreen,
        fullscreen_host_ready: state.fullscreen_host_ready,
        presentation_auto_hide_toolbar: state.presentation_auto_hide_toolbar,
        reveal_locked: state.reveal_locked,
        tab_strip_on_screen: state.tab_strip_on_screen,
        toolbar_pinned: state.toolbar_pinned,
        tab_close_button_enabled_count: state.tab_close_button_enabled_count,
        visible_traffic_light_count: state.visible_traffic_light_count,
        valid: state.valid,
    })
}

#[cfg(all(target_os = "macos", feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_status_presentation(controller: NonNull<c_void>) -> Result<i32> {
    unsafe { rion_appkit::runtime_tabs_desktop_e2e_status_presentation(controller) }
        .map_err(native_controller_error)
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_status_presentation(_controller: NonNull<c_void>) -> Result<i32> {
    Err(appkit_platform_unavailable())
}

#[cfg(all(not(target_os = "macos"), feature = "desktop-e2e"))]
pub(super) fn desktop_e2e_fullscreen_toolbar_state(
    _controller: NonNull<c_void>,
) -> Result<AppKitDesktopE2EFullscreenToolbarState> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
pub(super) fn destroy_controller(controller: NonNull<c_void>) -> Result<()> {
    // SAFETY: this is the exact controller pointer, uniquely consumed after
    // callback fencing on AppKit main.
    unsafe { rion_appkit::destroy_runtime_tabs_controller(controller) }
        .map_err(native_controller_error)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn destroy_controller(_controller: NonNull<c_void>) -> Result<()> {
    Err(appkit_platform_unavailable())
}

#[cfg(target_os = "macos")]
fn native_controller_error(error: rion_appkit::RuntimeTabsControllerError) -> Error {
    adapter_error(
        Status::GenericFailure,
        format!("The shared AppKit runtime-tabs controller failed: {error:?}."),
    )
}

#[cfg(not(target_os = "macos"))]
fn appkit_platform_unavailable() -> Error {
    adapter_error(
        Status::GenericFailure,
        "The AppKit runtime host is unavailable on this platform.",
    )
}
