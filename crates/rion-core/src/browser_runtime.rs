//! Role ownership runtime and its tab/slot identity projection.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("browser_runtime/section_01_browser_runtime.rs");
include!("browser_runtime/section_02_runtime_validation.rs");

#[cfg(test)]
mod tests;
