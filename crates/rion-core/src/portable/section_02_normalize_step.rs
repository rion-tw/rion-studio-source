fn normalize_step(
    value: &Value,
    supports_modifiers: bool,
    ids: &mut HashSet<String>,
) -> CoreResult<Value> {
    let source = object(value, "macro step")?;
    let id = optional_string(source.get("id"))
        .filter(|id| ids.insert(id.clone()))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    ids.insert(id.clone());
    match source.get("type").and_then(Value::as_str) {
        Some("key") => {
            let code = required_string(source, "code", "macro key step")?;
            let action = source
                .get("action")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|action| matches!(*action, "tap" | "hold_until_stop"))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro key action is invalid"))
                })
                .transpose()?;
            let modifiers = if supports_modifiers {
                source
                    .get("modifiers")
                    .map(|value| {
                        value
                            .as_array()
                            .ok_or_else(|| invalid("portable macro key modifiers are invalid"))
                            .and_then(|values| {
                                values
                                    .iter()
                                    .map(|value| {
                                        value
                                            .as_str()
                                            .filter(|value| {
                                                matches!(
                                                    *value,
                                                    "primary" | "ctrl" | "alt" | "shift" | "meta"
                                                )
                                            })
                                            .map(str::to_owned)
                                            .ok_or_else(|| {
                                                invalid("portable macro key modifier is invalid")
                                            })
                                    })
                                    .collect::<CoreResult<Vec<_>>>()
                            })
                    })
                    .transpose()?
            } else {
                None
            };
            let label = source
                .get("label")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|label| !label.trim().is_empty() && label.chars().count() <= 48)
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro key label is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("key")),
                ("code".to_owned(), json!(code)),
            ]);
            if let Some(modifiers) = modifiers {
                step.insert("modifiers".to_owned(), json!(modifiers));
            }
            if let Some(action) = action {
                step.insert("action".to_owned(), json!(action));
            }
            if let Some(label) = label {
                step.insert("label".to_owned(), json!(label));
            }
            Ok(Value::Object(step))
        }
        Some("click") => {
            let explicit_unit = source
                .get("unit")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|unit| matches!(*unit, "percent" | "px"))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro click unit is invalid"))
                })
                .transpose()?;
            let unit = explicit_unit.as_deref().unwrap_or("percent");
            let anchor = source
                .get("anchor")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|anchor| {
                            matches!(
                                *anchor,
                                "top-left"
                                    | "top-center"
                                    | "top-right"
                                    | "center-left"
                                    | "center"
                                    | "center-right"
                                    | "bottom-left"
                                    | "bottom-center"
                                    | "bottom-right"
                            )
                        })
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro click anchor is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("click")),
            ]);
            if let Some(unit) = explicit_unit.as_ref() {
                step.insert("unit".to_owned(), json!(unit));
            }
            if let Some(anchor) = anchor {
                step.insert("anchor".to_owned(), json!(anchor));
            }
            if unit == "px" {
                step.insert("xPx".to_owned(), json!(finite_number(source, "xPx")?));
                step.insert("yPx".to_owned(), json!(finite_number(source, "yPx")?));
                Ok(Value::Object(step))
            } else if unit == "percent" {
                step.insert(
                    "xPercent".to_owned(),
                    json!(finite_number(source, "xPercent")?),
                );
                step.insert(
                    "yPercent".to_owned(),
                    json!(finite_number(source, "yPercent")?),
                );
                Ok(Value::Object(step))
            } else {
                Err(invalid("portable macro click unit is invalid"))
            }
        }
        Some("delay") => Ok(json!({
            "id": id, "type": "delay",
            "ms": source.get("ms").and_then(Value::as_u64).filter(|value| *value <= 86_400_000).ok_or_else(|| invalid("portable macro delay is invalid"))?
        })),
        Some("macro") => {
            let mode = source
                .get("callMode")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|mode| matches!(*mode, "wait" | "trigger"))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro call mode is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("macro")),
                (
                    "macroId".to_owned(),
                    json!(required_string(source, "macroId", "macro call step")?),
                ),
            ]);
            if let Some(mode) = mode {
                step.insert("callMode".to_owned(), json!(mode));
            }
            Ok(Value::Object(step))
        }
        _ => Err(invalid("portable macro step type is invalid")),
    }
}

fn normalize_trigger(value: &Value) -> CoreResult<Value> {
    let trigger = object(value, "macro trigger")?;
    Ok(json!({
        "code": required_string(trigger, "code", "macro trigger")?,
        "ctrl": trigger.get("ctrl").and_then(Value::as_bool).unwrap_or(false),
        "alt": trigger.get("alt").and_then(Value::as_bool).unwrap_or(false),
        "shift": trigger.get("shift").and_then(Value::as_bool).unwrap_or(false),
        "meta": trigger.get("meta").and_then(Value::as_bool).unwrap_or(false)
    }))
}

fn normalize_preferences(value: Option<&Value>) -> CoreResult<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    let source = object(value, "preferences")?;
    let mut output = Map::new();
    if let Some(language) = source.get("language").and_then(Value::as_str)
        && matches!(language, "en" | "zh-TW" | "zh-CN" | "ja")
    {
        output.insert("language".to_owned(), json!(language));
    }
    if let Some(theme) = source.get("themeMode").and_then(Value::as_str)
        && matches!(theme, "system" | "light" | "dark")
    {
        output.insert("themeMode".to_owned(), json!(theme));
    }
    if let Some(value) = source.get("gameBrowserSettings")
        && value.is_object()
    {
        let settings = serde_json::from_value::<GameBrowserSettingsRecord>(value.clone())
            .map_err(|_| invalid("portable browser settings are invalid"))?;
        output.insert(
            "gameBrowserSettings".to_owned(),
            serde_json::to_value(normalize_game_browser_settings(settings))
                .map_err(|error| CoreError::Internal(error.to_string()))?,
        );
    }
    if let Some(value) = source.get("macroSettings")
        && value.is_object()
    {
        let settings = serde_json::from_value::<MacroSettingsRecord>(value.clone())
            .map_err(|_| invalid("portable macro settings are invalid"))?;
        output.insert(
            "macroSettings".to_owned(),
            serde_json::to_value(normalize_macro_settings(settings))
                .map_err(|error| CoreError::Internal(error.to_string()))?,
        );
    }
    Ok((!output.is_empty()).then_some(Value::Object(output)))
}

fn object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("portable {label} must be an object")))
}

fn required_string(object: &Map<String, Value>, key: &str, label: &str) -> CoreResult<String> {
    optional_string(object.get(key))
        .ok_or_else(|| invalid(format!("portable {label} requires {key}")))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn normalize_url(value: String) -> CoreResult<String> {
    let url = Url::parse(&value).map_err(|_| invalid("portable URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("portable URL is invalid"));
    }
    Ok(url.to_string())
}

fn copy_optional_image(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) -> CoreResult<()> {
    let Some(value) = source.get(key) else {
        return Ok(());
    };
    let image = value
        .as_str()
        .ok_or_else(|| invalid("portable image is invalid"))?;
    if image.len() > 2_000_128 || !image.starts_with("data:image/") || !image.contains(";base64,") {
        return Err(invalid("portable image is invalid"));
    }
    target.insert(key.to_owned(), json!(image));
    Ok(())
}

fn finite_number(object: &Map<String, Value>, key: &str) -> CoreResult<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid(format!("portable {key} is invalid")))
}

fn ensure_unique_ids(values: &[Value], key: &str, label: &str) -> CoreResult<()> {
    let mut ids = HashSet::new();
    for value in values {
        let id = value
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("portable {label} id is invalid")))?;
        if !ids.insert(id) {
            return Err(invalid(format!("portable {label} ids are duplicated")));
        }
    }
    Ok(())
}

fn normalize_name_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn unique_name(base: &str, used: &mut HashSet<String>) -> String {
    let base = if base.trim().is_empty() {
        "Imported Game"
    } else {
        base.trim()
    };
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            base.to_owned()
        } else {
            format!("{base} ({index})")
        };
        if used.insert(normalize_name_key(&candidate)) {
            return candidate;
        }
    }
    format!("Imported Game {}", Uuid::new_v4())
}

#[derive(Debug, Clone)]
struct PendingImport {
    created_at: Instant,
    data: PortableDataRecord,
    import_id: String,
    retired_local_storage_sync_ignored: bool,
}

#[derive(Debug, Default)]
pub(crate) struct PortableRuntime {
    pending: VecDeque<PendingImport>,
}

#[derive(Debug)]
pub(crate) struct PreparedPortableApply {
    pub affected_macro_ids: Vec<String>,
    pub result: PortableImportResultRecord,
    pub snapshot: CoreStateSnapshotRecord,
}

#[derive(Debug)]
struct ImportPlan {
    affected_macro_ids: Vec<String>,
    conflicts: Vec<PortableMacroConflictRecord>,
    operations: PortableImportOperationsRecord,
    snapshot: CoreStateSnapshotRecord,
    warnings: Vec<PortableImportWarningRecord>,
}

#[derive(Debug)]
struct PlannedMacro {
    destination_id: String,
    existing: Option<StateMacroRecord>,
    macro_record: PortableMacroRecord,
    name: String,
    role_ids: Vec<String>,
}

impl PortableRuntime {
    pub fn preview(
        &mut self,
        raw_json: &str,
        file_path: String,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PortableImportPreviewRecord> {
        if raw_json.len() as u64 > MAX_PORTABLE_BYTES {
            return Err(invalid("portable data is too large"));
        }
        let source = serde_json::from_str(raw_json)
            .map_err(|error| invalid(format!("portable JSON is invalid: {error}")))?;
        self.preview_normalized(source, file_path, snapshot)
    }

    pub fn preview_file(
        &mut self,
        file_path: String,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PortableImportPreviewRecord> {
        let path = absolute_portable_path(&file_path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| portable_io(&path, error))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(invalid("portable import path must be a regular file"));
        }
        if metadata.len() > MAX_PORTABLE_BYTES {
            return Err(invalid("portable data is too large"));
        }
        let file = fs::File::open(&path).map_err(|error| portable_io(&path, error))?;
        let source = serde_json::from_reader(BufReader::new(file))
            .map_err(|error| invalid(format!("portable JSON is invalid: {error}")))?;
        self.preview_normalized(source, file_path, snapshot)
    }

    fn preview_normalized(
        &mut self,
        source: Value,
        file_path: String,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PortableImportPreviewRecord> {
        self.prune_expired();
        let retired_local_storage_sync_ignored = source
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .is_some_and(|schema| (11..=13).contains(&schema))
            && source_has_retired_local_storage_sync(&source);
        let normalized = normalize_value(source)?;
        let data = serde_json::from_value::<PortableDataRecord>(normalized)
            .map_err(|error| invalid(format!("portable data model is invalid: {error}")))?;
        validate_preferences(data.preferences.as_ref())?;
        let mut plan = build_import_plan(&data, &all_selection(), &[], snapshot)?;
        if retired_local_storage_sync_ignored {
            plan.warnings.push(warning(
                "LOCAL_STORAGE_SYNC_IGNORED",
                None,
                None,
                None,
            ));
        }
        let import_id = Uuid::new_v4().to_string();
        while self.pending.len() >= MAX_PENDING_IMPORTS {
            self.pending.pop_front();
        }
        self.pending.push_back(PendingImport {
            created_at: Instant::now(),
            data: data.clone(),
            import_id: import_id.clone(),
            retired_local_storage_sync_ignored,
        });
        Ok(PortableImportPreviewRecord {
            import_id,
            file_path,
            exported_at: data.exported_at,
            app_version: data.app_version,
            game_count: processed_count(&plan.operations.games),
            role_count: processed_count(&plan.operations.roles),
            workspace_count: processed_count(&plan.operations.launch_workspaces),
            game_window_count: processed_count(&plan.operations.game_windows),
            macro_count: processed_count(&plan.operations.macros),
            preferences: data.preferences,
            operations: plan.operations,
            conflicts: plan.conflicts,
            warnings: plan.warnings,
        })
    }

    pub fn prepare_apply(
        &mut self,
        import_id: &str,
        selection: PortableDataSelectionRecord,
        resolutions: Vec<PortableMacroConflictResolutionRecord>,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PreparedPortableApply> {
        self.prune_expired();
        let pending = self
            .pending
            .iter()
            .find(|pending| pending.import_id == import_id)
            .ok_or_else(import_expired)?;
        let selection = normalize_selection(selection);
        ensure_selected_content(&pending.data, &selection)?;
        let mut plan = build_import_plan(&pending.data, &selection, &resolutions, snapshot)?;
        if pending.retired_local_storage_sync_ignored {
            plan.warnings.push(warning(
                "LOCAL_STORAGE_SYNC_IGNORED",
                None,
                None,
                None,
            ));
        }
        if !plan.conflicts.is_empty() {
            return Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_CONFLICT_UNRESOLVED",
                message: "Resolve every ambiguous macro before importing.".to_owned(),
            });
        }
        validate_portable_target_snapshot(&plan.snapshot)?;
        let preferences = selection
            .preferences
            .then(|| pending.data.preferences.clone())
            .flatten();
        Ok(PreparedPortableApply {
            affected_macro_ids: plan.affected_macro_ids,
            result: PortableImportResultRecord {
                game_count: processed_count(&plan.operations.games),
                role_count: processed_count(&plan.operations.roles),
                workspace_count: processed_count(&plan.operations.launch_workspaces),
                game_window_count: processed_count(&plan.operations.game_windows),
                macro_count: processed_count(&plan.operations.macros),
                preferences_included: preferences.is_some(),
                preferences,
                selection: effective_selection(&pending.data, &selection),
                operations: plan.operations,
                warnings: plan.warnings,
            },
            snapshot: plan.snapshot,
        })
    }

    pub fn discard(&mut self, import_id: &str) -> bool {
        self.prune_expired();
        let original_len = self.pending.len();
        self.pending
            .retain(|pending| pending.import_id != import_id);
        original_len != self.pending.len()
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        self.pending.retain(|pending| {
            now.saturating_duration_since(pending.created_at) <= PENDING_IMPORT_TTL
        });
    }
}

fn validate_portable_target_snapshot(snapshot: &CoreStateSnapshotRecord) -> CoreResult<()> {
    fn validate_records(
        collection: StateCollection,
        records: impl IntoIterator<Item = Value>,
    ) -> CoreResult<()> {
        records
            .into_iter()
            .try_for_each(|record| crate::domain::validate_collection_record(collection, &record))
    }

    fn unique_ids<'a>(ids: impl IntoIterator<Item = &'a str>, label: &str) -> CoreResult<()> {
        let mut seen = HashSet::new();
        if ids.into_iter().any(|id| !seen.insert(id)) {
            Err(CoreError::InvalidInput(format!(
                "portable import target contains a duplicate {label} id"
            )))
        } else {
            Ok(())
        }
    }

    validate_records(
        StateCollection::Games,
        snapshot
            .games
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Internal(error.to_string()))?,
    )?;
    validate_records(
        StateCollection::Roles,
        snapshot
            .roles
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Internal(error.to_string()))?,
    )?;
    validate_records(
        StateCollection::LaunchWorkspaces,
        snapshot
            .launch_workspaces
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Internal(error.to_string()))?,
    )?;
    validate_records(
        StateCollection::GameWindows,
        snapshot
            .game_windows
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Internal(error.to_string()))?,
    )?;
    validate_records(
        StateCollection::Macros,
        snapshot
            .macros
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Internal(error.to_string()))?,
    )?;
    unique_ids(snapshot.games.iter().map(|game| game.id.as_str()), "game")?;
    unique_ids(snapshot.roles.iter().map(|role| role.id.as_str()), "role")?;
    unique_ids(
        snapshot
            .launch_workspaces
            .iter()
            .map(|workspace| workspace.id.as_str()),
        "workspace",
    )?;
    unique_ids(
        snapshot
            .game_windows
            .iter()
            .map(|window| window.id.as_str()),
        "game window",
    )?;
    unique_ids(
        snapshot.macros.iter().map(|record| record.id.as_str()),
        "macro",
    )?;

    let game_ids = snapshot
        .games
        .iter()
        .map(|game| game.id.as_str())
        .collect::<HashSet<_>>();
    let role_ids = snapshot
        .roles
        .iter()
        .map(|role| role.id.as_str())
        .collect::<HashSet<_>>();
    let workspace_ids = snapshot
        .launch_workspaces
        .iter()
        .map(|workspace| workspace.id.as_str())
        .collect::<HashSet<_>>();
    for role in &snapshot.roles {
        if !game_ids.contains(role.game_id.as_str()) {
            return Err(invalid(
                "portable import target role references a missing game",
            ));
        }
    }
    if snapshot.launch_workspaces.iter().any(|workspace| {
        workspace
            .slots
            .iter()
            .filter_map(|slot| slot.role_id.as_deref())
            .any(|role_id| !role_ids.contains(role_id))
    }) {
        return Err(invalid(
            "portable import target workspace references a missing role",
        ));
    }
    crate::domain::validate_game_window_collection(&snapshot.game_windows)?;
    for tab in snapshot.game_windows.iter().flat_map(|window| &window.tabs) {
        let source_exists = if tab.tab_type == "workspace" {
            workspace_ids.contains(tab.source_id.as_str())
        } else {
            role_ids.contains(tab.source_id.as_str())
        };
        if !source_exists
            || tab
                .role_ids
                .iter()
                .any(|role_id| !role_ids.contains(role_id.as_str()))
        {
            return Err(invalid(
                "portable import target game window references a missing source",
            ));
        }
    }
    if snapshot
        .macros
        .iter()
        .flat_map(|record| &record.role_ids)
        .any(|role_id| !role_ids.contains(role_id.as_str()))
    {
        return Err(invalid(
            "portable import target macro references a missing role",
        ));
    }
    validate_macro_records(&snapshot.macros)?;
    if let Some(settings) = snapshot.game_browser_settings.as_ref() {
        validate_game_browser_settings(settings)?;
    }
    if let Some(settings) = snapshot.macro_settings.as_ref() {
        validate_macro_settings(settings)?;
    }
    Ok(())
}

fn source_has_retired_local_storage_sync(source: &Value) -> bool {
    source
        .get("games")
        .and_then(Value::as_array)
        .is_some_and(|games| {
            games.iter().any(|game| {
                game.get("localStorageSyncKeys").is_some()
                    || game.get("localStorageSyncSelectors").is_some()
            })
        })
        || source
            .get("roles")
            .and_then(Value::as_array)
            .is_some_and(|roles| {
                roles
                    .iter()
                    .any(|role| role.get("localStorageSourceRoleId").is_some())
            })
}
