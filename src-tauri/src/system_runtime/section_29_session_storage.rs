fn role_session_paths(user_data_dir: &Path, role_id: &str) -> RuntimeResult<SessionPaths> {
    if role_id.is_empty()
        || role_id.len() > 128
        || !role_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(RuntimeError::new(
            "TAURI_RUNTIME_ROLE_INVALID",
            "Runtime role ID is invalid.",
        ));
    }
    let digest = Sha256::digest(format!("rion-studio:wkwebsite-data-store:{role_id}"));
    let mut identifier = [0_u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier[6] = (identifier[6] & 0x0f) | 0x80;
    identifier[8] = (identifier[8] & 0x3f) | 0x80;
    Ok(SessionPaths {
        webkit_identifier: identifier,
        webview2: user_data_dir
            .join("roles")
            .join(role_id)
            .join("browser")
            .join("webview2"),
    })
}

#[cfg(any(windows, test))]
const ROLE_COOKIE_CHECKPOINT_VERSION: u32 = 1;
#[cfg(any(windows, test))]
const ROLE_COOKIE_CHECKPOINT_FILE: &str = "cookie-checkpoint.enc";
const ROLE_LOCAL_STORAGE_CHECKPOINT_VERSION: u32 = 1;
const ROLE_LOCAL_STORAGE_CHECKPOINT_FILE: &str = "local-storage-checkpoint.enc";

#[cfg(any(windows, test))]
#[derive(Debug, Deserialize, Serialize)]
struct PersistedRoleCookieCheckpoint {
    version: u32,
    cookies: Vec<SessionCookieRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRoleLocalStorageCheckpoint {
    checkpoint_id: String,
    entries: Vec<rion_core::LocalStorageEntryRecord>,
    origin: String,
    version: u32,
}

fn role_browser_directory(user_data_dir: &Path, role_id: &str) -> RuntimeResult<PathBuf> {
    role_session_paths(user_data_dir, role_id)?
        .webview2
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            RuntimeError::new(
                "ROLE_COOKIE_CHECKPOINT_PATH_INVALID",
                "The role browser directory is unavailable.",
            )
        })
}

fn role_local_storage_checkpoint_path(
    user_data_dir: &Path,
    role_id: &str,
) -> RuntimeResult<PathBuf> {
    Ok(role_browser_directory(user_data_dir, role_id)?
        .join("system")
        .join(ROLE_LOCAL_STORAGE_CHECKPOINT_FILE))
}

fn read_role_local_storage_checkpoint_blob(
    user_data_dir: &Path,
    role_id: &str,
) -> RuntimeResult<Option<Vec<u8>>> {
    let path = role_local_storage_checkpoint_path(user_data_dir, role_id)?;
    match fs::read(path) {
        Ok(protected) => Ok(Some(protected)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(RuntimeError::new(
            "ROLE_LOCAL_STORAGE_CHECKPOINT_READ_FAILED",
            format!("The encrypted role LocalStorage checkpoint is unavailable: {error}"),
        )),
    }
}

#[cfg(any(windows, test))]
fn role_cookie_checkpoint_directory(user_data_dir: &Path, role_id: &str) -> RuntimeResult<PathBuf> {
    Ok(role_browser_directory(user_data_dir, role_id)?.join("system"))
}

#[cfg(any(windows, test))]
fn read_role_cookie_checkpoint_blob(
    user_data_dir: &Path,
    role_id: &str,
) -> RuntimeResult<Option<Vec<u8>>> {
    let browser_directory = role_browser_directory(user_data_dir, role_id)?;
    for path in [
        browser_directory
            .join("system")
            .join(ROLE_COOKIE_CHECKPOINT_FILE),
        browser_directory.join(ROLE_COOKIE_CHECKPOINT_FILE),
    ] {
        match fs::read(&path) {
            Ok(protected) => return Ok(Some(protected)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(RuntimeError::new(
                    "ROLE_COOKIE_CHECKPOINT_READ_FAILED",
                    format!("The encrypted role cookie checkpoint is unavailable: {error}"),
                ));
            }
        }
    }
    Ok(None)
}

fn checked_web_url(value: &str) -> RuntimeResult<Url> {
    let url = Url::parse(value)
        .map_err(|_| RuntimeError::new("TAURI_URL_INVALID", "Role URL is invalid."))?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(url)
    } else {
        Err(RuntimeError::new(
            "TAURI_URL_INVALID",
            "Role URL must use HTTP or HTTPS.",
        ))
    }
}

fn effect_session_paths(
    webview2_user_data_dir: &str,
    webkit_data_store_identifier: &str,
) -> RuntimeResult<SessionPaths> {
    let webview2 = PathBuf::from(webview2_user_data_dir);
    if !webview2.is_absolute()
        || webview2
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(RuntimeError::new(
            "SESSION_IMPORT_STORE_INVALID",
            "The role WebView2 data directory is invalid.",
        ));
    }
    let webkit_identifier = uuid::Uuid::parse_str(webkit_data_store_identifier)
        .map_err(|_| {
            RuntimeError::new(
                "SESSION_IMPORT_STORE_INVALID",
                "The role WKWebsiteDataStore identifier is invalid.",
            )
        })?
        .into_bytes();
    Ok(SessionPaths {
        webkit_identifier,
        webview2,
    })
}

fn current_platform() -> rion_platform::Platform {
    if cfg!(target_os = "macos") {
        rion_platform::Platform::Macos
    } else {
        rion_platform::Platform::Windows
    }
}

fn write_private_file(directory: &Path, name: &str, value: &[u8]) -> RuntimeResult<()> {
    fs::create_dir_all(directory).map_err(RuntimeError::io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(RuntimeError::io)?;
    }
    rion_platform::restrict_directory_to_current_user(directory)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))?;

    let destination = directory.join(name);
    let temporary = directory.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(RuntimeError::io)?;
        file.write_all(value).map_err(RuntimeError::io)?;
        file.sync_all().map_err(RuntimeError::io)?;
        rion_platform::atomic_replace_file(&temporary, &destination)
            .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_transaction_id(value: &str) -> RuntimeResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(RuntimeError::new(
            "SESSION_IMPORT_TRANSACTION_INVALID",
            "Session-transfer transaction ID is invalid.",
        ))
    } else {
        Ok(())
    }
}

fn normalized_cookie_domain(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn cookies_for_launch(webview: &Webview, launch: &Url) -> RuntimeResult<Vec<Cookie<'static>>> {
    Ok(webview
        .cookies()
        .map_err(RuntimeError::tauri)?
        .into_iter()
        .filter(|cookie| native_cookie_matches_launch(cookie, launch))
        .collect())
}

fn native_cookie_matches_launch(cookie: &Cookie<'_>, launch: &Url) -> bool {
    let Some(host) = launch.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let domain = normalized_cookie_domain(cookie.domain());
    let domain_matches =
        host == domain || (!domain.is_empty() && host.ends_with(&format!(".{domain}")));
    let cookie_path = cookie.path().unwrap_or("/");
    domain_matches
        && native_cookie_path_matches(launch.path(), cookie_path)
        && (!cookie.secure().unwrap_or(false) || launch.scheme() == "https")
}

fn native_cookie_path_matches(request_path: &str, cookie_path: &str) -> bool {
    request_path == cookie_path
        || (request_path.starts_with(cookie_path)
            && (cookie_path.ends_with('/')
                || request_path.as_bytes().get(cookie_path.len()) == Some(&b'/')))
}

fn native_cookie_key(cookie: &Cookie<'_>) -> (String, String, String) {
    (
        normalized_cookie_domain(cookie.domain()),
        cookie.path().unwrap_or("/").to_owned(),
        cookie.name().to_owned(),
    )
}

fn native_cookie_record(cookie: &Cookie<'_>) -> SessionCookieRecord {
    SessionCookieRecord {
        name: cookie.name().to_owned(),
        value: cookie.value().to_owned(),
        domain: cookie.domain().map(str::to_owned),
        path: cookie.path().unwrap_or("/").to_owned(),
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
        same_site: match cookie.same_site() {
            Some(SameSite::Strict) => "strict",
            Some(SameSite::Lax) => "lax",
            Some(SameSite::None) => "none",
            None => "unspecified",
        }
        .to_owned(),
        expires_unix_ms: cookie
            .expires_datetime()
            .map(|expires| expires.unix_timestamp() * 1_000),
    }
}

fn transfer_cookie_key(cookie: &SessionCookieRecord, launch: &Url) -> (String, String, String) {
    (
        normalized_cookie_domain(cookie.domain.as_deref().or_else(|| launch.host_str())),
        cookie.path.clone(),
        cookie.name.clone(),
    )
}

fn transfer_cookie(record: &SessionCookieRecord, launch: &Url) -> RuntimeResult<Cookie<'static>> {
    let domain = record
        .domain
        .as_deref()
        .or_else(|| launch.host_str())
        .ok_or_else(|| {
            RuntimeError::new(
                "SESSION_IMPORT_COOKIE_INVALID",
                "Imported cookie has no valid domain.",
            )
        })?;
    Ok(session_cookie_from_record(record, domain))
}

fn session_cookie_from_record(
    record: &SessionCookieRecord,
    domain: &str,
) -> Cookie<'static> {
    let mut builder = Cookie::build((record.name.clone(), record.value.clone()))
        .domain(domain.to_owned())
        .path(record.path.clone());
    // Wry's WKWebView adapter serializes `Some(false)` as the string `FALSE`.
    // NSHTTPCookie treats presence of Secure/HttpOnly as enabled, so false flags
    // must remain absent while true flags are explicit.
    if record.secure {
        builder = builder.secure(true);
    }
    if record.http_only {
        builder = builder.http_only(true);
    }
    builder = match record.same_site.as_str() {
        "strict" => builder.same_site(SameSite::Strict),
        "lax" => builder.same_site(SameSite::Lax),
        "none" if record.secure => builder.same_site(SameSite::None),
        _ => builder,
    };
    if let Some(timestamp) = record.expires_unix_ms
        && let Ok(expires) = OffsetDateTime::from_unix_timestamp(timestamp / 1_000)
    {
        builder = builder.expires(expires);
    }
    builder.build()
}

#[cfg(any(windows, test))]
fn role_cookie_from_checkpoint(
    record: &SessionCookieRecord,
) -> RuntimeResult<Cookie<'static>> {
    let domain = record
        .domain
        .as_deref()
        .filter(|domain| !domain.trim().is_empty())
        .ok_or_else(|| {
            RuntimeError::new(
                "ROLE_COOKIE_CHECKPOINT_INVALID",
                "A role cookie checkpoint entry has no valid domain.",
            )
        })?;
    Ok(session_cookie_from_record(record, domain))
}

#[cfg(any(windows, test))]
fn role_cookie_checkpoint_entry_is_live(
    record: &SessionCookieRecord,
    now_unix_ms: i64,
) -> bool {
    record
        .expires_unix_ms
        .is_none_or(|expires_unix_ms| expires_unix_ms > now_unix_ms)
}

#[cfg(any(windows, test))]
fn role_cookie_checkpoint_record_key(
    record: &SessionCookieRecord,
) -> (String, String, String) {
    (
        normalized_cookie_domain(record.domain.as_deref()),
        record.path.clone(),
        record.name.clone(),
    )
}

#[cfg(any(windows, test))]
fn deduplicate_role_cookie_checkpoint_records(
    records: Vec<SessionCookieRecord>,
) -> Vec<SessionCookieRecord> {
    let mut seen = HashSet::new();
    let mut unique = Vec::with_capacity(records.len());
    for record in records.into_iter().rev() {
        if seen.insert(role_cookie_checkpoint_record_key(&record)) {
            unique.push(record);
        }
    }
    unique.reverse();
    unique
}

impl SystemRuntimeExecutor {
    pub(crate) fn checkpoint_window_close_role_sessions(
        &self,
        tab_ids: &[String],
    ) -> RuntimeResult<()> {
        self.checkpoint_close_role_sessions(
            tab_ids,
            "SYSTEM_WINDOW_CLOSE_SESSION_CHECKPOINT_STALE",
            "window close admission",
            "The live role Cookie and LocalStorage state was durably checkpointed before window close admission.",
        )
    }

    pub(crate) fn checkpoint_tab_close_role_sessions(&self, tab_id: &str) -> RuntimeResult<()> {
        self.checkpoint_close_role_sessions(
            &[tab_id.to_owned()],
            "SYSTEM_TAB_CLOSE_SESSION_CHECKPOINT_STALE",
            "tab close admission",
            "The live role Cookie and LocalStorage state was durably checkpointed before tab close admission.",
        )
    }

    fn checkpoint_close_role_sessions(
        &self,
        tab_ids: &[String],
        stale_code: &'static str,
        admission: &'static str,
        checkpoint_message: &'static str,
    ) -> RuntimeResult<()> {
        let surfaces = {
            let state = self.state()?;
            let mut surfaces = Vec::new();
            for tab_id in tab_ids {
                let Some(tab) = state.native_resources.tabs.get(tab_id) else {
                    let has_registered_surface = state
                        .native_resources
                        .surface_registry
                        .values()
                        .chain(state.native_resources.retired_surface_registry.values())
                        .any(|surface| surface.tab_id.as_deref() == Some(tab_id));
                    let has_close_fence = state.close_previews.contains_key(tab_id)
                        || state.close_coordinator.closing_tabs.contains(tab_id);
                    if native_absent_tab_can_skip_window_session_checkpoint(
                        has_registered_surface,
                        has_close_fence,
                    ) {
                        // Saved windows retain dormant logical tabs that have no native tab or
                        // page-bearing surface. There is no live session to checkpoint for that
                        // occurrence; the exact persisted tab still participates in Core close
                        // admission and retirement below.
                        continue;
                    }
                    return Err(RuntimeError::new(
                        stale_code,
                        format!(
                            "A native-absent runtime tab retained a live surface or close fence before {admission}."
                        ),
                    ));
                };
                for (role_id, role_surface) in &tab.roles {
                    let managed = state
                        .native_resources
                        .surface_registry
                        .values()
                        .find(|surface| {
                            surface.kind == ManagedSurfaceKind::Role
                                && surface.phase == ManagedSurfacePhase::Live
                                && surface.role_id.as_deref() == Some(role_id)
                                && surface.tab_id.as_deref() == Some(tab_id)
                                && surface.webview.label() == role_surface.webview.label()
                        })
                        .cloned()
                        .ok_or_else(|| {
                            RuntimeError::new(
                                stale_code,
                                format!(
                                    "The exact live role surface was unavailable before {admission}."
                                ),
                            )
                        })?;
                    surfaces.push(managed);
                }
            }
            surfaces
        };

        for surface in &surfaces {
            let role_id = surface.role_id.as_deref().ok_or_else(|| {
                RuntimeError::new(
                    stale_code,
                    "A role session checkpoint surface did not retain its role identity.",
                )
            })?;
            self.persist_role_cookie_checkpoint(&surface.webview, role_id)?;
            self.persist_role_local_storage_checkpoint(&surface.webview, role_id)?;
        }

        let mut state = self.state()?;
        let all_current = surfaces.iter().all(|expected| {
            state
                .native_resources
                .surface_registry
                .get(&expected.instance_id)
                .is_some_and(|current| {
                    current.generation == expected.generation
                        && current.kind == ManagedSurfaceKind::Role
                        && current.phase == ManagedSurfacePhase::Live
                        && current.role_id == expected.role_id
                        && current.tab_id == expected.tab_id
                        && current.webview.label() == expected.webview.label()
                })
        });
        if !all_current {
            return Err(RuntimeError::new(
                stale_code,
                "A role surface changed while its close session checkpoint was being persisted.",
            ));
        }
        for expected in &surfaces {
            if let Some(current) = state
                .native_resources
                .surface_registry
                .get_mut(&expected.instance_id)
            {
                current.session_checkpointed_for_close = true;
            }
        }
        drop(state);
        for expected in &surfaces {
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.session-checkpointed",
                checkpoint_message,
                expected.webview.label(),
            );
        }
        Ok(())
    }

    fn persist_runtime_tab_role_session_checkpoints(&self, tab_id: &str) -> RuntimeResult<()> {
        let role_surfaces = {
            let state = self.state()?;
            state
                .native_resources
                .tabs
                .get(tab_id)
                .map(|tab| {
                    tab.roles
                        .iter()
                        .map(|(role_id, surface)| (role_id.clone(), surface.webview.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        for (role_id, webview) in role_surfaces {
            self.persist_role_cookie_checkpoint(&webview, &role_id)?;
            self.persist_role_local_storage_checkpoint(&webview, &role_id)?;
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.session-checkpointed",
                "The live role Cookie and LocalStorage state was durably checkpointed before the tab became hidden.",
                webview.label(),
            );
        }
        Ok(())
    }

    fn persist_role_local_storage_checkpoint(
        &self,
        webview: &Webview,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let current_url = webview.url().map_err(RuntimeError::tauri)?;
        if !matches!(current_url.scheme(), "http" | "https") {
            return Ok(());
        }
        let origin = current_url.origin().ascii_serialization();
        let entries = read_local_storage_entries(webview)?
            .into_iter()
            .map(|(key, value)| rion_core::LocalStorageEntryRecord { key, value })
            .collect::<Vec<_>>();
        let serialized = serde_json::to_vec(&PersistedRoleLocalStorageCheckpoint {
            checkpoint_id: uuid::Uuid::new_v4().to_string(),
            entries,
            origin,
            version: ROLE_LOCAL_STORAGE_CHECKPOINT_VERSION,
        })
        .map_err(|error| {
            RuntimeError::new(
                "ROLE_LOCAL_STORAGE_CHECKPOINT_WRITE_FAILED",
                error.to_string(),
            )
        })?;
        let protected = rion_platform::protect_session_transfer(current_platform(), &serialized)
            .map_err(|error| {
                RuntimeError::new(
                    "ROLE_LOCAL_STORAGE_CHECKPOINT_WRITE_FAILED",
                    error.to_string(),
                )
            })?;
        let path = role_local_storage_checkpoint_path(&self.user_data_dir, role_id)?;
        let directory = path.parent().ok_or_else(|| {
            RuntimeError::new(
                "ROLE_LOCAL_STORAGE_CHECKPOINT_PATH_INVALID",
                "The role LocalStorage checkpoint directory is unavailable.",
            )
        })?;
        write_private_file(directory, ROLE_LOCAL_STORAGE_CHECKPOINT_FILE, &protected).map_err(
            |error| {
                RuntimeError::new(
                    "ROLE_LOCAL_STORAGE_CHECKPOINT_WRITE_FAILED",
                    error.message,
                )
            },
        )
    }

    fn role_local_storage_checkpoint_document_start_script(
        &self,
        role_id: &str,
    ) -> RuntimeResult<Option<String>> {
        let Some(protected) =
            read_role_local_storage_checkpoint_blob(&self.user_data_dir, role_id)?
        else {
            return Ok(None);
        };
        let plaintext = rion_platform::unprotect_session_transfer(
            current_platform(),
            &protected,
        )
        .map_err(|error| {
            RuntimeError::new(
                "ROLE_LOCAL_STORAGE_CHECKPOINT_INVALID",
                error.to_string(),
            )
        })?;
        let checkpoint: PersistedRoleLocalStorageCheckpoint =
            serde_json::from_slice(&plaintext).map_err(|error| {
                RuntimeError::new(
                    "ROLE_LOCAL_STORAGE_CHECKPOINT_INVALID",
                    error.to_string(),
                )
            })?;
        if checkpoint.version != ROLE_LOCAL_STORAGE_CHECKPOINT_VERSION
            || checked_web_url(&checkpoint.origin).is_err()
        {
            return Err(RuntimeError::new(
                "ROLE_LOCAL_STORAGE_CHECKPOINT_INVALID",
                "The role LocalStorage checkpoint version or origin is unsupported.",
            ));
        }
        role_local_storage_checkpoint_document_start_script(&checkpoint).map(Some)
    }

    fn remove_role_local_storage_checkpoint(&self, role_id: &str) -> RuntimeResult<()> {
        let path = role_local_storage_checkpoint_path(&self.user_data_dir, role_id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(RuntimeError::new(
                "ROLE_LOCAL_STORAGE_CHECKPOINT_CLEAR_FAILED",
                format!(
                    "The encrypted role LocalStorage checkpoint could not be removed: {error}"
                ),
            )),
        }
    }

    #[cfg(windows)]
    fn persist_role_cookie_checkpoint(
        &self,
        webview: &Webview,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let now_unix_ms = OffsetDateTime::now_utc().unix_timestamp() * 1_000;
        let cookies = webview.cookies().map_err(|error| {
            RuntimeError::new(
                "ROLE_COOKIE_CHECKPOINT_READ_FAILED",
                format!("System WebView could not read the live role cookies: {error}"),
            )
        })?;
        let records = deduplicate_role_cookie_checkpoint_records(
            cookies
                .iter()
                .map(native_cookie_record)
                .filter(|record| role_cookie_checkpoint_entry_is_live(record, now_unix_ms))
                .collect(),
        );
        for record in &records {
            role_cookie_from_checkpoint(record)?;
        }
        let serialized = serde_json::to_vec(&PersistedRoleCookieCheckpoint {
            version: ROLE_COOKIE_CHECKPOINT_VERSION,
            cookies: records,
        })
        .map_err(|error| {
            RuntimeError::new("ROLE_COOKIE_CHECKPOINT_WRITE_FAILED", error.to_string())
        })?;
        let protected = rion_platform::protect_session_transfer(
            rion_platform::Platform::Windows,
            &serialized,
        )
        .map_err(|error| {
            RuntimeError::new("ROLE_COOKIE_CHECKPOINT_WRITE_FAILED", error.to_string())
        })?;
        let directory = role_cookie_checkpoint_directory(&self.user_data_dir, role_id)?;
        write_private_file(&directory, ROLE_COOKIE_CHECKPOINT_FILE, &protected).map_err(|error| {
            RuntimeError::new("ROLE_COOKIE_CHECKPOINT_WRITE_FAILED", error.message)
        })
    }

    #[cfg(not(windows))]
    fn persist_role_cookie_checkpoint(
        &self,
        _webview: &Webview,
        _role_id: &str,
    ) -> RuntimeResult<()> {
        Ok(())
    }

    #[cfg(windows)]
    fn restore_role_cookie_checkpoint(
        &self,
        webview: &Webview,
        role_id: &str,
    ) -> RuntimeResult<()> {
        let Some(protected) = read_role_cookie_checkpoint_blob(&self.user_data_dir, role_id)? else {
            return Ok(());
        };
        let plaintext = rion_platform::unprotect_session_transfer(
            rion_platform::Platform::Windows,
            &protected,
        )
        .map_err(|error| {
            RuntimeError::new("ROLE_COOKIE_CHECKPOINT_INVALID", error.to_string())
        })?;
        let checkpoint: PersistedRoleCookieCheckpoint = serde_json::from_slice(&plaintext)
            .map_err(|error| {
                RuntimeError::new("ROLE_COOKIE_CHECKPOINT_INVALID", error.to_string())
            })?;
        if checkpoint.version != ROLE_COOKIE_CHECKPOINT_VERSION {
            return Err(RuntimeError::new(
                "ROLE_COOKIE_CHECKPOINT_INVALID",
                "The role cookie checkpoint version is unsupported.",
            ));
        }
        let now_unix_ms = OffsetDateTime::now_utc().unix_timestamp() * 1_000;
        let records = deduplicate_role_cookie_checkpoint_records(
            checkpoint
                .cookies
                .into_iter()
                .filter(|record| role_cookie_checkpoint_entry_is_live(record, now_unix_ms))
                .collect(),
        );
        let cookies = records
            .iter()
            .map(role_cookie_from_checkpoint)
            .collect::<RuntimeResult<Vec<_>>>()?;
        for cookie in &cookies {
            webview
                .set_cookie(cookie.clone())
                .map_err(|error| {
                    RuntimeError::new(
                        "ROLE_COOKIE_CHECKPOINT_RESTORE_FAILED",
                        format!("System WebView could not restore a role cookie: {error}"),
                    )
                })?;
        }
        let readback = webview.cookies().map_err(|error| {
            RuntimeError::new(
                "ROLE_COOKIE_CHECKPOINT_RESTORE_FAILED",
                format!("System WebView could not verify restored role cookies: {error}"),
            )
        })?;
        verify_cookie_readback(&cookies, &readback).map_err(|error| {
            RuntimeError::new("ROLE_COOKIE_CHECKPOINT_RESTORE_FAILED", error.message)
        })
    }

    #[cfg(not(windows))]
    fn restore_role_cookie_checkpoint(
        &self,
        _webview: &Webview,
        _role_id: &str,
    ) -> RuntimeResult<()> {
        Ok(())
    }

    #[cfg(windows)]
    fn remove_role_cookie_checkpoint(&self, role_id: &str) -> RuntimeResult<()> {
        let browser_directory = role_browser_directory(&self.user_data_dir, role_id)?;
        for path in [
            browser_directory
                .join("system")
                .join(ROLE_COOKIE_CHECKPOINT_FILE),
            browser_directory.join(ROLE_COOKIE_CHECKPOINT_FILE),
        ] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(RuntimeError::new(
                        "ROLE_COOKIE_CHECKPOINT_CLEAR_FAILED",
                        format!(
                            "The encrypted role cookie checkpoint could not be removed: {error}"
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn remove_role_cookie_checkpoint(&self, _role_id: &str) -> RuntimeResult<()> {
        Ok(())
    }
}

fn native_absent_tab_can_skip_window_session_checkpoint(
    has_registered_surface: bool,
    has_close_fence: bool,
) -> bool {
    !has_registered_surface && !has_close_fence
}

fn verify_cookie_readback(
    expected: &[Cookie<'static>],
    actual: &[Cookie<'static>],
) -> RuntimeResult<()> {
    for cookie in expected {
        let key = native_cookie_key(cookie);
        let matches = actual.iter().any(|candidate| {
            native_cookie_key(candidate) == key
                && candidate.value() == cookie.value()
                && candidate.secure().unwrap_or(false) == cookie.secure().unwrap_or(false)
                && candidate.http_only().unwrap_or(false) == cookie.http_only().unwrap_or(false)
                && native_cookie_same_site_matches(cookie.same_site(), candidate.same_site())
        });
        if !matches {
            return Err(RuntimeError::new(
                "SESSION_IMPORT_COOKIE_VERIFY_FAILED",
                format!(
                    "System WebView did not retain imported cookie {}.",
                    cookie.name()
                ),
            ));
        }
    }
    Ok(())
}

fn native_cookie_same_site_matches(expected: Option<SameSite>, actual: Option<SameSite>) -> bool {
    expected == actual
        || matches!(
            (expected, actual),
            (None, Some(SameSite::None)) | (Some(SameSite::None), None)
        )
}

fn restore_url_cookies(
    webview: &Webview,
    launch: &Url,
    backup: &[Cookie<'static>],
) -> RuntimeResult<()> {
    let current = cookies_for_launch(webview, launch)?;
    for cookie in current {
        webview.delete_cookie(cookie).map_err(RuntimeError::tauri)?;
    }
    for cookie in backup {
        webview
            .set_cookie(cookie.clone())
            .map_err(RuntimeError::tauri)?;
    }
    let readback = cookies_for_launch(webview, launch)?;
    verify_cookie_readback(backup, &readback)
}

fn local_storage_document_start_script(
    origin: &str,
    replace_existing: bool,
    entries: &[rion_core::LocalStorageEntryRecord],
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(origin)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    let entries = serde_json::to_string(entries)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  const entries = {entries};
  const backup = Object.entries(localStorage);
  if ({replace_existing}) localStorage.clear();
  for (const item of entries) localStorage.setItem(item.key, item.value);
  Object.defineProperty(globalThis, "__rionSessionImportState", {{
    configurable: false,
    value: {{
      applied: true,
      backup,
      origin: location.origin,
      size: localStorage.length,
      values: entries.map((item) => [item.key, localStorage.getItem(item.key)])
    }}
  }});
}})();"#,
    ))
}

fn role_local_storage_checkpoint_document_start_script(
    checkpoint: &PersistedRoleLocalStorageCheckpoint,
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(&checkpoint.origin).map_err(|error| {
        RuntimeError::new("ROLE_LOCAL_STORAGE_CHECKPOINT_INVALID", error.to_string())
    })?;
    let checkpoint_id = serde_json::to_string(&checkpoint.checkpoint_id).map_err(|error| {
        RuntimeError::new("ROLE_LOCAL_STORAGE_CHECKPOINT_INVALID", error.to_string())
    })?;
    let entries = serde_json::to_string(&checkpoint.entries).map_err(|error| {
        RuntimeError::new("ROLE_LOCAL_STORAGE_CHECKPOINT_INVALID", error.to_string())
    })?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  const checkpointId = {checkpoint_id};
  const markerKey = "__rionRoleLocalStorageCheckpointV1";
  if (sessionStorage.getItem(markerKey) === checkpointId) return;
  const entries = {entries};
  localStorage.clear();
  for (const item of entries) localStorage.setItem(item.key, item.value);
  sessionStorage.setItem(markerKey, checkpointId);
  Object.defineProperty(globalThis, "__rionRoleLocalStorageCheckpointState", {{
    configurable: false,
    value: {{
      applied: true,
      checkpointId,
      origin: location.origin,
      size: localStorage.length,
      values: entries.map((item) => [item.key, localStorage.getItem(item.key)])
    }}
  }});
}})();"#,
    ))
}


fn local_storage_restore_script(
    origin: &str,
    entries: &[(String, String)],
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(origin)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    let entries = serde_json::to_string(entries)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  const entries = {entries};
  localStorage.clear();
  for (const [key, value] of entries) localStorage.setItem(key, value);
  Object.defineProperty(globalThis, "__rionSessionRestoreState", {{
    configurable: false,
    value: {{
      applied: true,
      origin: location.origin,
      size: localStorage.length,
      values: Object.entries(localStorage)
    }}
  }});
}})();"#,
    ))
}

fn evaluate_json_value(webview: &Webview, source: &str) -> RuntimeResult<Value> {
    let raw = evaluate_system_webview(webview, source)?;
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| {
        RuntimeError::new(
            "SESSION_IMPORT_READBACK_INVALID",
            format!("System WebView returned invalid JSON: {error}"),
        )
    })?;
    if let Some(nested) = value.as_str() {
        serde_json::from_str(nested).map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_READBACK_INVALID",
                format!("System WebView returned invalid nested JSON: {error}"),
            )
        })
    } else {
        Ok(value)
    }
}

fn require_exact_webview_origin(webview: &Webview, expected: &str) -> RuntimeResult<()> {
    let actual = webview
        .url()
        .map_err(RuntimeError::tauri)?
        .origin()
        .ascii_serialization();
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "SESSION_IMPORT_ORIGIN_MISMATCH",
            format!("Launch page resolved to {actual}, expected {expected}."),
        ))
    }
}

fn valid_auth_probe_path(path: &str) -> bool {
    path.starts_with('/') && !path.contains(['?', '#'])
}

fn auth_probe_path_matches(actual: &str, expected: &str) -> bool {
    actual == expected
        || (actual.starts_with(expected)
            && expected != "/"
            && actual.as_bytes().get(expected.len()) == Some(&b'/'))
}

fn storage_entries_from_value(value: &Value, field: &str) -> RuntimeResult<Vec<(String, String)>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RuntimeError::new(
                "SESSION_IMPORT_READBACK_INVALID",
                format!("System WebView did not return LocalStorage {field}."),
            )
        })?
        .iter()
        .map(|entry| {
            let pair = entry
                .as_array()
                .filter(|pair| pair.len() == 2)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SESSION_IMPORT_READBACK_INVALID",
                        "System WebView returned a malformed LocalStorage entry.",
                    )
                })?;
            let key = pair[0].as_str().ok_or_else(|| {
                RuntimeError::new(
                    "SESSION_IMPORT_READBACK_INVALID",
                    "System WebView returned a non-string LocalStorage key.",
                )
            })?;
            let value = pair[1].as_str().ok_or_else(|| {
                RuntimeError::new(
                    "SESSION_IMPORT_READBACK_INVALID",
                    "System WebView returned a non-string LocalStorage value.",
                )
            })?;
            Ok((key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn read_local_storage_entries(webview: &Webview) -> RuntimeResult<Vec<(String, String)>> {
    let value = evaluate_json_value(webview, "({ values: Object.entries(localStorage) })")?;
    storage_entries_from_value(&value, "values")
}

fn verify_local_storage_import(
    webview: &Webview,
    expected: &[rion_core::LocalStorageEntryRecord],
    replace_existing: bool,
) -> RuntimeResult<()> {
    let state = evaluate_json_value(webview, "globalThis.__rionSessionImportState ?? null")?;
    if state.get("applied").and_then(Value::as_bool) != Some(true) {
        return Err(RuntimeError::new(
            "SESSION_IMPORT_STORAGE_VERIFY_FAILED",
            "System WebView did not run the document-start LocalStorage import.",
        ));
    }
    let values = storage_entries_from_value(&state, "values")?;
    let expected_values = expected
        .iter()
        .map(|entry| (entry.key.clone(), entry.value.clone()))
        .collect::<Vec<_>>();
    if values != expected_values
        || (replace_existing
            && state.get("size").and_then(Value::as_u64) != Some(expected.len() as u64))
    {
        return Err(RuntimeError::new(
            "SESSION_IMPORT_STORAGE_VERIFY_FAILED",
            "System WebView LocalStorage readback did not match the imported data.",
        ));
    }
    Ok(())
}
