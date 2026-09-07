//! Rust-owned extension packages and per-role desired configuration.
mod crx;
mod package;

use crate::model::{ExtensionPreparedRecord, ExtensionRoleRecord};
use std::{
    collections::{HashMap, HashSet},
    io,
    sync::{Arc, atomic::AtomicBool},
};
type Result<T> = std::result::Result<T, io::Error>;
fn failure(message: &str) -> io::Error {
    io::Error::other(message)
}

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
    let base = root.join("extensions");
    std::fs::create_dir_all(&base)?;
    let directory = tempfile::Builder::new()
        .prefix("staging-")
        .tempdir_in(base)?;
    let (manifest, sha256) = package::unpack(&bytes, id, directory.path())?;
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
                permissions,
                sha256,
                directory: directory.path().to_string_lossy().into_owned(),
                enabled_role_ids: Vec::new(),
                removed: false,
            },
        },
        directory,
    ))
}

#[cfg(test)]
mod tests;
