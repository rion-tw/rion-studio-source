use std::process::Command;

use crate::{Platform, PlatformError};

const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub fn query_windows_display_driver_events(
    platform: Platform,
) -> Result<Option<String>, PlatformError> {
    if platform != Platform::Windows {
        return Ok(None);
    }
    let output = Command::new("wevtutil")
        .args([
            "qe",
            "System",
            "/q:*[System[(EventID=4101)]]",
            "/f:RenderedXml",
            "/rd:true",
            "/c:24",
        ])
        .output()
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    if !output.status.success() {
        return Err(PlatformError::Operation(
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(256)
                .collect(),
        ));
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err(PlatformError::Operation(
            "Windows graphics event output exceeded 2 MiB".to_owned(),
        ));
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_windows_tools_on_macos() {
        {
            assert_eq!(
                query_windows_display_driver_events(Platform::Macos).unwrap(),
                None
            );
        };
    }
}
