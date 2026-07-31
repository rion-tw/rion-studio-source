//! AppCore façade: command dispatch, lifecycle orchestration, effects, imports, and diagnostics.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("app/section_01_event_queue_capacity.rs");
include!("app/section_02_invoke.rs");
include!("app/section_03_portable_apply.rs");
include!("app/section_04_show_embedded_windows.rs");
include!("app/section_03_invoke_async.rs");
include!("app/section_04_apply_one_chrome_profile.rs");
include!("app/section_05_delete_workspaces_runtime_aware.rs");
include!("app/section_06_acquire_browser_operation_async.rs");
include!("app/section_07_commit_embedded_role_launch_outcome.rs");
include!("app/section_08_stop_embedded_workspace_with_operation_lease.rs");
include!("app/section_09_apply_embedded_runtime_command_inner.rs");
include!("app/section_10_shutdown.rs");
include!("app/section_11_embedded_launch_effects.rs");

#[cfg(test)]
mod tests;
