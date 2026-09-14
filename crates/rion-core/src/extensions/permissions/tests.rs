use super::*;
use crate::{extensions::backfill_metadata, model::ExtensionPackageRecord};
use serde_json::{Value, json};

fn manifest() -> Value {
    json!({"manifest_version": 3, "name": "Fixture", "version": "1"})
}

#[test]
fn required_permissions_exclude_optional_and_host_permissions() {
    let mut value = manifest();
    value["permissions"] = json!(["storage", "alarms", "storage"]);
    value["optional_permissions"] = json!(["management", "storage"]);
    value["host_permissions"] = json!(["https://example.com/*"]);
    value["optional_host_permissions"] = json!(["https://optional.example/*"]);
    assert_eq!(
        required_api_permissions(&value).unwrap(),
        ["alarms", "storage"]
    );
    value["permissions"] = json!(["management"]);
    assert_eq!(required_api_permissions(&value).unwrap(), ["management"]);
    value["permissions"] = json!([]);
    assert!(required_api_permissions(&value).unwrap().is_empty());
    assert!(required_api_permissions(&manifest()).unwrap().is_empty());
}

#[test]
fn invalid_permission_metadata_never_becomes_an_empty_list() {
    for invalid in [
        Value::Null,
        json!("storage"),
        json!(["storage", 7]),
        json!([""]),
    ] {
        let mut value = manifest();
        value["permissions"] = invalid;
        assert!(required_api_permissions(&value).is_err());
    }
    for invalid in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"manifest_version": 2}),
    ] {
        assert!(required_api_permissions(&invalid).is_err());
    }
}

fn legacy_record(directory: &std::path::Path) -> ExtensionPackageRecord {
    serde_json::from_value(json!({
        "id": "a".repeat(32), "name": "Fixture", "version": "1",
        "description": "Already complete", "sizeBytes": 100,
        "permissions": ["storage", "management"], "sha256": "0".repeat(64),
        "directory": directory, "enabledRoleIds": ["role"],
        "applyToAllRoles": true, "removed": true
    }))
    .unwrap()
}

#[test]
fn complete_legacy_display_metadata_still_backfills_permissions_once() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("extensions").join("fixture");
    std::fs::create_dir_all(&directory).unwrap();
    let mut value = manifest();
    value["permissions"] = json!(["storage"]);
    value["optional_permissions"] = json!(["management"]);
    let bytes = serde_json::to_vec(&value).unwrap();
    let path = directory.join("manifest.json");
    std::fs::write(&path, &bytes).unwrap();
    let mut record = legacy_record(&directory);
    let mut expected = serde_json::to_value(&record).unwrap();
    assert!(record.required_api_permissions.is_none());
    assert!(backfill_metadata(root.path(), &mut record).unwrap());
    expected["requiredApiPermissions"] = json!(["storage"]);
    assert_eq!(serde_json::to_value(&record).unwrap(), expected);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    std::fs::remove_file(path).unwrap();
    assert!(!backfill_metadata(root.path(), &mut record).unwrap());
}

#[test]
fn failed_backfills_preserve_unknown_permissions_and_original_record() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("extensions").join("fixture");
    std::fs::create_dir_all(&directory).unwrap();
    for bytes in [None, Some(b"not json".as_slice()), Some(b"{}".as_slice())] {
        if let Some(bytes) = bytes {
            std::fs::write(directory.join("manifest.json"), bytes).unwrap();
        }
        let mut record = legacy_record(&directory);
        let original = serde_json::to_value(&record).unwrap();
        assert!(backfill_metadata(root.path(), &mut record).is_err());
        assert_eq!(serde_json::to_value(record).unwrap(), original);
    }
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(
        outside.join("manifest.json"),
        serde_json::to_vec(&manifest()).unwrap(),
    )
    .unwrap();
    assert!(backfill_metadata(root.path(), &mut legacy_record(&outside)).is_err());
}
