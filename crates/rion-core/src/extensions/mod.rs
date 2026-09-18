//! Rust-owned extension packages and per-role desired configuration.
mod crx;
mod error;
mod package;
mod permissions;

use crate::model::{ExtensionPackageRecord, ExtensionPreparedRecord, ExtensionRoleRecord};
pub(crate) use error::ExtensionPackageError;
use error::Result;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, atomic::AtomicBool},
};

#[derive(Default)]
pub(crate) struct ExtensionRuntime {
    pub downloads: HashMap<String, Arc<AtomicBool>>,
    pub prepared: HashMap<String, (ExtensionPreparedRecord, tempfile::TempDir)>,
    pub roles: HashMap<String, ExtensionRoleRecord>,
    pub revision: u64,
    pub cancelled: HashSet<String>,
}

pub(crate) fn prepare(
    root: &std::path::Path,
    id: &str,
    operation: &str,
    cancelled: &AtomicBool,
) -> Result<(ExtensionPreparedRecord, tempfile::TempDir)> {
    let bytes = package::download(id, cancelled)?;
    prepare_downloaded(root, id, operation, cancelled, &bytes)
}

fn prepare_downloaded(
    root: &std::path::Path,
    id: &str,
    operation: &str,
    cancelled: &AtomicBool,
    bytes: &[u8],
) -> Result<(ExtensionPreparedRecord, tempfile::TempDir)> {
    let base = root.join("extensions");
    std::fs::create_dir_all(&base)?;
    let directory = tempfile::Builder::new()
        .prefix("staging-")
        .tempdir_in(base)?;
    let (manifest, sha256, metadata) = package::unpack(bytes, id, directory.path(), cancelled)?;
    let mut permissions: Vec<String> = [
        "permissions",
        "host_permissions",
        "optional_permissions",
        "optional_host_permissions",
    ]
    .iter()
    .flat_map(|key| manifest[*key].as_array().into_iter().flatten())
    .filter_map(|v| v.as_str().map(str::to_owned))
    .collect();
    for script in manifest["content_scripts"].as_array().into_iter().flatten() {
        for origin in script["matches"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
        {
            permissions.push(origin.to_owned());
        }
    }
    permissions.sort();
    permissions.dedup();
    Ok((
        ExtensionPreparedRecord {
            operation_id: operation.to_owned(),
            package: crate::model::ExtensionPackageRecord {
                id: id.to_owned(),
                name: package::display_name(&manifest, directory.path(), id),
                version: manifest["version"].as_str().unwrap().to_owned(),
                description: Some(metadata.description),
                icon_data_url: metadata.icon_data_url,
                size_bytes: Some(metadata.size_bytes),
                permissions,
                required_api_permissions: Some(permissions::required_api_permissions(&manifest)?),
                sha256,
                directory: directory.path().to_string_lossy().into_owned(),
                enabled_role_ids: Vec::new(),
                apply_to_all_roles: false,
                removed: false,
            },
        },
        directory,
    ))
}

/// Resolves a catalogue record's directory to a real path that is a direct
/// child of the managed `extensions` root.
///
/// The comparison is made on canonical paths on both sides. A lexical
/// `Path::parent()` check is not a containment proof: `..` is an ordinary
/// path component, so `<user_data>/extensions/..` has `<user_data>/extensions`
/// as its lexical parent while actually naming `<user_data>` itself.
pub(crate) fn managed_package_directory(
    user_data_dir: &std::path::Path,
    directory: &str,
) -> Result<std::path::PathBuf> {
    let managed_root = std::fs::canonicalize(user_data_dir.join("extensions"))?;
    let directory = std::fs::canonicalize(directory)?;
    if directory.parent() != Some(managed_root.as_path()) {
        return Err(ExtensionPackageError::PackageInvalid);
    }
    Ok(directory)
}

pub(crate) fn backfill_metadata(
    user_data_dir: &std::path::Path,
    record: &mut ExtensionPackageRecord,
) -> Result<bool> {
    let needs_display = record.description.is_none() || record.size_bytes.is_none();
    if !needs_display && record.required_api_permissions.is_some() {
        return Ok(false);
    }
    let directory = managed_package_directory(user_data_dir, &record.directory)?;
    // Gather every fallible value before changing the durable record.
    let required = if record.required_api_permissions.is_none() {
        Some(permissions::required_api_permissions(
            &package::installed_manifest(&directory)?,
        )?)
    } else {
        None
    };
    let metadata = if needs_display {
        Some(package::installed_metadata(&directory)?)
    } else {
        None
    };
    let mut changed = false;
    if let Some(required) = required {
        record.required_api_permissions = Some(required);
        changed = true;
    }
    let Some(metadata) = metadata else {
        return Ok(changed);
    };
    if record.description.is_none() {
        record.description = Some(metadata.description);
        changed = true;
    }
    if record.icon_data_url.is_none() {
        record.icon_data_url = metadata.icon_data_url;
        changed |= record.icon_data_url.is_some();
    }
    if record.size_bytes.is_none() {
        record.size_bytes = Some(metadata.size_bytes);
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests;
