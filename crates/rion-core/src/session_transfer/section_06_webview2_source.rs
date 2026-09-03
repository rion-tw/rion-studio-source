use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

use rusty_leveldb::{DB, LdbIterator, MemEnv, Options, env::Env};

const WEBVIEW2_LOCAL_STORAGE_DIRECTORY: &str = "Local Storage";
const WEBVIEW2_LOCAL_STORAGE_LEVELDB_DIRECTORY: &str = "leveldb";
const WEBVIEW2_LOCAL_STORAGE_SNAPSHOT_DIRECTORY: &str = "webview2-local-storage";
const WEBVIEW2_LOCAL_STORAGE_MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const WEBVIEW2_LOCAL_STORAGE_MAX_SNAPSHOT_FILES: usize = 4_096;

pub(crate) fn pending_session_transfer_vault_evidence(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
) -> CoreResult<Option<RoleSessionTransferJournalEvidence>> {
    pending_session_transfer_vault_evidence_with(
        user_data_dir,
        platform,
        journal,
        &Rsp2SessionTransferProtector,
    )
}

fn pending_session_transfer_vault_evidence_with(
    user_data_dir: &Path,
    platform: rion_platform::Platform,
    journal: &RoleSessionMigrationRecord,
    protector: &impl SessionTransferProtector,
) -> CoreResult<Option<RoleSessionTransferJournalEvidence>> {
    validate_new_vault_write_journal(journal)?;
    let paths =
        session_transfer_vault_paths(user_data_dir, &journal.role_id, &journal.transfer_id)?;
    if !path_exists(&paths.inventory_file)? {
        return Ok(None);
    }
    let envelope =
        read_session_transfer_vault_with(user_data_dir, platform, journal, false, protector)?;
    envelope.journal_evidence().map(Some)
}

/// Reads a stopped WebView2 profile's LocalStorage into the canonical Rust-only
/// transfer contract. The caller must establish the browser-process release
/// boundary first; this reader never opens a live store and never repairs or
/// deletes source state.
pub fn read_webview2_local_storage_source_internal(
    profile_path: &Path,
) -> CoreResult<Vec<RoleSessionTransferLocalStorageOriginRecord>> {
    if !profile_path.is_absolute() {
        return Err(webview2_source_layout_error());
    }
    validate_real_source_directory(profile_path)?;
    let local_storage_root = profile_path.join(WEBVIEW2_LOCAL_STORAGE_DIRECTORY);
    let root_metadata = match fs::symlink_metadata(&local_storage_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(webview2_source_read_error()),
    };
    validate_real_source_directory_metadata(&root_metadata)?;
    validate_source_containment(profile_path, &local_storage_root)?;

    let mut root_entries = sorted_source_entries(&local_storage_root)?;
    if root_entries.is_empty() {
        return Ok(Vec::new());
    }
    if root_entries.len() != 1
        || root_entries[0].file_name() != WEBVIEW2_LOCAL_STORAGE_LEVELDB_DIRECTORY
    {
        return Err(webview2_source_layout_error());
    }
    let leveldb_path = root_entries.remove(0).path();
    validate_real_source_directory(&leveldb_path)?;
    validate_source_containment(profile_path, &leveldb_path)?;
    let environment = snapshot_webview2_leveldb(&leveldb_path)?;
    parse_webview2_local_storage(environment)
}

fn snapshot_webview2_leveldb(path: &Path) -> CoreResult<MemEnv> {
    let entries = sorted_source_entries(path)?;
    if entries.len() > WEBVIEW2_LOCAL_STORAGE_MAX_SNAPSHOT_FILES {
        return Err(webview2_source_limit_error());
    }
    let names = entries
        .iter()
        .map(fs::DirEntry::file_name)
        .collect::<Vec<_>>();
    let environment = MemEnv::new();
    let mut total_bytes = 0_u64;
    let mut opened_files = Vec::with_capacity(entries.len());
    for entry in entries {
        let source = entry.path();
        let path_metadata =
            fs::symlink_metadata(&source).map_err(|_| webview2_source_read_error())?;
        validate_real_source_file_metadata(&path_metadata)?;
        total_bytes = total_bytes
            .checked_add(path_metadata.len())
            .ok_or_else(webview2_source_limit_error)?;
        if total_bytes > WEBVIEW2_LOCAL_STORAGE_MAX_SNAPSHOT_BYTES {
            return Err(webview2_source_limit_error());
        }
        let mut file = open_source_file(&source)?;
        validate_source_file_identity(&source, &file)?;
        let opened_metadata = file.metadata().map_err(|_| webview2_source_read_error())?;
        validate_real_source_file_metadata(&opened_metadata)?;
        if opened_metadata.len() != path_metadata.len() {
            return Err(webview2_source_identity_error());
        }
        let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
        Read::by_ref(&mut file)
            .take(WEBVIEW2_LOCAL_STORAGE_MAX_SNAPSHOT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| webview2_source_read_error())?;
        if bytes.len() as u64 != opened_metadata.len() {
            return Err(webview2_source_identity_error());
        }
        validate_source_file_identity(&source, &file)?;
        let final_metadata = file.metadata().map_err(|_| webview2_source_read_error())?;
        if final_metadata.len() != opened_metadata.len()
            || final_metadata.modified().ok() != opened_metadata.modified().ok()
        {
            return Err(webview2_source_identity_error());
        }

        let destination =
            Path::new(WEBVIEW2_LOCAL_STORAGE_SNAPSHOT_DIRECTORY).join(entry.file_name());
        let mut destination_file = environment
            .open_writable_file(&destination)
            .map_err(|_| webview2_source_read_error())?;
        destination_file
            .write_all(&bytes)
            .map_err(|_| webview2_source_read_error())?;
        destination_file
            .flush()
            .map_err(|_| webview2_source_read_error())?;
        opened_files.push((
            source,
            file,
            opened_metadata.len(),
            opened_metadata.modified().ok(),
        ));
    }
    let final_names = sorted_source_entries(path)?
        .iter()
        .map(fs::DirEntry::file_name)
        .collect::<Vec<_>>();
    if final_names != names {
        return Err(webview2_source_identity_error());
    }
    for (source, file, expected_len, expected_modified) in opened_files {
        validate_source_file_identity(&source, &file)?;
        let metadata = file.metadata().map_err(|_| webview2_source_read_error())?;
        validate_real_source_file_metadata(&metadata)?;
        if metadata.len() != expected_len || metadata.modified().ok() != expected_modified {
            return Err(webview2_source_identity_error());
        }
    }
    Ok(environment)
}

fn parse_webview2_local_storage(
    environment: MemEnv,
) -> CoreResult<Vec<RoleSessionTransferLocalStorageOriginRecord>> {
    let options = Options {
        env: Rc::new(Box::new(environment)),
        create_if_missing: false,
        paranoid_checks: true,
        ..Options::default()
    };
    let mut database = DB::open(
        Path::new(WEBVIEW2_LOCAL_STORAGE_SNAPSHOT_DIRECTORY),
        options,
    )
    .map_err(|_| webview2_source_read_error())?;
    let mut iterator = database
        .new_iter()
        .map_err(|_| webview2_source_read_error())?;
    iterator.seek_to_first();

    let mut saw_version = false;
    let mut metadata_origins = BTreeSet::new();
    let mut access_origins = BTreeSet::new();
    let mut inventory = BTreeMap::<String, BTreeMap<Vec<u16>, Vec<u16>>>::new();
    let mut entry_count = 0_usize;
    let mut decoded_bytes = 0_usize;
    while iterator.valid() {
        let Some((key, value)) = iterator.current() else {
            return Err(webview2_source_read_error());
        };
        if key.as_ref() == b"VERSION" {
            if saw_version || value.as_ref() != b"1" {
                return Err(webview2_source_layout_error());
            }
            saw_version = true;
        } else if let Some(origin) = key.as_ref().strip_prefix(b"META:") {
            let origin = parse_exact_web_origin(origin)?;
            if !metadata_origins.insert(origin) {
                return Err(webview2_source_incomplete_error());
            }
        } else if let Some(origin) = key.as_ref().strip_prefix(b"METAACCESS:") {
            let origin = parse_exact_web_origin(origin)?;
            if !access_origins.insert(origin) {
                return Err(webview2_source_incomplete_error());
            }
        } else if let Some(storage_key) = key.as_ref().strip_prefix(b"_") {
            let Some(separator) = storage_key.iter().position(|byte| *byte == 0) else {
                return Err(webview2_source_layout_error());
            };
            let origin = parse_exact_web_origin(&storage_key[..separator])?;
            let script_key = decode_chromium_code_units(&storage_key[separator + 1..])?;
            let script_value = decode_chromium_code_units(value.as_ref())?;
            entry_count = entry_count
                .checked_add(1)
                .ok_or_else(webview2_source_limit_error)?;
            decoded_bytes = decoded_bytes
                .checked_add(script_key.len().saturating_mul(2))
                .and_then(|total| total.checked_add(script_value.len().saturating_mul(2)))
                .ok_or_else(webview2_source_limit_error)?;
            if entry_count > ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ENTRIES
                || decoded_bytes > ROLE_SESSION_TRANSFER_MAX_TOTAL_BYTES
            {
                return Err(webview2_source_limit_error());
            }
            if inventory
                .entry(origin)
                .or_default()
                .insert(script_key, script_value)
                .is_some()
            {
                return Err(webview2_source_incomplete_error());
            }
        } else {
            return Err(webview2_source_layout_error());
        }
        iterator.advance();
    }
    if !saw_version
        || access_origins
            .iter()
            .any(|origin| !metadata_origins.contains(origin))
        || inventory
            .keys()
            .any(|origin| !metadata_origins.contains(origin))
        || metadata_origins.len() > ROLE_SESSION_TRANSFER_MAX_LOCAL_STORAGE_ORIGINS
    {
        return Err(webview2_source_incomplete_error());
    }

    Ok(inventory
        .into_iter()
        .map(
            |(origin, entries)| RoleSessionTransferLocalStorageOriginRecord {
                origin,
                entries: entries
                    .into_iter()
                    .map(|(key, value)| RoleSessionTransferLocalStorageEntryRecord {
                        key: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&key),
                        value: RoleSessionTransferBytesRecord::from_utf16_le_code_units(&value),
                    })
                    .collect(),
            },
        )
        .collect())
}

fn decode_chromium_code_units(value: &[u8]) -> CoreResult<Vec<u16>> {
    let Some((encoding, bytes)) = value.split_first() else {
        return Err(webview2_source_layout_error());
    };
    match encoding {
        1 => Ok(bytes.iter().map(|byte| u16::from(*byte)).collect()),
        0 if bytes.len() % 2 == 0 => Ok(bytes
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect()),
        _ => Err(webview2_source_layout_error()),
    }
}

fn parse_exact_web_origin(value: &[u8]) -> CoreResult<String> {
    let value = std::str::from_utf8(value).map_err(|_| webview2_source_origin_error())?;
    let url = url::Url::parse(value).map_err(|_| webview2_source_origin_error())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.origin().ascii_serialization() != value
    {
        return Err(webview2_source_origin_error());
    }
    Ok(value.to_owned())
}

fn sorted_source_entries(path: &Path) -> CoreResult<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)
        .map_err(|_| webview2_source_read_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| webview2_source_read_error())?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn validate_source_containment(profile_path: &Path, descendant: &Path) -> CoreResult<()> {
    let profile = fs::canonicalize(profile_path).map_err(|_| webview2_source_layout_error())?;
    let descendant = fs::canonicalize(descendant).map_err(|_| webview2_source_layout_error())?;
    if !descendant.starts_with(profile) {
        return Err(webview2_source_layout_error());
    }
    Ok(())
}

fn validate_real_source_directory(path: &Path) -> CoreResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| webview2_source_layout_error())?;
    validate_real_source_directory_metadata(&metadata)
}

fn validate_real_source_directory_metadata(metadata: &fs::Metadata) -> CoreResult<()> {
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || source_metadata_is_reparse_point(metadata)
    {
        return Err(webview2_source_layout_error());
    }
    Ok(())
}

fn validate_real_source_file_metadata(metadata: &fs::Metadata) -> CoreResult<()> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || source_metadata_is_reparse_point(metadata)
    {
        return Err(webview2_source_layout_error());
    }
    Ok(())
}

fn open_source_file(path: &Path) -> CoreResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    options.open(path).map_err(|_| webview2_source_read_error())
}

fn validate_source_file_identity(path: &Path, file: &File) -> CoreResult<()> {
    rion_platform::verify_open_file_identity(path, file)
        .map_err(|_| webview2_source_identity_error())
}

#[cfg(windows)]
fn source_metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn source_metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn webview2_source_read_error() -> CoreError {
    webview2_source_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_READ_FAILED",
        "WebView2 session-transfer source could not be read completely.",
    )
}

fn webview2_source_layout_error() -> CoreError {
    webview2_source_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_LAYOUT_UNSUPPORTED",
        "WebView2 session-transfer source layout is unsupported.",
    )
}

fn webview2_source_identity_error() -> CoreError {
    webview2_source_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_IDENTITY_CHANGED",
        "WebView2 session-transfer source identity changed during observation.",
    )
}

fn webview2_source_incomplete_error() -> CoreError {
    webview2_source_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_LOCAL_STORAGE_INCOMPLETE",
        "WebView2 LocalStorage observation is incomplete.",
    )
}

fn webview2_source_origin_error() -> CoreError {
    webview2_source_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_LOCAL_STORAGE_ORIGIN_UNSUPPORTED",
        "WebView2 LocalStorage contains an unsupported storage origin.",
    )
}

fn webview2_source_limit_error() -> CoreError {
    webview2_source_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_SOURCE_LIMIT_EXCEEDED",
        "WebView2 session-transfer source exceeds a bounded transfer limit.",
    )
}

fn webview2_source_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}
