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
