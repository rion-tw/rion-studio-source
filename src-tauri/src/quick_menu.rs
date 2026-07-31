//! Native runtime quick-menu projection and actions.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("quick_menu/section_01_tray_id.rs");
include!("quick_menu/section_02_handle_menu_event.rs");

#[cfg(test)]
mod tests;
