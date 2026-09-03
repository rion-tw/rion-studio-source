fn apply_domain_mutation(
    connection: &mut Connection,
    mutation: StateMutation,
) -> CoreResult<Value> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let result = match mutation {
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
        StateMutation::RoleCreateWithV23Ready {
            id,
            input,
            initialization,
        } => {
            let id = uuid::Uuid::parse_str(&id)
                .map_err(|_| CoreError::InvalidInput("Role id is invalid.".to_owned()))?
                .to_string();
            if initialization.role_id != id {
                return Err(CoreError::InvalidInput(
                    "Role initialization identity is invalid.".to_owned(),
                ));
            }
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
            crate::session_migration::insert_v23_role_initialization(
                &transaction,
                &initialization,
            )?;
            serde_json::to_value(role)
        }
        StateMutation::ChromeProfileImportMetadataCommit {
            id,
            input,
            create_role: should_create_role,
            ready,
            operation_id,
            expected_journal_revision,
        } => {
            let id = uuid::Uuid::parse_str(&id)
                .map_err(|_| CoreError::InvalidInput("Role id is invalid.".to_owned()))?
                .to_string();
            if ready.role_id != id {
                return Err(CoreError::InvalidInput(
                    "Chrome profile import role identity is invalid.".to_owned(),
                ));
            }
            let games = read_typed_collection::<StateGameRecord>(&transaction, "games")?;
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let role = if should_create_role {
                if roles.iter().any(|role| role.id == id) {
                    return Err(CoreError::Domain {
                        code: "ROLE_ID_CONFLICT",
                        message: "Role id is already in use.".to_owned(),
                    });
                }
                let mut role = create_role(&games, &mut roles, input)?;
                role.id = id.clone();
                let ordinal = roles.len() - 1;
                roles[ordinal] = role.clone();
                upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
                role
            } else {
                roles
                    .into_iter()
                    .find(|role| role.id == id)
                    .ok_or_else(|| CoreError::Domain {
                        code: "ROLE_NOT_FOUND",
                        message: "Role not found.".to_owned(),
                    })?
            };
            let existing_migration = crate::session_migration::read(&transaction, &id)?;
            let migration_evidence_created = match existing_migration {
                Some(ref migration)
                    if migration.phase == crate::RoleSessionMigrationPhase::V23Ready
                        && migration.platform == ready.platform
                        && migration.target_engine
                            == crate::RoleSessionMigrationEngine::Chromium =>
                {
                    false
                }
                Some(_) => {
                    return Err(CoreError::Domain {
                        code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                        message: "The existing role migration is not ready for Chrome profile replacement."
                            .to_owned(),
                    });
                }
                None => true,
            };
            commit_chrome_profile_import_metadata_journal(
                &transaction,
                &operation_id,
                &ready,
                expected_journal_revision,
                migration_evidence_created,
            )?;
            if migration_evidence_created {
                crate::session_migration::insert_v23_chrome_profile_import_ready(
                    &transaction,
                    &ready,
                )?;
            }
            serde_json::to_value(role)
        }
        StateMutation::ChromeProfileImportMetadataRollback {
            role_id,
            transaction_id,
            operation_id,
            expected_journal_revision,
        } => {
            rollback_chrome_profile_import_metadata(
                &transaction,
                &role_id,
                &transaction_id,
                &operation_id,
                expected_journal_revision,
            )?;
            Ok(json!({ "rolledBack": true }))
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
            prune_quick_access_items(&transaction, "role", std::slice::from_ref(&id))?;
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
            prune_quick_access_items(&transaction, "role", &deleted_ids)?;
            Ok(json!({ "deletedIds": deleted_ids, "skipped": skipped }))
        }
        StateMutation::RoleBrowserDataReset {
            id,
            operation_id,
            expected_platform,
            v23_explicit_reset,
        } => {
            if let Some(evidence) = v23_explicit_reset.as_ref() {
                validate_v23_explicit_reset_commit_fence(
                    &transaction,
                    &id,
                    &operation_id,
                    expected_platform,
                    evidence,
                )?;
            }
            let mut roles = read_typed_collection::<StateRoleRecord>(&transaction, "roles")?;
            let role =
                roles
                    .iter_mut()
                    .find(|role| role.id == id)
                    .ok_or_else(|| CoreError::Domain {
                        code: "ROLE_NOT_FOUND",
                        message: "Role not found.".to_owned(),
                    })?;
            role.updated_at = chrono::Utc::now().to_rfc3339();
            let role = role.clone();
            let ordinal = roles.iter().position(|item| item.id == id).unwrap();
            upsert_entity(&transaction, "roles", &json_value(&role)?, ordinal)?;
            if let Some(evidence) = v23_explicit_reset.as_ref() {
                crate::session_migration::commit_v23_explicit_reset(&transaction, evidence)?;
            }
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
            prune_quick_access_items(&transaction, "workspace", std::slice::from_ref(&id))?;
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
            prune_quick_access_items(&transaction, "workspace", &deleted_ids)?;
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
        StateMutation::GameWindowRuntimeSnapshotBatch { inputs } => {
            let restoring_window_ids = read_scalar(&transaction, "runtimeRestoreSession")?
                .map(|value| {
                    serde_json::from_value::<crate::model::RuntimeRestoreSessionRecord>(value)
                        .map_err(|error| {
                            CoreError::StateDatabase(format!(
                                "stored runtimeRestoreSession is invalid: {error}"
                            ))
                        })
                })
                .transpose()?
                .map(|session| {
                    session
                        .restore_in_progress_window_ids
                        .into_iter()
                        .collect::<std::collections::HashSet<_>>()
                })
                .unwrap_or_default();
            let mut game_windows =
                read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
            let mut seen = std::collections::HashSet::new();
            let mut updated = Vec::with_capacity(inputs.len());
            for input in inputs {
                let snapshot = input.snapshot;
                if !seen.insert(snapshot.window_id.clone()) {
                    return Err(CoreError::InvalidInput(
                        "runtime window snapshot batch contains a duplicate window".to_owned(),
                    ));
                }
                let id = snapshot.window_id;
                let (tabs, active_tab_id) = if restoring_window_ids.contains(&id) {
                    let saved = game_windows
                        .iter()
                        .find(|window| window.id == id)
                        .ok_or_else(|| CoreError::Domain {
                            code: "GAME_WINDOW_NOT_FOUND",
                            message: "Game window not found.".to_owned(),
                        })?;
                    merge_runtime_restore_snapshot(
                        saved,
                        snapshot.tabs,
                        snapshot.active_tab_id,
                    )?
                } else {
                    (snapshot.tabs, snapshot.active_tab_id)
                };
                let window = update_game_window(
                    &mut game_windows,
                    &id,
                    GameWindowUpdateInputRecord {
                        name: Some(input.name),
                        target_display: Some(input.target_display),
                        placement: Some(input.placement),
                        tabs: Some(tabs),
                        active_tab_id: Some(active_tab_id),
                    },
                )?;
                let ordinal = game_windows
                    .iter()
                    .position(|candidate| candidate.id == id)
                    .expect("updated Game Window remains in its validated collection");
                updated.push((ordinal, window));
            }
            validate_game_window_collection(&game_windows)?;
            for (ordinal, window) in &updated {
                upsert_game_window(&transaction, &json_value(window)?, *ordinal)?;
            }
            serde_json::to_value(
                updated
                    .into_iter()
                    .map(|(_, window)| window)
                    .collect::<Vec<_>>(),
            )
        }
        StateMutation::GameWindowsDisplayRemap { updates } => {
            let mut game_windows =
                read_typed_collection::<StateGameWindowRecord>(&transaction, "gameWindows")?;
            let mut seen = std::collections::HashSet::new();
            let mut remapped = Vec::with_capacity(updates.len());
            for update in updates {
                if !seen.insert(update.window_id.clone()) {
                    return Err(CoreError::Domain {
                        code: "GAME_WINDOW_DISPLAY_REMAP_DUPLICATE",
                        message: "A display remap transaction cannot update one game window twice."
                            .to_owned(),
                    });
                }
                let window =
                    update_game_window(&mut game_windows, &update.window_id, update.input)?;
                remapped.push(window);
            }
            for window in &remapped {
                let ordinal = game_windows
                    .iter()
                    .position(|candidate| candidate.id == window.id)
                    .expect("remapped game window remains in the collection");
                upsert_game_window(&transaction, &json_value(window)?, ordinal)?;
            }
            serde_json::to_value(remapped)
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
            prune_quick_access_items(&transaction, "gameWindow", std::slice::from_ref(&id))?;
            Ok(json!({ "deleted": true }))
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
            prune_quick_access_items(&transaction, "macro", std::slice::from_ref(&id))?;
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
            prune_quick_access_items(&transaction, "macro", &deleted_ids)?;
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
        StateMutation::QuickAccessPinSet { item, pinned } => {
            let preferences = mutate_quick_access_pin(&transaction, item, pinned)?;
            serde_json::to_value(preferences)
        }
        StateMutation::QuickAccessRecentRecord { item } => {
            let preferences = mutate_quick_access_recent(&transaction, item)?;
            serde_json::to_value(preferences)
        }
        StateMutation::QuickAccessRecentClear => {
            let preferences = clear_quick_access_recent(&transaction)?;
            serde_json::to_value(preferences)
        }
    }
    .map_err(|error| CoreError::Internal(error.to_string()))?;
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(json!({ "revision": revision, "value": result }))
}

fn merge_runtime_restore_snapshot(
    saved: &StateGameWindowRecord,
    incoming_tabs: Vec<crate::model::GameWindowTabRecord>,
    incoming_active_tab_id: Option<String>,
) -> CoreResult<(Vec<crate::model::GameWindowTabRecord>, Option<String>)> {
    let incoming_ids = incoming_tabs
        .iter()
        .map(|tab| tab.id.as_str())
        .collect::<Vec<_>>();
    let incoming_id_set = incoming_ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let expected_partial_order = saved
        .tabs
        .iter()
        .map(|tab| tab.id.as_str())
        .filter(|tab_id| incoming_id_set.contains(tab_id))
        .collect::<Vec<_>>();
    if incoming_id_set.len() != incoming_ids.len() || incoming_ids != expected_partial_order {
        return Err(CoreError::Domain {
            code: "RUNTIME_RESTORE_COHORT_DIVERGED",
            message: "A partial runtime restore no longer matches the saved ordered tab cohort."
                .to_owned(),
        });
    }

    let complete = incoming_tabs.len() == saved.tabs.len();
    let mut incoming_by_id = incoming_tabs
        .into_iter()
        .map(|tab| (tab.id.clone(), tab))
        .collect::<std::collections::HashMap<_, _>>();
    let tabs = saved
        .tabs
        .iter()
        .map(|saved_tab| {
            incoming_by_id
                .remove(saved_tab.id.as_str())
                .unwrap_or_else(|| saved_tab.clone())
        })
        .collect();
    let active_tab_id = if complete {
        incoming_active_tab_id
    } else {
        saved.active_tab_id.clone()
    };
    Ok((tabs, active_tab_id))
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

fn commit_chrome_profile_import_metadata_journal(
    transaction: &Transaction<'_>,
    operation_id: &str,
    ready: &crate::session_migration::V23ChromeProfileImportReadyEvidence,
    expected_revision: u64,
    migration_evidence_created: bool,
) -> CoreResult<()> {
    let (kind, phase, payload_json) = transaction
        .query_row(
            "SELECT kind, phase, payload_json FROM operation_journal WHERE id=?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| CoreError::Domain {
            code: "CHROME_PROFILE_IMPORT_JOURNAL_INVALID",
            message: "The Chrome profile import transaction journal is invalid.".to_owned(),
        })?;
    let mut journal = OperationJournalRecord {
        id: operation_id.to_owned(),
        kind,
        phase,
        payload: serde_json::from_str(&payload_json).map_err(|_| CoreError::Domain {
            code: "CHROME_PROFILE_IMPORT_JOURNAL_INVALID",
            message: "The Chrome profile import transaction journal is invalid.".to_owned(),
        })?,
    };
    if journal.kind != "chrome_profile_import_v2"
        || journal.phase != "freshVerified"
        || crate::chrome_profile_import_contract::journal_revision(&journal)? != expected_revision
        || journal.payload.get("roleId").and_then(Value::as_str) != Some(ready.role_id.as_str())
        || journal.payload.get("transactionId").and_then(Value::as_str)
            != Some(ready.transaction_id.as_str())
    {
        return Err(CoreError::Domain {
            code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
            message: "The Chrome profile import transaction changed before metadata commit."
                .to_owned(),
        });
    }
    let payload = journal
        .payload
        .as_object_mut()
        .ok_or_else(chrome_profile_import_metadata_commit_fence_error)?;
    if payload.contains_key(CHROME_PROFILE_IMPORT_MIGRATION_EVIDENCE_CREATED_KEY) {
        return Err(chrome_profile_import_metadata_commit_fence_error());
    }
    payload.insert(
        CHROME_PROFILE_IMPORT_MIGRATION_EVIDENCE_CREATED_KEY.to_owned(),
        Value::Bool(migration_evidence_created),
    );
    crate::chrome_profile_import_contract::advance_journal(&mut journal, "metadataCommitted")?;
    let next_payload = serde_json::to_string(&journal.payload)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let changed = transaction
        .execute(
            "UPDATE operation_journal SET phase=?2, payload_json=?3, updated_at=?4
             WHERE id=?1 AND kind='chrome_profile_import_v2'
               AND phase='freshVerified' AND payload_json=?5",
            params![
                operation_id,
                journal.phase,
                next_payload,
                chrono::Utc::now().to_rfc3339(),
                payload_json,
            ],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if changed != 1 {
        return Err(CoreError::Domain {
            code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
            message: "The Chrome profile import transaction changed before metadata commit."
                .to_owned(),
        });
    }
    Ok(())
}

const CHROME_PROFILE_IMPORT_MIGRATION_EVIDENCE_CREATED_KEY: &str =
    "migrationEvidenceCreated";

fn chrome_profile_import_metadata_commit_fence_error() -> CoreError {
    CoreError::Domain {
        code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
        message: "The Chrome profile import transaction changed before metadata commit."
            .to_owned(),
    }
}

fn rollback_chrome_profile_import_metadata(
    transaction: &Transaction<'_>,
    role_id: &str,
    transaction_id: &str,
    operation_id: &str,
    expected_revision: u64,
) -> CoreResult<()> {
    let role_id = uuid::Uuid::parse_str(role_id)
        .map_err(|_| CoreError::InvalidInput("Role id is invalid.".to_owned()))?
        .to_string();
    let transaction_id = uuid::Uuid::parse_str(transaction_id)
        .map_err(|_| CoreError::InvalidInput("Transaction id is invalid.".to_owned()))?
        .to_string();
    let (kind, phase, payload_json) = transaction
        .query_row(
            "SELECT kind, phase, payload_json FROM operation_journal WHERE id=?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| chrome_profile_import_metadata_rollback_fence_error())?;
    let journal = OperationJournalRecord {
        id: operation_id.to_owned(),
        kind,
        phase,
        payload: serde_json::from_str(&payload_json)
            .map_err(|_| chrome_profile_import_metadata_rollback_fence_error())?,
    };
    if journal.kind != "chrome_profile_import_v2"
        || !matches!(journal.phase.as_str(), "metadataCommitted" | "committing")
        || crate::chrome_profile_import_contract::journal_revision(&journal)? != expected_revision
        || journal.payload.get("roleId").and_then(Value::as_str) != Some(role_id.as_str())
        || journal.payload.get("transactionId").and_then(Value::as_str)
            != Some(transaction_id.as_str())
    {
        return Err(chrome_profile_import_metadata_rollback_fence_error());
    }
    let migration_evidence_created = journal
        .payload
        .get(CHROME_PROFILE_IMPORT_MIGRATION_EVIDENCE_CREATED_KEY)
        .and_then(Value::as_bool)
        .ok_or_else(chrome_profile_import_metadata_rollback_fence_error)?;
    if !migration_evidence_created {
        return Ok(());
    }
    let receipt = serde_json::from_value::<
        crate::chrome_profile_import_contract::ChromeProfileImportFreshVerificationReceipt,
    >(
        journal
            .payload
            .get("freshVerificationReceipt")
            .cloned()
            .ok_or_else(chrome_profile_import_metadata_rollback_fence_error)?,
    )
    .map_err(|_| chrome_profile_import_metadata_rollback_fence_error())?;
    let migration = crate::session_migration::read(transaction, &role_id)?
        .ok_or_else(chrome_profile_import_metadata_rollback_fence_error)?;
    let staging_sha256 = journal
        .payload
        .get("stagingSha256")
        .and_then(Value::as_str)
        .ok_or_else(chrome_profile_import_metadata_rollback_fence_error)?;
    if migration.transfer_id != transaction_id
        || migration.phase != crate::RoleSessionMigrationPhase::V23Ready
        || migration.journal_revision != 1
        || migration.target_engine != crate::RoleSessionMigrationEngine::Chromium
        || migration.source_revision != 0
        || migration.target_revision != Some(1)
        || migration.outcome != Some(crate::RoleSessionMigrationOutcome::Verified)
        || migration.envelope_sha256.as_deref() != Some(staging_sha256)
        || migration.inventory_sha256.as_deref() != Some(receipt.inventory_sha256.as_str())
        || migration.cookie_count != Some(u64::from(receipt.cookie_count))
        || migration.local_storage_origin_count != Some(u64::from(receipt.local_storage_count > 0))
        || migration.local_storage_entry_count != Some(u64::from(receipt.local_storage_count))
        || migration.first_verified_launch_at.is_some()
    {
        return Err(chrome_profile_import_metadata_rollback_fence_error());
    }
    let changed = transaction
        .execute(
            "DELETE FROM role_session_migrations
             WHERE role_id=?1 AND transfer_id=?2 AND phase='v23Ready'
               AND journal_revision=1 AND first_verified_launch_at IS NULL
               AND target_engine='chromium' AND source_revision=0
               AND target_revision=1 AND outcome='verified'",
            params![role_id, transaction_id],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if changed != 1 {
        return Err(chrome_profile_import_metadata_rollback_fence_error());
    }
    Ok(())
}

fn chrome_profile_import_metadata_rollback_fence_error() -> CoreError {
    CoreError::Domain {
        code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
        message: "The Chrome profile import transaction changed before metadata rollback."
            .to_owned(),
    }
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

fn validate_v23_explicit_reset_commit_fence(
    transaction: &Transaction<'_>,
    role_id: &str,
    operation_id: &str,
    expected_platform: crate::RoleSessionMigrationPlatform,
    evidence: &V23RoleExplicitResetEvidence,
) -> CoreResult<()> {
    let mismatch = || CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_EXPLICIT_RESET_FENCE_MISMATCH",
        message: "The explicit-reset transaction fence no longer matches its role clear."
            .to_owned(),
    };
    if evidence.role_id != role_id
        || evidence.platform != expected_platform
        || evidence.reset_receipt_id != format!("role-browser-clear:{operation_id}")
        || evidence
            .clean_flush_receipt_id
            .strip_prefix("chromium-session-clear:")
            .is_none_or(str::is_empty)
    {
        return Err(mismatch());
    }

    let journal = transaction
        .query_row(
            "SELECT kind, phase, payload_json FROM operation_journal WHERE id=?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .ok_or_else(&mismatch)?;
    let payload = serde_json::from_str::<Value>(&journal.2).map_err(|_| mismatch())?;
    let deferred_by_windows_lock = match payload.get("deferredByWindowsLock") {
        Some(Value::Bool(value)) => *value,
        None => false,
        Some(_) => return Err(mismatch()),
    };
    let expected_phase = if deferred_by_windows_lock {
        "deferred"
    } else {
        "quarantined"
    };
    if journal.0 != "role_browser_data_clear_v1"
        || journal.1 != expected_phase
        || payload.get("roleId").and_then(Value::as_str) != Some(role_id)
    {
        return Err(mismatch());
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
