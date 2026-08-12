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
