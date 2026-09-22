use super::*;

#[test]
fn empty_store_evidence_is_strict_and_bound_to_the_exact_role_tree() {
    let directory = tempfile::tempdir().unwrap();
    let evidence = new_evidence(
        "10000000-0000-4000-8000-000000000001".to_owned(),
        rion_platform::Platform::Macos,
    );
    prepare_empty_store(directory.path(), &evidence).unwrap();
    let role = directory.path().join("roles").join(&evidence.role_id);
    verify_tree(&role, &evidence, true).unwrap();

    let marker = role.join(MARKER_FILE_NAME);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    value["unknownField"] = serde_json::json!(true);
    fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(read_marker(&marker).is_err());
}

#[cfg(unix)]
#[test]
fn marker_symlinks_fail_closed() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let evidence = new_evidence(
        "10000000-0000-4000-8000-000000000002".to_owned(),
        rion_platform::Platform::Macos,
    );
    prepare_empty_store(directory.path(), &evidence).unwrap();
    let marker = marker_path(directory.path(), &evidence.role_id);
    let replacement = directory.path().join("replacement.json");
    fs::write(&replacement, serde_json::to_vec(&evidence).unwrap()).unwrap();
    fs::remove_file(&marker).unwrap();
    symlink(&replacement, &marker).unwrap();
    assert!(read_marker(&marker).is_err());
}

#[test]
fn noncanonical_role_identity_is_rejected_before_path_construction() {
    let directory = tempfile::tempdir().unwrap();
    let mut evidence = new_evidence(
        "10000000-0000-4000-8000-000000000003".to_owned(),
        rion_platform::Platform::Macos,
    );
    evidence.role_id = "../escape".to_owned();
    assert!(prepare_empty_store(directory.path(), &evidence).is_err());
    assert!(!directory.path().join("escape").exists());
}

#[cfg(windows)]
#[test]
fn windows_marker_reader_does_not_block_role_publication() {
    use std::os::windows::fs::OpenOptionsExt;

    let directory = tempfile::tempdir().unwrap();
    let evidence = new_evidence(Uuid::new_v4().to_string(), rion_platform::Platform::Windows);
    let mut reader = None;
    let mut directory_reader = None;
    prepare_empty_store_with_marker(directory.path(), &evidence, |path, evidence| {
        directory_reader = Some(
            OpenOptions::new()
                .read(true)
                .share_mode(3)
                .custom_flags(0x0200_0000)
                .open(path.parent().unwrap())
                .unwrap(),
        );
        write_marker(path, evidence)?;
        // Model an indexer opening the newly created marker before publication
        // completes. Rust's default reader already allows FILE_SHARE_DELETE.
        reader = Some(File::open(path).unwrap());
        Ok(())
    })
    .unwrap();
    let role = directory.path().join("roles").join(&evidence.role_id);
    verify_tree(&role, &evidence, true).unwrap();
    assert!(fs::rename(&role, directory.path().join("renamed")).is_err());
    drop(reader);
    drop(directory_reader);
}

#[test]
fn existing_role_tree_is_never_replaced_or_cleaned_up() {
    let directory = tempfile::tempdir().unwrap();
    let evidence = new_evidence(
        "10000000-0000-4000-8000-000000000004".to_owned(),
        rion_platform::Platform::Windows,
    );
    let roles = directory.path().join("roles");
    ensure_roles_directory(&roles).expect("create and protect roles directory");
    let destination = roles.join(&evidence.role_id);
    fs::create_dir(&destination).unwrap();
    let sentinel = destination.join("existing-data");
    fs::write(&sentinel, b"preserve").unwrap();
    assert!(prepare_empty_store(directory.path(), &evidence).is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve");
}

#[test]
fn failed_marker_cannot_become_ready_or_replace_its_reserved_tree() {
    let directory = tempfile::tempdir().unwrap();
    let evidence = new_evidence(Uuid::new_v4().to_string(), rion_platform::Platform::Windows);
    assert!(
        prepare_empty_store_with_marker(directory.path(), &evidence, |path, _| {
            fs::write(path, b"incomplete").unwrap();
            Err(initialization_error())
        })
        .is_err()
    );
    let role = directory.path().join("roles").join(&evidence.role_id);
    assert!(verify_tree(&role, &evidence, true).is_err());
    assert!(prepare_empty_store(directory.path(), &evidence).is_err());
    assert_eq!(
        fs::read(role.join(MARKER_FILE_NAME)).unwrap(),
        b"incomplete"
    );
}
