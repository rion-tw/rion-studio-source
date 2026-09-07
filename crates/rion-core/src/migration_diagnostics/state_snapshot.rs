use super::{Result, paths, snapshot};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

const FILES: [&str; 2] = ["rion-studio.sqlite3", "rion-studio.sqlite3-wal"];

/// Caller holds the source Core lock. SQLite opens only the private copy: even
/// a READ_ONLY connection to a live WAL database can write shared-memory marks.
pub(super) fn copy(source: &Path, output: &Path) -> Result<(tempfile::TempDir, String)> {
    let temporary = tempfile::Builder::new()
        .prefix("plaintext-state-")
        .tempdir_in(output)
        .map_err(|_| "STATE_COPY_FAILED")?;
    rion_platform::restrict_directory_to_current_user(temporary.path())
        .map_err(|_| "STATE_COPY_FAILED")?;
    let digest = collect(source, Some(temporary.path()))?;
    Ok((temporary, digest))
}

pub(super) fn digest(source: &Path) -> Result<String> {
    collect(source, None)
}

fn collect(source: &Path, destination: Option<&Path>) -> Result<String> {
    let mut hash = Sha256::new();
    for name in FILES {
        let path = source.join(name);
        if !path.try_exists().map_err(|_| "STATE_SOURCE_UNAVAILABLE")? {
            if name == FILES[0] {
                return Err("STATE_SOURCE_UNAVAILABLE");
            }
            continue;
        }
        paths::existing(&path)?;
        let mut file = snapshot::open_file(&path)?;
        rion_platform::verify_open_file_identity(&path, &file)
            .map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(40 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "STATE_SOURCE_UNAVAILABLE")?;
        if bytes.len() > 40 * 1024 * 1024 {
            return Err("STATE_SIZE_LIMIT");
        }
        rion_platform::verify_open_file_identity(&path, &file)
            .map_err(|_| "SOURCE_IDENTITY_CHANGED")?;
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(&bytes);
        if let Some(destination) = destination {
            fs::write(destination.join(name), bytes).map_err(|_| "STATE_COPY_FAILED")?;
        }
    }
    Ok(hex::encode(hash.finalize()))
}
