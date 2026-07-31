//! Portable schema 11 validation, export, preview, conflict planning, and atomic apply.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("portable/section_01_portable_app.rs");
include!("portable/section_02_normalize_step.rs");
include!("portable/section_03_export.rs");
include!("portable/section_04_build_import_plan.rs");
include!("portable/section_05_apply_games.rs");
include!("portable/section_05_all_selection.rs");

#[cfg(test)]
mod tests;
