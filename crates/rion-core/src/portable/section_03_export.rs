pub(crate) fn export(
    snapshot: CoreStateSnapshotRecord,
    preferences: Option<PortablePreferencesRecord>,
    selection: PortableDataSelectionRecord,
    app_version: &str,
) -> CoreResult<PortableDataRecord> {
    let selection = normalize_selection(selection);
    let preferences = selection.preferences.then_some(preferences).flatten();
    validate_preferences(preferences.as_ref())?;
    let data = PortableDataRecord {
        app: PORTABLE_APP.to_owned(),
        schema_version: PORTABLE_SCHEMA_VERSION as u32,
        exported_at: chrono::Utc::now().to_rfc3339(),
        app_version: app_version.to_owned(),
        games: if selection.games {
            snapshot.games.iter().map(portable_game).collect()
        } else {
            Vec::new()
        },
        roles: if selection.roles {
            snapshot.roles.iter().map(portable_role).collect()
        } else {
            Vec::new()
        },
        launch_workspaces: if selection.launch_workspaces {
            snapshot
                .launch_workspaces
                .iter()
                .map(portable_workspace)
                .collect()
        } else {
            Vec::new()
        },
        game_windows: if selection.game_windows {
            snapshot
                .game_windows
                .iter()
                .map(portable_game_window)
                .collect()
        } else {
            Vec::new()
        },
        macros: if selection.macros {
            snapshot.macros.iter().map(portable_macro).collect()
        } else {
            Vec::new()
        },
        preferences,
    };
    ensure_selected_content(&data, &selection)?;
    Ok(data)
}

pub(crate) fn write_export(
    path: &str,
    data: &PortableDataRecord,
    requested_selection: &PortableDataSelectionRecord,
) -> CoreResult<PortableExportResultRecord> {
    let path = absolute_portable_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("portable export path has no parent directory"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("portable export path is invalid"))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| portable_io(&temporary, error))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, data)
            .map_err(|error| invalid(format!("portable export serialization failed: {error}")))?;
        writer
            .write_all(b"\n")
            .and_then(|()| writer.flush())
            .map_err(|error| portable_io(&temporary, error))?;
        writer
            .into_inner()
            .map_err(|error| portable_io(&temporary, error.into_error()))?
            .sync_all()
            .map_err(|error| portable_io(&temporary, error))?;
        rion_platform::atomic_replace_file(&temporary, &path)
            .map_err(|error| CoreError::Platform(error.to_string()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;

    let selection = effective_selection(data, &normalize_selection(requested_selection.clone()));
    Ok(PortableExportResultRecord {
        file_path: path.to_string_lossy().into_owned(),
        game_count: data.games.len() as u32,
        role_count: data.roles.len() as u32,
        workspace_count: data.launch_workspaces.len() as u32,
        game_window_count: data.game_windows.len() as u32,
        macro_count: data.macros.len() as u32,
        preferences_included: data.preferences.is_some(),
        selection,
    })
}

fn absolute_portable_path(value: &str) -> CoreResult<PathBuf> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() || !path.is_absolute() {
        return Err(invalid("portable path must be absolute"));
    }
    Ok(path)
}

fn portable_io(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Platform(format!(
        "portable file operation failed for {}: {error}",
        path.display()
    ))
}
