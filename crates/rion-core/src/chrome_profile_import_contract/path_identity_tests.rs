use super::*;

#[test]
fn canonical_physical_root_validates_before_engine_path_serialization() {
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let role_id = "11111111-1111-4111-8111-111111111111";
    let paths = canonical_role_paths(&root, role_id).unwrap();
    let physical = crate::role_browser_data::browser_directory(&root, role_id).join("chromium");
    fs::create_dir_all(&physical).unwrap();
    assert_eq!(
        fs::canonicalize(&paths.chromium_user_data_dir).unwrap(),
        physical
    );
    #[cfg(windows)]
    {
        assert!(root.to_string_lossy().starts_with(r"\\?\"));
        assert!(!paths.chromium_user_data_dir.starts_with(r"\\?\"));
    }
}

#[test]
fn physical_intermediate_file_is_still_rejected() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("roles"), b"not a directory").unwrap();
    let error =
        canonical_role_paths(directory.path(), "11111111-1111-4111-8111-111111111111").unwrap_err();
    assert_eq!(error.code(), "CHROME_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH");
}
