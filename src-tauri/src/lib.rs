//! Tauri shell assembly, startup, typed commands, state, events, and window lifecycle.
//!
//! Implementation sections are included at compile time and share one private module namespace.

mod activation;
mod application_menu;
mod native_shell;
mod quick_menu;
#[cfg(target_os = "macos")]
mod quick_menu_macos;
mod runtime_tab_menu;
#[cfg(target_os = "macos")]
mod runtime_tabs_macos;
mod system_runtime;
mod update_manager;
mod update_transaction;

include!("lib/section_01_activation.rs");
include!("lib/section_01_runtime_operation_receipt.rs");
include!("lib/section_01_update_install.rs");
include!("lib/section_02_drop.rs");
include!("lib/section_03_rion_overlay_request.rs");
include!("lib/section_04_rion_shell_invoke.rs");
include!("lib/section_04_shell_browser_launch.rs");
include!("lib/section_04_prepare_shell_invoke.rs");
include!("lib/section_05_invoke_core_async.rs");
include!("lib/section_06_select_non_conflicting_saved_windows.rs");
include!("lib/section_07_handle_game_window_tab_drag.rs");
include!("lib/section_08_cancel_tab_drag_session.rs");
include!("lib/section_09_run.rs");

#[cfg(test)]
#[path = "lib/tests/mod.rs"]
mod tests;
