//! Focused behavior tests for the adjacent implementation.

include!("behavior_01_runtime_tab_control_row_uses_exact_half_open_boundaries.rs");
include!("behavior_02_returning_to_the_applied_tab_skips_native_visibility_and_focus_work.rs");
include!("behavior_03_runtime_navigation_session_and_platform_contracts.rs");
include!("behavior_04_native_launch_errors_keep_their_code_and_message_in_diagnostics.rs");
include!("behavior_05_input_dispatch_compensation_is_net_state_and_submission_is_tristate.rs");
include!("behavior_06_navigation_input_tickets_require_latest_epoch_drain_and_page_finish.rs");
include!("behavior_07_windows_reparent_sync_uses_one_bounded_deadline.rs");
include!("behavior_08_native_presentation_contract_is_platform_neutral.rs");
include!("behavior_09_native_operation_contract_is_shared.rs");
include!("behavior_10_failed_launch_cleanup_is_idempotent.rs");
include!("behavior_11_runtime_diagnostics_are_bounded_and_classified.rs");
