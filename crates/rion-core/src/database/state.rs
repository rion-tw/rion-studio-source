//! SQLite state worker, schema, queries, mutations, journaling, and recovery.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("state/section_01_schema_version.rs");
include!("state/section_02_apply_domain_mutation.rs");
include!("state/section_03_retired_data_migrations.rs");
include!("state/section_03_game_window_role_slot_migration.rs");
include!("state/section_03_game_window_workspace_slot_migration.rs");
include!("state/section_03_quick_access_shortcut_migration.rs");
include!("state/section_03_workspace_web_slot_migration.rs");
include!("state/section_03_read_overlay_configuration.rs");
include!("state/section_04_entity_image.rs");
include!("state/section_04_quick_access.rs");

#[cfg(test)]
mod tests;
