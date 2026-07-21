use std::{env, path::PathBuf};

use crate::{Platform, PlatformError};

pub fn find_chrome_executable(platform: Platform) -> Result<PathBuf, PlatformError> {
    for variable in ["RION_STUDIO_CHROME_PATH", "CHROME_PATH"] {
        if let Some(path) = env::var_os(variable).map(PathBuf::from)
            && path.is_file()
        {
            return Ok(path);
        }
    }

    chrome_candidates(platform)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            PlatformError::Operation(
                "Google Chrome was not found. Install Chrome or set RION_STUDIO_CHROME_PATH to the Chrome executable."
                    .to_owned(),
            )
        })
}

fn chrome_candidates(platform: Platform) -> Vec<PathBuf> {
    match platform {
        Platform::Macos => {
            let mut candidates = vec![PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )];
            if let Some(home) = env::var_os("HOME") {
                candidates.push(
                    PathBuf::from(home)
                        .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                );
            }
            candidates
        }
        Platform::Windows => {
            let mut candidates = Vec::new();
            if let Some(program_files) = env::var_os("PROGRAMFILES") {
                candidates.push(
                    PathBuf::from(program_files).join("Google/Chrome/Application/chrome.exe"),
                );
            }
            if let Some(program_files_x86) = env::var_os("PROGRAMFILES(X86)") {
                candidates.push(
                    PathBuf::from(program_files_x86).join("Google/Chrome/Application/chrome.exe"),
                );
            }
            if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
                candidates.push(
                    PathBuf::from(local_app_data).join("Google/Chrome/Application/chrome.exe"),
                );
            }
            candidates
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_tables_are_platform_specific() {
        assert!(
            chrome_candidates(Platform::Macos)
                .iter()
                .all(|path| !path.to_string_lossy().ends_with("chrome.exe"))
        );
        assert!(
            chrome_candidates(Platform::Windows)
                .iter()
                .all(|path| path.to_string_lossy().ends_with("chrome.exe"))
        );
    }
}
