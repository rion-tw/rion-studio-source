fn session_transfer_vault_paths(
    user_data_dir: &Path,
    role_id: &str,
    transfer_id: &str,
) -> CoreResult<SessionTransferVaultPaths> {
    if !user_data_dir.is_absolute() {
        return Err(vault_path_error());
    }
    validate_canonical_uuid(role_id).map_err(|_| vault_path_error())?;
    validate_canonical_uuid(transfer_id).map_err(|_| vault_path_error())?;
    let vault_root = user_data_dir.join(SESSION_MIGRATION_DIRECTORY);
    let role_directory = vault_root.join(role_id);
    let transfer_directory = role_directory.join(transfer_id);
    let inventory_file = transfer_directory.join(SESSION_TRANSFER_INVENTORY_FILE);
    Ok(SessionTransferVaultPaths {
        vault_root,
        role_directory,
        transfer_directory,
        inventory_file,
    })
}

fn ensure_vault_directories(
    user_data_dir: &Path,
    paths: &SessionTransferVaultPaths,
) -> CoreResult<()> {
    validate_real_directory(user_data_dir)?;
    let mut parent = user_data_dir;
    for directory in [
        &paths.vault_root,
        &paths.role_directory,
        &paths.transfer_directory,
    ] {
        match fs::symlink_metadata(directory) {
            Ok(_) => validate_real_directory(directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(directory).map_err(|_| vault_io_error())?;
                sync_directory(parent)?;
                validate_real_directory(directory)?;
            }
            Err(_) => return Err(vault_io_error()),
        }
        restrict_directory_permissions(directory)?;
        parent = directory;
    }
    validate_directory_containment(user_data_dir, &paths.transfer_directory)
}

fn validate_existing_vault_directories(
    user_data_dir: &Path,
    paths: &SessionTransferVaultPaths,
) -> CoreResult<()> {
    for directory in [
        user_data_dir,
        paths.vault_root.as_path(),
        paths.role_directory.as_path(),
        paths.transfer_directory.as_path(),
    ] {
        match validate_real_directory(directory) {
            Ok(()) => {}
            Err(error) => match fs::symlink_metadata(directory) {
                Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(vault_not_found_error());
                }
                _ => return Err(error),
            },
        }
    }
    for directory in [
        paths.vault_root.as_path(),
        paths.role_directory.as_path(),
        paths.transfer_directory.as_path(),
    ] {
        enforce_restricted_directory_permissions_for_read(directory)?;
    }
    validate_directory_containment(user_data_dir, &paths.transfer_directory)
}

fn validate_directory_containment(user_data_dir: &Path, directory: &Path) -> CoreResult<()> {
    let managed_root = fs::canonicalize(user_data_dir).map_err(|_| vault_path_error())?;
    let resolved = fs::canonicalize(directory).map_err(|_| vault_path_error())?;
    if !resolved.starts_with(&managed_root) {
        return Err(vault_path_error());
    }
    Ok(())
}

fn validate_real_directory(path: &Path) -> CoreResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| vault_path_error())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(vault_path_error());
    }
    Ok(())
}

fn path_exists(path: &Path) -> CoreResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_regular_file_metadata(&metadata)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(vault_io_error()),
    }
}

fn clean_orphaned_vault_temps(transfer_directory: &Path) -> CoreResult<()> {
    // AppCore calls this under its vault mutex and process-wide instance lock,
    // so a canonical temp name cannot belong to another live writer. Only
    // crash leftovers are removed; `inventory.enc` is never a cleanup target.
    let mut removed = false;
    let entries = fs::read_dir(transfer_directory).map_err(|_| vault_io_error())?;
    for entry in entries {
        let entry = entry.map_err(|_| vault_io_error())?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(candidate_id) = name
            .strip_prefix(".inventory.enc.")
            .and_then(|name| name.strip_suffix(".tmp"))
        else {
            continue;
        };
        let Ok(uuid) = Uuid::parse_str(candidate_id) else {
            continue;
        };
        if uuid.to_string() != candidate_id {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| vault_io_error())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
        {
            return Err(vault_file_error());
        }
        fs::remove_file(entry.path()).map_err(|_| vault_io_error())?;
        removed = true;
    }
    if removed {
        sync_directory(transfer_directory)?;
    }
    Ok(())
}

fn write_protected_file(path: &Path, protected: &[u8]) -> CoreResult<()> {
    if protected.is_empty()
        || protected.len() > rion_platform::SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES
    {
        return Err(vault_size_error());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| vault_io_error())?;
    file.write_all(protected).map_err(|_| vault_io_error())?;
    file.sync_all().map_err(|_| vault_io_error())?;
    drop(file);
    restrict_file_permissions(path)
}

fn read_protected_file(path: &Path) -> CoreResult<Vec<u8>> {
    let path_metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            vault_not_found_error()
        } else {
            vault_io_error()
        }
    })?;
    validate_regular_file_metadata(&path_metadata)?;
    let file = open_read_without_following_reparse_points(path)?;
    rion_platform::verify_open_file_identity(path, &file).map_err(|_| vault_file_error())?;
    let handle_metadata = file.metadata().map_err(|_| vault_io_error())?;
    validate_regular_file_metadata(&handle_metadata)?;
    let mut protected = Vec::with_capacity(handle_metadata.len() as usize);
    file.take((rion_platform::SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES + 1) as u64)
        .read_to_end(&mut protected)
        .map_err(|_| vault_io_error())?;
    if protected.is_empty()
        || protected.len() > rion_platform::SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES
    {
        return Err(vault_size_error());
    }
    Ok(protected)
}

fn validate_regular_file_metadata(metadata: &fs::Metadata) -> CoreResult<()> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(metadata)
    {
        return Err(vault_file_error());
    }
    if metadata.len() == 0
        || metadata.len() > rion_platform::SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES as u64
    {
        return Err(vault_size_error());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(vault_permissions_error());
        }
    }
    Ok(())
}

fn open_read_without_following_reparse_points(path: &Path) -> CoreResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x0000_0100); // O_NOFOLLOW
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x0002_0000); // O_NOFOLLOW
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options.open(path).map_err(|_| vault_file_error())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| vault_permissions_error())
}

#[cfg(unix)]
fn enforce_restricted_directory_permissions_for_read(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    // Read is allowed only after a drifted vault directory has been repaired
    // back to owner-only access. Failure to repair stops before file open.
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| vault_permissions_error())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| vault_permissions_error())?;
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(vault_permissions_error());
    }
    Ok(())
}

#[cfg(windows)]
fn restrict_directory_permissions(path: &Path) -> CoreResult<()> {
    rion_platform::restrict_directory_to_current_user(path).map_err(|_| vault_permissions_error())
}

#[cfg(windows)]
fn enforce_restricted_directory_permissions_for_read(path: &Path) -> CoreResult<()> {
    // Windows reads use an explicit fail-closed ACL repair: the protected
    // current-user DACL is reapplied before the inventory file can be opened.
    // This also keeps inherited permissions from silently widening on retry.
    rion_platform::restrict_directory_to_current_user(path).map_err(|_| vault_permissions_error())
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| vault_permissions_error())
}

#[cfg(windows)]
fn restrict_file_permissions(path: &Path) -> CoreResult<()> {
    let parent = path.parent().ok_or_else(vault_path_error)?;
    rion_platform::restrict_directory_to_current_user(parent).map_err(|_| vault_permissions_error())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> CoreResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| vault_io_error())
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> CoreResult<()> {
    // `atomic_replace_file` uses MOVEFILE_WRITE_THROUGH on Windows. That API
    // does not return until the move and its directory metadata are flushed.
    Ok(())
}

struct PendingVaultFile {
    path: PathBuf,
    committed: bool,
}

impl PendingVaultFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PendingVaultFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}
