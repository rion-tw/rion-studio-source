//! Browser font catalog validation, downloads, cache, and runtime payloads.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("font_catalog/section_01_cache_directory.rs");
include!("font_catalog/section_02_install_pack.rs");

#[cfg(test)]
mod tests;
