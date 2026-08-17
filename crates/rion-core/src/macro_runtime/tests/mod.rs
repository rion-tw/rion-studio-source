//! Focused behavior tests for the adjacent implementation.

include!("behavior_01_manual_wait.rs");
include!("behavior_02_called_macro_timing_depends_on_each_definition_shortcut.rs");
include!("behavior_03_serializes_complete_key_and_click_sequences_across_same_role_invocations.rs");
include!("behavior_04_synchronous_looping_child_runs_once_before_the_parent_continues.rs");
include!("behavior_05_parent_stop_keeps_an_unrelated_invocation_running.rs");
include!("behavior_06_manually_stopped_synchronous_child_cancels_parent_before_next_step.rs");
include!("behavior_07_complete_first_release_arriving_before_press_runs_exactly_one_iteration.rs");
include!("behavior_08_input_fence_cancels_normal_work_and_tags_cleanup_with_the_new_epoch.rs");
include!("behavior_09_list_stop_cancels_owned_descendants.rs");
include!("behavior_10_trusted_input_recovery_restarts_eligible_roots.rs");
