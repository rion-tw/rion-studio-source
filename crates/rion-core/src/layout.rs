//! Workspace layout, divider geometry, visibility, and adaptive zoom.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("layout/section_01_divider_epsilon.rs");

#[cfg(test)]
mod tests;
