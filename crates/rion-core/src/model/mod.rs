//! Shared command, effect, state, browser runtime, macro, portable, and diagnostics contracts.
//!
//! Sections are included at compile time and re-exported through this module.

include!("section_01_app_core_options.rs");
include!("section_02_core_command.rs");
include!("section_03_portable_data_record.rs");
include!("section_04_state_game_record.rs");
include!("section_04_browser_runtime_record.rs");
include!("section_05_game_browser_settings_record.rs");
include!("section_06_browser_action_request.rs");
include!("section_07_macro_overlay_start_summary_record.rs");
include!("section_08_quick_access.rs");
include!("section_09_system_runtime_diagnostics.rs");
include!("section_10_appkit_runtime.rs");
include!("section_11_chromium_popup.rs");
include!("section_12_workspace_divider.rs");
include!("section_13_macro_input_recovery.rs");
include!("section_14_managed_shortcut.rs");
include!("section_15_windows_runtime_placement.rs");
include!("section_16_runtime_window_zoom.rs");
include!("section_17_runtime_tab_reload.rs");
include!("section_18_runtime_window_visibility.rs");
