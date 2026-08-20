//! Domain validation and normalization for games, roles, workspaces, windows, macros, and settings.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("domain/section_01_default_launch_url.rs");
include!("domain/section_02_reorder_workspaces.rs");
include!("domain/section_03_validate_display_target.rs");
include!("domain/section_04_is_reserved_macro_trigger.rs");
include!("domain/section_05_decode.rs");
include!("domain/section_06_quick_access.rs");

#[cfg(test)]
mod tests;
