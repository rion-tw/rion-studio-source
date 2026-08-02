//! System WebView state, effect queue, surfaces, navigation, session, overlay, input, and platform adapters.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("system_runtime/section_01_navigation_timeout.rs");
include!("system_runtime/section_02_windows_surface_identity_matches.rs");
include!("system_runtime/section_03_start.rs");
include!("system_runtime/section_04_next_revision.rs");
include!("system_runtime/browser_proxy.rs");
include!("system_runtime/section_05_is_surface_close_effect.rs");
include!("system_runtime/section_06_is_saved_game_window.rs");
include!("system_runtime/section_07_hydrate_tab_dividers.rs");
include!("system_runtime/section_08_runtime_game_window_save_input.rs");
include!("system_runtime/section_09_record_topology_reconciled.rs");
include!("system_runtime/section_10_set_language.rs");
include!("system_runtime/section_11_provisionally_move_tab_with_visibility.rs");
include!("system_runtime/section_12_handle_divider_pointer.rs");
include!("system_runtime/section_13_window_zoom_indicator_label.rs");
include!("system_runtime/section_14_preview_tab_close.rs");
include!("system_runtime/section_15_schedule_window_placement_persistence.rs");
include!("system_runtime/section_16_forget_popup.rs");
include!("system_runtime/section_17_rebuild_role_surface.rs");
include!("system_runtime/section_18_apply.rs");
include!("system_runtime/section_18_input_diagnostics.rs");
include!("system_runtime/section_18_runtime_diagnostics.rs");
include!("system_runtime/section_19_webview_builder.rs");
include!("system_runtime/section_20_verify_role_authentication.rs");
include!("system_runtime/section_21_runtime_layout.rs");
include!("system_runtime/section_22_with_native_creation_lane.rs");
include!("system_runtime/section_23_create_tab.rs");
include!("system_runtime/section_24_start_role_loads.rs");
include!("system_runtime/section_25_reparent_rollback.rs");
include!("system_runtime/section_25_apply_runtime.rs");
include!("system_runtime/section_26_sync_native_tab_metadata.rs");
include!("system_runtime/section_27_add_child_bounded.rs");
include!("system_runtime/section_27_prepare_destroy_tab_presentation.rs");
include!("system_runtime/section_28_set_role_audio_muted.rs");
include!("system_runtime/section_29_session_storage.rs");
include!("system_runtime/section_30_geometry_and_input.rs");
include!("system_runtime/section_31_input_fence.rs");
include!("system_runtime/platform/shared.rs");
include!("system_runtime/platform/windows.rs");
include!("system_runtime/platform/macos.rs");
include!("system_runtime/platform/unsupported.rs");

#[cfg(test)]
mod tests;
