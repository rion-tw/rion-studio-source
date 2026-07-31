//! Native runtime tab context-menu projection and actions.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("runtime_tab_menu/section_01_activate_prefix.rs");
include!("runtime_tab_menu/section_02_open_tab_from_model.rs");
include!("runtime_tab_menu/section_03_launch_from_menu.rs");

#[cfg(test)]
mod tests;
