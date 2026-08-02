//! Operating-system adapters used by the Rust application core.

use serde::{Deserialize, Serialize};
use thiserror::Error;

mod browser_proxy;
pub use browser_proxy::{
    BROWSER_PROXY_PREFLIGHT_TIMEOUT, BrowserProxyEndpoint, BrowserProxyPreflight,
    BrowserProxyProtocol, browser_proxy_fingerprint, preflight_browser_proxy,
    webview2_browser_arguments,
};
mod filesystem;
pub use filesystem::{atomic_replace_file, restrict_directory_to_current_user};
mod chrome_profile;
pub use chrome_profile::{
    ChromeProfileEntry, chrome_profile_source_fingerprint, chrome_user_data_in_use,
    default_chrome_user_data_directory, discover_chrome_profiles,
};
mod chrome_cookie;
pub use chrome_cookie::{
    CookieDecryptor, decrypt_chrome_cookie, decrypt_mac_cookie_payload,
    decrypt_windows_aes_gcm_payload,
};
mod protected_data;
pub use protected_data::{protect_session_transfer, unprotect_session_transfer};
mod system_fonts;
pub use system_fonts::query_system_font_names;
mod system;
pub use system::{
    SystemHostDiagnostics, collect_system_host_diagnostics, request_graceful_chrome_quit,
};
mod system_webview;
pub use system_webview::{SystemWebViewProbe, probe_system_webview};
mod windows_events;
pub use windows_events::query_windows_display_driver_events;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
}

impl Platform {
    pub fn parse(value: &str) -> Result<Self, PlatformError> {
        match value {
            "darwin" | "macos" => Ok(Self::Macos),
            "win32" | "windows" => Ok(Self::Windows),
            other => Err(PlatformError::Unsupported(other.to_owned())),
        }
    }
}

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("unsupported platform: {0}")]
    Unsupported(String),
    #[error("platform operation failed: {0}")]
    Operation(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PixelBounds {
    pub fn validate(self) -> Result<Self, PlatformError> {
        if self.width <= 0 || self.height <= 0 {
            return Err(PlatformError::Operation(
                "window bounds must have a positive size".to_owned(),
            ));
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_explicit_macos_and_windows_names_and_rejects_other_platforms() {
        assert_eq!(Platform::parse("darwin").unwrap(), Platform::Macos);
        assert_eq!(Platform::parse("windows").unwrap(), Platform::Windows);
        {
            assert!(matches!(
                Platform::parse("linux"),
                Err(PlatformError::Unsupported(platform)) if platform == "linux"
            ));
        };
    }
}
