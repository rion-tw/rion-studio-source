//! Canonical, bounded v22 System WebView to v23 Chromium session-transfer contract.
//!
//! The envelope owns secret-bearing cookie and LocalStorage bytes. It deliberately
//! remains a Rust-only Core contract until a native transfer adapter is introduced;
//! renderer-facing APIs receive only the non-secret migration journal metadata.

include!("session_transfer/section_01_contract.rs");
include!("session_transfer/section_02_canonical.rs");
include!("session_transfer/section_03_vault.rs");
include!("session_transfer/section_04_vault_filesystem.rs");
include!("session_transfer/section_05_vault_errors.rs");
include!("session_transfer/section_06_webview2_source.rs");

#[cfg(test)]
mod tests;
