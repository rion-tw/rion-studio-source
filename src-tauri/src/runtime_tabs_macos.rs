//! macOS runtime tab bridge and AppKit wrapper lifecycle.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("runtime_tabs_macos/section_01_controller_creation_timeout.rs");
include!("runtime_tabs_macos/section_02_labels.rs");

#[cfg(test)]
mod tests;
