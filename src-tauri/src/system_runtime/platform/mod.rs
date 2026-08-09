//! Compile-time selected native platform adapters.
//!
//! The parent System Runtime is an effect executor. Platform modules translate
//! those effects into AppKit/WKWebView or Win32/WebView2 calls and translate
//! acknowledgements back into the shared event envelope.

#[cfg(target_os = "macos")]
pub(super) mod macos;

#[cfg(any(windows, test))]
pub(super) mod windows;

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) mod unsupported;
