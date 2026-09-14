use super::{ExtensionPackageError, error::Result};

/// Required API permissions are distinct from optional grants and display metadata.
pub(super) fn required_api_permissions(manifest: &serde_json::Value) -> Result<Vec<String>> {
    if !manifest.is_object()
        || manifest["manifest_version"] != 3
        || manifest["name"].as_str().is_none()
        || manifest["version"].as_str().is_none()
    {
        return Err(ExtensionPackageError::ManifestUnsupported);
    }
    let Some(value) = manifest.get("permissions") else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or(ExtensionPackageError::ManifestUnsupported)?;
    let mut permissions = values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|permission| !permission.is_empty())
                .map(str::to_owned)
                .ok_or(ExtensionPackageError::ManifestUnsupported)
        })
        .collect::<Result<Vec<_>>>()?;
    permissions.sort();
    permissions.dedup();
    Ok(permissions)
}

#[cfg(test)]
mod tests;
