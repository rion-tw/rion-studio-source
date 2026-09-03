//! AppCore façade: command dispatch, lifecycle orchestration, effects, imports, and diagnostics.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("app/section_01_event_queue_capacity.rs");
include!("app/section_01_role_browser_data_clear_command_drain.rs");
include!("app/section_02_invoke.rs");
include!("app/section_03_portable_apply.rs");
include!("app/section_04_show_embedded_windows.rs");
include!("app/section_03_invoke_async.rs");
include!("app/section_04_apply_one_chrome_profile.rs");
include!("app/section_05_delete_workspaces_runtime_aware.rs");
include!("app/section_06_acquire_browser_operation_async.rs");
include!("app/section_06_restored_role_demand.rs");
include!("app/section_07_embedded_workspace_launch.rs");
include!("app/section_07_commit_embedded_role_launch_outcome.rs");
include!("app/section_07_stop_embedded_role.rs");
include!("app/section_08_stop_embedded_workspace_with_operation_lease.rs");
include!("app/section_08_tab_mutation.rs");
include!("app/section_09_apply_embedded_runtime_command_inner.rs");
include!("app/section_10_shutdown.rs");
include!("app/section_11_embedded_launch_effects.rs");
include!("app/section_12_input_fence_and_conditional_activation.rs");
include!("app/section_13_game_window_configuration.rs");
include!("app/section_14_session_migration_facade.rs");
include!("app/section_15_browser_tab_audio_mute.rs");
include!("app/section_16_chromium_launch_window_context.rs");
include!("app/section_16_appkit_runtime_events.rs");
include!("app/section_17_chrome_profile_import_contract.rs");
include!("app/section_18_global_web_profile.rs");
include!("app/section_19_runtime_ui_actions.rs");
include!("app/section_20_chromium_popup_lifecycle.rs");
include!("app/section_21_workspace_divider_actions.rs");
include!("app/section_22_runtime_window_presentation.rs");
include!("app/section_23_managed_shortcut.rs");
include!("app/section_24_windows_chromium_held_key_continuity.rs");
include!("app/section_25_windows_runtime_window_placement.rs");
include!("app/section_26_runtime_window_zoom.rs");
include!("app/section_27_controlled_role_reload_state.rs");
include!("app/section_28_controlled_role_reload_foundation.rs");
include!("app/section_28_controlled_role_reload_effects.rs");
include!("app/section_28_browser_runtime_tab_reload.rs");
include!("app/section_29_runtime_window_visibility_receipt.rs");
include!("app/section_30_runtime_window_visibility_lifecycle.rs");

#[cfg(test)]
mod tests;
