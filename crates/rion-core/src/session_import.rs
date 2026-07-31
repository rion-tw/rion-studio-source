//! Bounded Chrome cookie and exact-origin LocalStorage import.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("session_import/section_01_chrome_epoch_offset_seconds.rs");

#[cfg(test)]
mod tests;
