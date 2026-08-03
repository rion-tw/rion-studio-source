//! Focused behavior tests for the adjacent implementation.

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
include!("behavior_07_conditional_tab_activation_noops_after_cross_window_move.rs");
include!("behavior_08_display_remap_transaction_is_atomic.rs");
