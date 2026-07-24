//! Operating-system adapters used by the Rust application core.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[cfg(test)]
macro_rules! v1_case {
    ($id:expr, $assertions:block) => {{
        let v1_case_id: &str = $id;
        assert!(
            !v1_case_id.is_empty(),
            "v1 parity case identifiers must not be empty"
        );
        $assertions
    }};
}

#[cfg(test)]
pub(crate) use v1_case;

mod pressure;
pub use pressure::{SystemPressureSample, SystemPressureSampler};
mod process;
pub use process::{ExternalProcessExit, ExternalProcessSupervisor};
mod filesystem;
pub use filesystem::atomic_replace_file;
mod system_fonts;
pub use system_fonts::query_system_font_names;
mod system;
pub use system::{
    SystemHostDiagnostics, collect_system_host_diagnostics, request_graceful_chrome_quit,
};
mod windows_events;
pub use windows_events::query_windows_display_driver_events;

mod chrome;
pub use chrome::find_chrome_executable;
mod chrome_profile;
pub use chrome_profile::{
    ChromeProfileEntry, copy_chrome_profile, default_chrome_user_data_directory,
    discover_chrome_profiles,
};
mod chrome_cookie;
pub use chrome_cookie::{decrypt_chrome_cookie, decrypt_mac_cookie_payload};
#[cfg_attr(not(windows), allow(dead_code))]
mod window_frame;
#[cfg(windows)]
pub(crate) use window_frame::{
    WindowCandidateMetadata, WindowFrameBackend, align_visible_frame_with_backend,
    candidate_matches_process, select_best_candidate, validate_alignment_request,
};

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
        v1_case!("resource-platform-cde9bcfa139b", {
            assert!(matches!(
                Platform::parse("linux"),
                Err(PlatformError::Unsupported(platform)) if platform == "linux"
            ));
        });
    }
}

#[cfg(windows)]
pub mod windows;
