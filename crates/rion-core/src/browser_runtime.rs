//! Authoritative browser runtime windows, tabs, roles, visibility, and transitions.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("browser_runtime/section_01_browser_runtime.rs");

#[cfg(test)]
mod tests;
