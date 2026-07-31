//! SQLite state worker, schema, queries, mutations, journaling, and recovery.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("state/section_01_schema_version.rs");
include!("state/section_02_apply_domain_mutation.rs");
include!("state/section_03_read_overlay_configuration.rs");
include!("state/section_04_entity_image.rs");

#[cfg(test)]
mod tests;
