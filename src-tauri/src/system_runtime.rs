//! System WebView state, effect queue, surfaces, navigation, session, overlay, input, and platform adapters.
//!
//! Legacy implementation sections share a private executor namespace. Authority-sensitive
//! executor, registry, projection, Kernel-event, and platform-adapter boundaries are real Rust
//! modules with explicit visibility.

mod native_resource_registry;
use native_resource_registry::NativeResourceRegistry;

mod macro_badge_timing;
pub use macro_badge_timing::MacroBadgeTimingObservation;
use macro_badge_timing::{MacroBadgeTimingPhase, MacroBadgeTimingTracker};

mod native_projection;
use native_projection::{
    NativeTabProjectionState, NativeTabProjectionStore, SurfacePresentationBinding,
};

// @source "./system_runtime/webgl_performance.rs"
mod webgl_performance;
use webgl_performance::*;

include!("system_runtime/section_01_navigation_timeout.rs");
include!("system_runtime/section_01_navigation_completion.rs");
include!("system_runtime/section_02_windows_surface_identity_matches.rs");
include!("system_runtime/section_02_native_operation_contract.rs");
include!("system_runtime/section_02_geometry_shutdown_contract.rs");
include!("system_runtime/section_03_native_operation_registry.rs");
include!("system_runtime/section_03_tab_mutation_coordinator.rs");
include!("system_runtime/section_03_tab_drag_intent_coordinator.rs");
include!("system_runtime/section_03_native_presentation_queue.rs");
include!("system_runtime/section_03_start.rs");
include!("system_runtime/section_04_native_creation_gate.rs");
include!("system_runtime/section_04_next_revision.rs");
mod native_executor;
pub use native_executor::SystemRuntimeExecutor;
use native_executor::{
    ConcurrentRuntimeWork, OptionalHydrationWork, RuntimeHealth, SystemRuntimeWork,
};
include!("system_runtime/section_04_live_window_tab_store.rs");
include!("system_runtime/section_04_test_topology_move.rs");
include!("system_runtime/section_04_focus_broker.rs");
include!("system_runtime/section_04_quick_access_request.rs");
include!("system_runtime/section_04_main_window_actor.rs");
include!("system_runtime/section_04_window_close_ledger.rs");
include!("system_runtime/section_04_tab_chrome_ack.rs");
include!("system_runtime/section_04_tab_activation_chrome.rs");
include!("system_runtime/section_04_tab_chrome_projection.rs");
include!("system_runtime/section_04_input_fence_state.rs");
include!("system_runtime/section_04_surface_recovery_registry.rs");
include!("system_runtime/section_04_application_lifecycle.rs");
include!("system_runtime/section_05_is_surface_close_effect.rs");
include!("system_runtime/section_05_launch_preview_identity.rs");
include!("system_runtime/section_05_native_presentation_diagnostics.rs");
include!("system_runtime/section_06_is_saved_game_window.rs");
include!("system_runtime/section_07_hydrate_tab_dividers.rs");
include!("system_runtime/section_07_effect_admission.rs");
include!("system_runtime/section_07_async_role_load.rs");
include!("system_runtime/section_07_capability_evidence.rs");
include!("system_runtime/section_08_runtime_game_window_save_input.rs");
include!("system_runtime/section_08_runtime_window_snapshot_input.rs");
include!("system_runtime/section_09_record_topology_reconciled.rs");
include!("system_runtime/section_10_set_language.rs");
include!("system_runtime/section_10_live_tab_drag_commit.rs");
include!("system_runtime/section_10_provisional_window_contract.rs");
include!("system_runtime/section_10_tab_drag_cursor_lease.rs");
include!("system_runtime/section_10_tab_drag_presentation.rs");
include!("system_runtime/section_10_tab_close_fence.rs");
include!("system_runtime/section_11_provisionally_move_tab_with_visibility.rs");
include!("system_runtime/section_12_handle_divider_pointer.rs");
include!("system_runtime/section_12_role_view_contract.rs");
include!("system_runtime/section_12_window_restore_contract.rs");
include!("system_runtime/section_12_window_control_contract.rs");
include!("system_runtime/section_13_window_zoom_indicator_label.rs");
include!("system_runtime/section_13_background_tab_activation.rs");
include!("system_runtime/section_13_on_demand_tab_activation.rs");
include!("system_runtime/section_13_shutdown_contract.rs");
include!("system_runtime/section_14_window_placement.rs");
include!("system_runtime/section_14_window_resize.rs");
include!("system_runtime/section_14_preview_tab_close.rs");
include!("system_runtime/section_14_quarantined_tab_retirement.rs");
include!("system_runtime/section_14_window_close_contract.rs");
include!("system_runtime/section_15_schedule_window_placement_persistence.rs");
include!("system_runtime/section_15_window_state_persistence.rs");
include!("system_runtime/section_16_forget_popup.rs");
include!("system_runtime/section_16_surface_recovery_contract.rs");
include!("system_runtime/section_16_input_fence_coordinator.rs");
include!("system_runtime/section_16_input_fence_contract.rs");
include!("system_runtime/section_17_rebuild_role_surface.rs");
mod kernel_facade;
use kernel_facade::seed_persisted_runtime_windows;
include!("system_runtime/section_18_session_contract.rs");
include!("system_runtime/section_18_automatic_input_context.rs");
include!("system_runtime/section_18_macro_key_guard.rs");
include!("system_runtime/section_18_coordinate_context.rs");
include!("system_runtime/section_18_focus_readiness.rs");
include!("system_runtime/section_18_apply.rs");
include!("system_runtime/section_18_input_diagnostics.rs");
include!("system_runtime/section_18_runtime_diagnostics.rs");
include!("system_runtime/section_18_resize_diagnostics.rs");
include!("system_runtime/section_19_webview_builder.rs");
include!("system_runtime/section_20_verify_role_authentication.rs");
include!("system_runtime/section_21_runtime_layout.rs");
include!("system_runtime/section_21_ready_surface_viewport.rs");
include!("system_runtime/section_22_with_native_creation_lane.rs");
include!("system_runtime/section_22_role_placeholder.rs");
include!("system_runtime/section_22_native_tab_reservation.rs");
include!("system_runtime/section_23_create_tab.rs");
include!("system_runtime/section_23_claim_role_slot.rs");
include!("system_runtime/section_24_start_role_loads.rs");
include!("system_runtime/section_24_reload_contract.rs");
include!("system_runtime/section_25_runtime_topology_contract.rs");
include!("system_runtime/section_25_apply_runtime.rs");
include!("system_runtime/section_26_window_tab_geometry.rs");
include!("system_runtime/section_26_geometry_contract.rs");
include!("system_runtime/section_26_display_topology_contract.rs");
include!("system_runtime/section_26_tab_drag_contract.rs");
include!("system_runtime/section_26_sync_native_tab_metadata.rs");
include!("system_runtime/section_26_runtime_tab_failure_status.rs");
include!("system_runtime/section_27_add_child_bounded.rs");
include!("system_runtime/section_27_prepare_destroy_tab_presentation.rs");
include!("system_runtime/section_28_set_role_audio_muted.rs");
include!("system_runtime/section_29_session_storage.rs");
include!("system_runtime/section_30_geometry_and_input.rs");
include!("system_runtime/section_31_input_fence.rs");
include!("system_runtime/section_32_macro_input_recovery.rs");
#[cfg(feature = "desktop-e2e")]
include!("system_runtime/section_31_desktop_e2e.rs");
#[cfg(feature = "desktop-e2e")]
include!("system_runtime/section_31_desktop_e2e_pointer.rs");
#[cfg(feature = "desktop-e2e")]
include!("system_runtime/section_31_desktop_e2e_viewport.rs");
#[cfg(feature = "desktop-e2e")]
include!("system_runtime/section_31_desktop_e2e_ui.rs");
include!("system_runtime/platform/shared.rs");

// @source "./system_runtime/platform/windows.rs"
// @source "./system_runtime/platform/macos.rs"
// @source "./system_runtime/platform/unsupported.rs"
mod platform;
#[cfg(target_os = "macos")]
use platform::macos::*;
#[cfg(not(any(windows, target_os = "macos")))]
use platform::unsupported::*;
#[cfg(windows)]
pub(crate) use platform::windows::defer_runtime_tab_shortcut;
#[cfg(any(windows, test))]
use platform::windows::*;

#[cfg(windows)]
pub(crate) fn apply_windows_main_window_material(window: &tauri::WebviewWindow) -> bool {
    platform::windows::apply_windows_mica_to_main_window(window)
}

#[cfg(windows)]
pub(crate) fn install_windows_main_application_shortcut_handler(
    window: &tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), RuntimeError> {
    platform::windows::install_main_application_shortcut_handler(window.as_ref(), app)
}

#[cfg(test)]
mod tests;
