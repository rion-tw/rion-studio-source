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
    Ok(builder.build())
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

fn local_storage_sync_configure_script(
    config: &LocalStorageRuntimeConfig,
) -> RuntimeResult<String> {
    let observer = local_storage_sync_observer_script(config)?;
    let configuration = serde_json::to_string(&json!({
        "token": config.token,
        "generation": config.generation,
        "origin": config.origin,
        "keys": config.keys,
        "selectors": config.selectors,
    }))
    .map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization configuration could not be encoded.",
        )
    })?;
    Ok(format!(
        "{observer}\nglobalThis.__rionLocalStorageSyncObserver?.configure?.({configuration});"
    ))
}

fn local_storage_sync_disable_script(token: &str) -> RuntimeResult<String> {
    let token = serde_json::to_string(token).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization capability could not be encoded.",
        )
    })?;
    Ok(format!(
        "globalThis.__rionLocalStorageSyncObserver?.disable?.({token});"
    ))
}

fn evaluate_local_storage_metadata_scripts(
    webview: &Webview,
    scripts: &[String],
) -> Result<(), String> {
    scripts
        .iter()
        .try_for_each(|script| webview.eval(script).map_err(|error| error.to_string()))
}

fn local_storage_sync_apply_script(
    snapshot: &PersistedLocalStorageSyncSnapshot,
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(&snapshot.origin).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization bootstrap could not be encoded.",
        )
    })?;
    let entries = serde_json::to_string(&snapshot.entries).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization bootstrap could not be encoded.",
        )
    })?;
    let selectors = snapshot
        .selector_entries
        .iter()
        .map(|(selector, _)| selector.clone())
        .collect::<Vec<_>>();
    let keys = snapshot
        .entries
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    validate_local_storage_sync_contract(
        &snapshot.origin,
        &keys,
        &selectors,
        snapshot.codec.as_deref(),
    )?;
    validate_local_storage_sync_selector_entries(
        snapshot.codec.as_deref(),
        &selectors,
        &snapshot.selector_entries,
    )?;
    let selector_entries = serde_json::to_string(&snapshot.selector_entries).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization fields could not be encoded.",
        )
    })?;
    let selectors_json = serde_json::to_string(&selectors).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization selectors could not be encoded.",
        )
    })?;
    let codec_script = local_storage_codec_script(&selectors, snapshot.codec.as_deref())?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  {codec_script}
  const selectors = {selectors_json};
  repairLocalStorageCodecIdentity(selectors);
  if (!applyLocalStorageCodecFields(selectors, {selector_entries})) return;
  for (const [key, value] of {entries}) {{
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }}
}})();"#,
    ))
}

fn read_scoped_local_storage_snapshot(
    webview: &Webview,
    keys: &[String],
    selectors: &[String],
    codec: Option<&str>,
) -> RuntimeResult<LocalStorageSyncSnapshotEntries> {
    let keys_json = serde_json::to_string(keys).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
            "The localStorage synchronization key set could not be encoded.",
        )
    })?;
    let selectors_json = serde_json::to_string(selectors).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
            "The localStorage synchronization selectors could not be encoded.",
        )
    })?;
    let codec_script = local_storage_codec_script(selectors, codec)?;
    let value = evaluate_json_value(
        webview,
        &format!(
            "(() => {{ {codec_script} const keys = {keys_json}; const selectors = {selectors_json}; repairLocalStorageCodecIdentity(selectors); const selectorValues = captureLocalStorageCodecFields(selectors); if (selectorValues === null) return {{ error: localStorageCodecSettingsInvalidCode }}; return {{ values: keys.map((key) => [key, localStorage.getItem(key)]), selectorValues }}; }})()"
        ),
    )?;
    reject_local_storage_sync_snapshot_codec_error(&value, codec)?;
    let values = value
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                "The System WebView returned an invalid localStorage synchronization snapshot.",
            )
        })?;
    if values.len() != keys.len() {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
            "The System WebView returned an incomplete localStorage synchronization snapshot.",
        ));
    }
    let entries = values
        .iter()
        .zip(keys)
        .map(|(entry, expected)| {
            let pair = entry.as_array().filter(|pair| pair.len() == 2).ok_or_else(|| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                    "The System WebView returned a malformed localStorage synchronization entry.",
                )
            })?;
            if pair[0].as_str() != Some(expected) {
                return Err(RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                    "The System WebView returned an unexpected localStorage synchronization key.",
                ));
            }
            let value = if pair[1].is_null() {
                None
            } else {
                Some(pair[1].as_str().ok_or_else(|| {
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                        "The System WebView returned a non-string localStorage synchronization value.",
                    )
                })?.to_owned())
            };
            Ok((expected.clone(), value))
        })
        .collect::<RuntimeResult<Vec<_>>>()?;
    let selector_values = value
        .get("selectorValues")
        .and_then(Value::as_array)
        .filter(|values| values.len() == selectors.len())
        .ok_or_else(|| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                "The System WebView returned invalid localStorage synchronization fields.",
            )
        })?;
    let selector_entries = selector_values
        .iter()
        .zip(selectors)
        .map(|(entry, selector)| {
            let pair = entry.as_array().filter(|pair| pair.len() == 2).ok_or_else(|| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                    "The System WebView returned a malformed localStorage synchronization field.",
                )
            })?;
            if pair[0].as_str() != Some(selector) {
                return Err(RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                    "The System WebView returned an unexpected localStorage synchronization field.",
                ));
            }
            let field = if pair[1].is_null() {
                None
            } else {
                Some(pair[1].as_str().ok_or_else(|| {
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                        "The System WebView returned a non-string localStorage synchronization field.",
                    )
                })?.to_owned())
            };
            Ok((selector.clone(), field))
        })
        .collect::<RuntimeResult<Vec<_>>>()?;
    validate_local_storage_sync_selector_entries(codec, selectors, &selector_entries)?;
    Ok((entries, selector_entries))
}

fn reject_local_storage_sync_snapshot_codec_error(
    value: &Value,
    codec: Option<&str>,
) -> RuntimeResult<()> {
    let Some(error) = value.get("error") else {
        return Ok(());
    };
    match (codec, error.as_str()) {
        (
            Some(rion_core::FLYFF_LOCAL_STORAGE_SYNC_CODEC),
            Some("FLYFF_SETTINGS_INVALID"),
        ) => Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_FLYFF_SETTINGS_INVALID",
            "The Flyff settings stored in this role are missing or use an unsupported format. Open the role and save its game settings, then try again.",
        )),
        (
            Some(rion_core::FLYFF_CHINA_LOCAL_STORAGE_SYNC_CODEC),
            Some("FLYFF_CHINA_SETTINGS_INVALID"),
        ) => Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SETTINGS_INVALID",
            "The Flyff China settings stored in this role are missing or use an unsupported format. Open the role and save its game settings, then try again.",
        )),
        _ => Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
            "The System WebView returned an invalid localStorage synchronization snapshot.",
        )),
    }
}

fn require_exact_local_storage_sync_origin(webview: &Webview, expected: &str) -> RuntimeResult<()> {
    // WKWebView can briefly expose a nil native URL while a page transition or
    // renderer teardown is in flight. Wry 0.55 unwraps that value internally,
    // so use the document's origin for this capability check instead of calling
    // WebView::url() across that native transition boundary.
    let document = evaluate_json_value(
        webview,
        "JSON.stringify({ origin: globalThis.location?.origin ?? null })",
    )?;
    let actual = document
        .get("origin")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_ORIGIN_MISMATCH",
                "The localStorage synchronization WebView has no document origin.",
            )
        })?;
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_ORIGIN_MISMATCH",
            "The localStorage synchronization WebView origin does not match its binding.",
        ))
    }
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
