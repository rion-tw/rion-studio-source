fn apply_domain_mutation(
    connection: &mut Connection,
    mutation: StateMutation,
) -> CoreResult<Value> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let result =
        match mutation {
            StateMutation::GameCreate(input) => {
                let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let game = create_game(&mut games, input)?;
                upsert_entity(&transaction, "games", &json_value(&game)?, games.len() - 1)?;
                serde_json::to_value(game)
            }
            StateMutation::GameUpdate { id, input } => {
                let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let game = update_game(&mut games, &id, input)?;
                let ordinal = games.iter().position(|item| item.id == id).unwrap();
                upsert_entity(&transaction, "games", &json_value(&game)?, ordinal)?;
                serde_json::to_value(game)
            }
            StateMutation::GameResetBuiltin { id } => {
                let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let game = reset_builtin_game(&mut games, &id)?;
                let ordinal = games.iter().position(|item| item.id == id).unwrap();
                upsert_entity(&transaction, "games", &json_value(&game)?, ordinal)?;
                serde_json::to_value(game)
            }
            StateMutation::GameDelete { id } => {
                let mut games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                delete_game(&mut games, &roles, &id)?;
                transaction
                    .execute("DELETE FROM games WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                Ok(json!({ "deleted": true }))
            }
            StateMutation::GamesDelete { ids } => {
                let requested = normalize_bulk_ids(ids)?;
                let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let mut deleted_ids = Vec::new();
                let mut skipped = Vec::new();
                for id in requested {
                    let Some(game) = games.iter().find(|game| game.id == id) else {
                        skipped.push(bulk_skip(id, "not_found", Vec::new()));
                        continue;
                    };
                    if game.source == "builtin" {
                        skipped.push(bulk_skip(id, "protected", Vec::new()));
                        continue;
                    }
                    let related_names = roles
                        .iter()
                        .filter(|role| role.game_id == id)
                        .map(|role| role.name.clone())
                        .collect::<Vec<_>>();
                    if !related_names.is_empty() {
                        skipped.push(bulk_skip(id, "in_use", related_names));
                        continue;
                    }
                    transaction
                        .execute("DELETE FROM games WHERE id=?1", params![id])
                        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                    deleted_ids.push(id);
                }
                Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
            }
            StateMutation::RoleCreate(input) => {
                let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let role = create_role(&games, &mut roles, input)?;
                upsert_entity(&transaction, "roles", &json_value(&role)?, roles.len() - 1)?;
                serde_json::to_value(role)
            }
            StateMutation::RoleCreateWithId { id, input } => {
                let id = uuid::Uuid::parse_str(&id)
                    .map_err(|_| CoreError::InvalidInput("Role id is invalid.".to_owned()))?
                    .to_string();
                let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                if roles.iter().any(|role| role.id == id) {
                    return Err(CoreError::Domain {
                        code: "ROLE_ID_CONFLICT",
                        message: "Role id is already in use.".to_owned(),
                    });
                }
                let mut role = create_role(&games, &mut roles, input)?;
                role.id = id;
                let ordinal = roles.len() - 1;
                roles[ordinal] = role.clone();
                upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
                serde_json::to_value(role)
            }
            StateMutation::RoleUpdate { id, input } => {
                let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let role = update_role(&games, &mut roles, &id, input)?;
                let ordinal = roles.iter().position(|item| item.id == id).unwrap();
                upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
                serde_json::to_value(role)
            }
            StateMutation::RoleReorder { ordered_ids } => {
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                reorder_roles(&mut roles, &ordered_ids)?;
                update_ordinals(&transaction, "roles", &ordered_ids)?;
                serde_json::to_value(&roles)
            }
            StateMutation::RoleDelete { id, operation_id } => {
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let original_len = roles.len();
                roles.retain(|role| role.id != id);
                if roles.len() == original_len {
                    return Err(CoreError::Domain {
                        code: "ROLE_NOT_FOUND",
                        message: "Role not found.".to_owned(),
                    });
                }
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                for workspace in &mut workspaces {
                    for slot in &mut workspace.slots {
                        if slot.role_id.as_deref() == Some(&id) {
                            slot.role_id = None;
                        }
                    }
                }
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                clear_macro_role(&mut macros, &id);
                transaction
                    .execute("DELETE FROM roles WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                sync_workspaces(&transaction, &workspaces)?;
                sync_macros(&transaction, &macros)?;
                if let Some(operation_id) = operation_id {
                    set_operation_journal_phase(&transaction, &operation_id, "committed")?;
                }
                Ok(json!({ "deleted": true }))
            }
            StateMutation::RolesDelete { ids, operation_ids } => {
                let requested = normalize_bulk_ids(ids)?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let existing_ids = roles
                    .iter()
                    .map(|role| role.id.as_str())
                    .collect::<std::collections::HashSet<_>>();
                let deleted_ids = requested
                    .iter()
                    .filter(|id| existing_ids.contains(id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                let skipped = requested
                    .iter()
                    .filter(|id| !existing_ids.contains(id.as_str()))
                    .map(|id| bulk_skip(id.clone(), "not_found", Vec::new()))
                    .collect::<Vec<_>>();
                let deleted = deleted_ids.iter().collect::<std::collections::HashSet<_>>();
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                for workspace in &mut workspaces {
                    for slot in &mut workspace.slots {
                        if slot
                            .role_id
                            .as_ref()
                            .is_some_and(|role_id| deleted.contains(role_id))
                        {
                            slot.role_id = None;
                        }
                    }
                }
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                for role_id in &deleted_ids {
                    clear_macro_role(&mut macros, role_id);
                }
                for id in &deleted_ids {
                    transaction
                        .execute("DELETE FROM roles WHERE id=?1", params![id])
                        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                    if let Some(operation_id) = operation_ids.get(id) {
                        set_operation_journal_phase(&transaction, operation_id, "committed")?;
                    }
                }
                sync_workspaces(&transaction, &workspaces)?;
                sync_macros(&transaction, &macros)?;
                Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
            }
            StateMutation::RoleBrowserDataReset { id, operation_id } => {
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let role = roles.iter_mut().find(|role| role.id == id).ok_or_else(|| {
                    CoreError::Domain {
                        code: "ROLE_NOT_FOUND",
                        message: "Role not found.".to_owned(),
                    }
                })?;
                role.updated_at = chrono::Utc::now().to_rfc3339();
                let role = role.clone();
                let ordinal = roles.iter().position(|item| item.id == id).unwrap();
                upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
                set_operation_journal_phase(&transaction, &operation_id, "committed")?;
                serde_json::to_value(role)
            }
            StateMutation::RoleAssignGameIds(assignments) => {
                let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
                let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                assign_role_game_ids(&games, &mut roles, &assignments)?;
                for (ordinal, role) in roles.iter().enumerate() {
                    upsert_entity(&transaction, "roles", &json_value(role)?, ordinal)?;
                }
                serde_json::to_value(&roles)
            }
            StateMutation::WorkspaceCreate(input) => {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let workspace = create_workspace(&mut workspaces, input)?;
                validate_workspace_role_references(&workspace, &roles)?;
                upsert_workspace(&transaction, &json_value(&workspace)?, workspaces.len() - 1)?;
                serde_json::to_value(workspace)
            }
            StateMutation::WorkspaceUpdate { id, input } => {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let workspace = update_workspace(&mut workspaces, &id, input)?;
                validate_workspace_role_references(&workspace, &roles)?;
                let ordinal = workspaces.iter().position(|item| item.id == id).unwrap();
                upsert_workspace(&transaction, &json_value(&workspace)?, ordinal)?;
                serde_json::to_value(workspace)
            }
            StateMutation::WorkspaceReorder { ordered_ids } => {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                reorder_workspaces(&mut workspaces, &ordered_ids)?;
                update_ordinals(&transaction, "workspaces", &ordered_ids)?;
                serde_json::to_value(&workspaces)
            }
            StateMutation::WorkspaceDelete { id } => {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                delete_workspace(&mut workspaces, &id)?;
                transaction
                    .execute("DELETE FROM workspaces WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                Ok(json!({ "deleted": true }))
            }
            StateMutation::WorkspacesDelete { ids } => {
                let requested = normalize_bulk_ids(ids)?;
                let workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                let existing_ids = workspaces
                    .iter()
                    .map(|workspace| workspace.id.as_str())
                    .collect::<std::collections::HashSet<_>>();
                let deleted_ids = requested
                    .iter()
                    .filter(|id| existing_ids.contains(id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                let skipped = requested
                    .iter()
                    .filter(|id| !existing_ids.contains(id.as_str()))
                    .map(|id| bulk_skip(id.clone(), "not_found", Vec::new()))
                    .collect::<Vec<_>>();
                for id in &deleted_ids {
                    transaction
                        .execute("DELETE FROM workspaces WHERE id=?1", params![id])
                        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                }
                Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
            }
            StateMutation::WorkspaceClearRole { role_id } => {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                clear_workspace_role(&mut workspaces, &role_id);
                sync_workspaces(&transaction, &workspaces)?;
                Ok(json!({ "cleared": true }))
            }
            StateMutation::WorkspaceSetRoleBrowserZoom {
                workspace_id,
                role_id,
                browser_zoom_percent,
            } => {
                let mut workspaces = read_typed_collection::<StateLaunchWorkspaceRecord>(
                    &transaction,
                    "launchWorkspaces",
                )?;
                let workspace = crate::domain::set_workspace_role_browser_zoom(
                    &mut workspaces,
                    &workspace_id,
                    &role_id,
                    browser_zoom_percent,
                )?;
                if let Some(workspace) = &workspace {
                    let ordinal = workspaces
                        .iter()
                        .position(|item| item.id == workspace_id)
                        .unwrap();
                    upsert_workspace(&transaction, &json_value(workspace)?, ordinal)?;
                }
                serde_json::to_value(workspace)
            }
            StateMutation::GameWindowCreate(input) => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                let game_window = create_game_window(&mut game_windows, input)?;
                upsert_game_window(
                    &transaction,
                    &json_value(&game_window)?,
                    game_windows.len() - 1,
                )?;
                serde_json::to_value(game_window)
            }
            StateMutation::GameWindowSaveRuntime(input) => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                let game_window = save_runtime_game_window(&mut game_windows, input)?;
                let ordinal = game_windows
                    .iter()
                    .position(|window| window.id == game_window.id)
                    .expect("saved runtime Game Window must be in the collection");
                upsert_game_window(&transaction, &json_value(&game_window)?, ordinal)?;
                serde_json::to_value(game_window)
            }
            StateMutation::GameWindowUpdate { id, input } => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                let game_window = update_game_window(&mut game_windows, &id, input)?;
                let ordinal = game_windows
                    .iter()
                    .position(|window| window.id == id)
                    .unwrap();
                upsert_game_window(&transaction, &json_value(&game_window)?, ordinal)?;
                serde_json::to_value(game_window)
            }
            StateMutation::GameWindowReorder { ordered_ids } => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                reorder_game_windows(&mut game_windows, &ordered_ids)?;
                update_ordinals(&transaction, "game_windows", &ordered_ids)?;
                serde_json::to_value(game_windows)
            }
            StateMutation::GameWindowDelete { id } => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                delete_game_window(&mut game_windows, &id)?;
                transaction
                    .execute("DELETE FROM game_windows WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                Ok(json!({ "deleted": true }))
            }
            StateMutation::GameWindowDeleteIfUnchanged { id, updated_at } => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                let deleted = delete_game_window_if_unchanged(&mut game_windows, &id, &updated_at);
                if deleted {
                    transaction
                        .execute("DELETE FROM game_windows WHERE id=?1", params![id])
                        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                }
                Ok(json!({ "deleted": deleted }))
            }
            StateMutation::GameWindowsRuntimeSync { windows } => {
                let mut game_windows =
                    read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
                let mut updates = Vec::new();
                for window in windows {
                    let Some(ordinal) = game_windows
                        .iter()
                        .position(|candidate| candidate.id == window.id)
                    else {
                        continue;
                    };
                    game_windows[ordinal] = window.clone();
                    updates.push((ordinal, window));
                }
                validate_game_window_collection(&game_windows)?;
                for (ordinal, window) in &updates {
                    upsert_game_window(&transaction, &json_value(window)?, *ordinal)?;
                }
                serde_json::to_value(
                    updates
                        .into_iter()
                        .map(|(_, window)| window)
                        .collect::<Vec<_>>(),
                )
            }
            StateMutation::MacroCreate(input) => {
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let macro_record = create_macro(&mut macros, input)?;
                validate_macro_role_references(&macro_record, &roles)?;
                upsert_macro(&transaction, &json_value(&macro_record)?, macros.len() - 1)?;
                serde_json::to_value(macro_record)
            }
            StateMutation::MacroUpdate { id, input } => {
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                let roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
                let macro_record = update_macro(&mut macros, &id, input)?;
                validate_macro_role_references(&macro_record, &roles)?;
                let ordinal = macros.iter().position(|item| item.id == id).unwrap();
                upsert_macro(&transaction, &json_value(&macro_record)?, ordinal)?;
                serde_json::to_value(macro_record)
            }
            StateMutation::MacroDelete { id } => {
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                delete_macro(&mut macros, &id)?;
                transaction
                    .execute("DELETE FROM macros WHERE id=?1", params![id])
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                Ok(json!({ "deleted": true }))
            }
            StateMutation::MacrosDelete { ids } => {
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                let (deleted_ids, skipped) = delete_macros(&mut macros, &ids);
                for id in &deleted_ids {
                    transaction
                        .execute("DELETE FROM macros WHERE id=?1", params![id])
                        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
                }
                Ok(json!({
                    "deletedIds": deleted_ids,
                    "skipped": skipped.into_iter().map(|(id, reason, related_names)| json!({
                        "id": id,
                        "reason": reason,
                        "relatedNames": related_names
                    })).collect::<Vec<_>>()
                }))
            }
            StateMutation::MacrosClearRole { role_id } => {
                let mut macros = read_typed_collection::<StateMacroRecord>(&transaction, "macros")?;
                clear_macro_role(&mut macros, &role_id);
                sync_macros(&transaction, &macros)?;
                Ok(json!({ "cleared": true }))
            }
        }
        .map_err(|error| CoreError::Internal(error.to_string()))?;
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(json!({ "revision": revision, "value": result }))
}

fn normalize_bulk_ids(ids: Vec<String>) -> CoreResult<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let id = id.trim().to_owned();
        if id.is_empty() {
            return Err(CoreError::InvalidInput(
                "Bulk delete input is invalid.".to_owned(),
            ));
        }
        if seen.insert(id.clone()) {
            normalized.push(id);
        }
    }
    Ok(normalized)
}

fn bulk_skip(id: String, reason: &str, related_names: Vec<String>) -> Value {
    json!({
        "id": id,
        "reason": reason,
        "relatedNames": related_names
    })
}

fn read_operation_journals(connection: &Connection) -> CoreResult<Vec<OperationJournalRecord>> {
    let mut statement = connection
        .prepare(
            "SELECT id, kind, phase, payload_json
             FROM operation_journal ORDER BY created_at, id",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    rows.map(|row| {
        let (id, kind, phase, payload) =
            row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        Ok(OperationJournalRecord {
            id,
            kind,
            phase,
            payload: serde_json::from_str(&payload)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        })
    })
    .collect()
}

fn put_operation_journal(
    connection: &Connection,
    record: &OperationJournalRecord,
) -> CoreResult<()> {
    let payload = serde_json::to_string(&record.payload)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO operation_journal(id, kind, phase, payload_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind,
               phase=excluded.phase,
               payload_json=excluded.payload_json,
               updated_at=excluded.updated_at",
            params![
                record.id,
                record.kind,
                record.phase,
                payload,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn delete_operation_journal(connection: &Connection, id: &str) -> CoreResult<()> {
    connection
        .execute("DELETE FROM operation_journal WHERE id=?1", params![id])
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn set_operation_journal_phase(connection: &Connection, id: &str, phase: &str) -> CoreResult<()> {
    let changed = connection
        .execute(
            "UPDATE operation_journal SET phase=?2, updated_at=?3 WHERE id=?1",
            params![id, phase, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if changed == 0 {
        return Err(CoreError::StateDatabase(
            "operation journal was not found".to_owned(),
        ));
    }
    Ok(())
}

fn validate_workspace_role_references(
    workspace: &crate::model::StateLaunchWorkspaceRecord,
    roles: &[crate::model::StateRoleRecord],
) -> CoreResult<()> {
    if workspace
        .slots
        .iter()
        .filter_map(|slot| slot.role_id.as_ref())
        .any(|id| !roles.iter().any(|role| &role.id == id))
    {
        Err(CoreError::Domain {
            code: "WORKSPACE_ROLE_INVALID",
            message: "Launch workspace role was not found.".to_owned(),
        })
    } else {
        Ok(())
    }
}

fn validate_macro_role_references(
    macro_record: &StateMacroRecord,
    roles: &[crate::model::StateRoleRecord],
) -> CoreResult<()> {
    if macro_record
        .role_ids
        .iter()
        .chain(macro_shortcut_source_role_ids(
            &macro_record.shortcut_source_scope,
            &macro_record.role_ids,
        ))
        .any(|id| !roles.iter().any(|role| &role.id == id))
    {
        Err(CoreError::Domain {
            code: "MACRO_ROLE_ID_INVALID",
            message: "Macro role assignment is invalid.".to_owned(),
        })
    } else {
        Ok(())
    }
}

fn read_macro_configuration(
    connection: &Connection,
) -> CoreResult<(Vec<MacroDefinition>, MacroRuntimeSettings)> {
    let macros = read_payloads(connection, "macros")?;
    let macros = serde_json::from_value::<Vec<StateMacroRecord>>(macros)
        .map_err(|error| CoreError::StateDatabase(format!("stored macros are invalid: {error}")))?
        .into_iter()
        .map(|record| MacroDefinition {
            id: record.id,
            enabled: record.enabled,
            activation_mode: record.activation_mode,
            name: record.name,
            role_ids: record.role_ids,
            shortcut_source_scope: record.shortcut_source_scope,
            trigger: record.trigger,
            repeat: record.repeat,
            steps: record.steps,
        })
        .collect();
    let settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='macroSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .map(|payload| {
            serde_json::from_str::<MacroSettingsRecord>(&payload).map_err(|error| {
                CoreError::StateDatabase(format!("stored macro settings are invalid: {error}"))
            })
        })
        .transpose()?
        .unwrap_or_else(default_macro_settings);
    Ok((
        macros,
        MacroRuntimeSettings {
            startup_delay_ms: settings.startup_delay_ms,
            key_hold_ms: settings.key_hold_ms,
            post_input_delay_ms: settings.post_input_delay_ms,
            default_loop_delay_ms: settings.default_loop_delay_ms,
        },
    ))
}
