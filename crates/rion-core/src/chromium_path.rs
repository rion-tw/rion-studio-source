use std::path::Path;

/// Serialize an already Rust-resolved path for Chromium without changing the
/// physical path used for filesystem ownership and symlink validation.
pub(crate) fn engine_path(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    #[cfg(windows)]
    {
        Some(windows_engine_path(path))
    }
    #[cfg(not(windows))]
    {
        Some(path.to_owned())
    }
}

#[cfg(any(windows, test))]
fn windows_engine_path(path: &str) -> String {
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{path}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_and_global_web_paths_share_the_windows_engine_boundary() {
        for suffix in [
            r"roles\role-1\browser\chromium",
            r"web-profiles\global-web\chromium",
        ] {
            assert_eq!(
                windows_engine_path(&format!(r"\\?\C:\RionData\{suffix}")),
                format!(r"C:\RionData\{suffix}")
            );
            assert_eq!(
                windows_engine_path(&format!(r"\\?\UNC\server\share\{suffix}")),
                format!(r"\\server\share\{suffix}")
            );
            let ordinary = format!(r"C:\RionData\{suffix}");
            assert_eq!(windows_engine_path(&ordinary), ordinary);
        }
    }

    #[test]
    fn role_paths_can_be_reopened_after_canonical_root_serialization() {
        let directory = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(directory.path()).unwrap();
        let role = crate::role_browser_data::ensure(&canonical, "role-1").unwrap();
        let store = Path::new(&role.chromium_user_data_dir);
        let marker = store.join("path-boundary-test");
        std::fs::write(&marker, b"retained").unwrap();
        let reopened = crate::role_browser_data::paths(directory.path(), "role-1").unwrap();
        assert_eq!(
            std::fs::read(Path::new(&reopened.chromium_user_data_dir).join("path-boundary-test"))
                .unwrap(),
            b"retained"
        );
        #[cfg(windows)]
        assert!(!role.chromium_user_data_dir.starts_with(r"\\?\"));
    }
}
