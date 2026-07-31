//! SQLite log worker, queries, export, and retention.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("logs/section_01_retention_days.rs");
include!("logs/section_02_enforce_retention_with_policy.rs");

#[cfg(test)]
mod tests;
