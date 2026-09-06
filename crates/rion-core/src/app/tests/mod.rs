//! Focused behavior tests for the adjacent implementation.

fn test_role_slots(role_ids: &[&str]) -> Vec<crate::model::RuntimeRoleSlotInputRecord> {
    role_ids
        .iter()
        .map(|role_id| crate::model::RuntimeRoleSlotInputRecord {
            slot_id: format!("role:{role_id}"),
            role_id: (*role_id).to_owned(),
            rect: crate::model::StateNormalizedRectRecord {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            browser_zoom_percent: Some(100.0),
        })
        .collect()
}

fn test_window_stop_request(
    window_id: impl Into<String>,
    tab_ids: Vec<String>,
) -> crate::model::RuntimeWindowStopRequestRecord {
    let window_id = window_id.into();
    crate::model::RuntimeWindowStopRequestRecord {
        parent_operation_id: format!("test-window-close:{window_id}"),
        window_id,
        window_generation: 1,
        topology_revision: 1,
        tab_ids,
        intent_origin: "test".to_owned(),
        admission_id: None,
        closing_tabs: Vec::new(),
    }
}

include!("behavior_01_command.rs");
include!(
    "behavior_02_moving_the_last_tab_to_a_transient_window_preserves_saved_window_settings.rs"
);
include!("behavior_03_role_creation_and_selected_browser_directory_reset.rs");
include!("behavior_04_portable_role_import_is_blocked_while_the_affected_role_is_running.rs");
include!("behavior_05_failed_embedded_stop_keeps_the_close_intent_and_stopping_projection.rs");
include!(
    "behavior_06_authoritative_events_leave_core_threads_before_waiting_for_queue_capacity.rs"
);
include!("behavior_08_display_remap_transaction_is_atomic.rs");
include!("behavior_11_shared_workspace_role_slot_claim.rs");
include!("behavior_12_runtime_window_snapshot_revision.rs");
include!("behavior_13_tab_stop_uses_stable_identity.rs");
include!("behavior_14_cancelled_workspace_launch_retires_native_tab.rs");
include!("behavior_15_launch_admission_completion.rs");
include!("behavior_16_runtime_restore_session_update.rs");
include!("behavior_17_web_only_workspace_launch.rs");
include!("behavior_18_browser_runtime_registration.rs");
include!("behavior_19_browser_tab_audio_mute.rs");
include!("behavior_20_appkit_runtime_event_fences.rs");
include!("behavior_21_session_migration_launch_gate.rs");
include!("behavior_22_global_web_chromium_surfaces.rs");
include!("behavior_22_chrome_profile_import_contract.rs");
include!("behavior_23_global_web_profile_commands.rs");
include!("behavior_24_appkit_web_surface_projection.rs");
include!("behavior_25_runtime_ui_actions.rs");
include!("behavior_26_chromium_popup_lifecycle.rs");
include!("behavior_27_workspace_divider_actions.rs");
include!("behavior_28_runtime_window_presentation.rs");
include!("behavior_29_launch_window_persistence.rs");
include!("behavior_30_macro_input_recovery_commands.rs");
include!("behavior_31_managed_shortcut_reentry.rs");
include!("behavior_32_windows_chromium_held_key_continuity.rs");
include!("behavior_33_windows_runtime_window_placement.rs");
include!("behavior_34_runtime_window_zoom.rs");
include!("behavior_35_controlled_role_reload.rs");
include!("behavior_36_empty_window_registration.rs");
include!("behavior_37_foreground_chromium_launch_focus.rs");
include!("behavior_38_system_fonts.rs");
include!("behavior_38_runtime_window_visibility_receipt.rs");
include!("behavior_39_role_browser_data_clear_timeout.rs");
include!("behavior_40_appkit_runtime_persistence.rs");
