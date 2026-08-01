fn build_import_plan(
    data: &PortableDataRecord,
    selection: &PortableDataSelectionRecord,
    resolutions: &[PortableMacroConflictResolutionRecord],
    mut snapshot: CoreStateSnapshotRecord,
) -> CoreResult<ImportPlan> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut warnings = Vec::new();
    let mut operations = PortableImportOperationsRecord::default();
    let mut game_id_map = HashMap::new();
    let mut role_id_map = HashMap::new();
    let mut workspace_id_map = HashMap::new();

    if selection.games {
        apply_games_to_import_plan(
            data,
            &mut snapshot,
            &mut game_id_map,
            &mut warnings,
            &mut operations,
            &timestamp,
        )?;
    }

    if selection.roles {
        assert_unique_role_names(&snapshot.roles)?;
        let mut seen_keys = HashSet::new();
        for role in &data.roles {
            let source_game_id = role.game_id.as_deref().ok_or_else(role_game_missing)?;
            let game_id = game_id_map
                .get(source_game_id)
                .cloned()
                .ok_or_else(role_game_missing)?;
            if role.game_recovered == Some(true) {
                warnings.push(warning(
                    "ROLE_GAME_RECOVERED",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
            }
            let identity = role_identity(&game_id, &role.name);
            if !seen_keys.insert(identity.clone()) {
                return Err(role_name_conflict());
            }
            if let Some(index) = snapshot.roles.iter().position(|candidate| {
                role_identity(&candidate.game_id, &candidate.name) == identity
            }) {
                let existing = snapshot.roles[index].clone();
                role_id_map.insert(role.id.clone(), existing.id.clone());
                let mut updated = existing.clone();
                updated.game_id = game_id;
                updated.name = role.name.clone();
                updated.launch_url = role.launch_url.clone();
                updated.notes = role.notes.clone();
                updated.cover_image_data_url = role.cover_image_data_url.clone();
                updated.cover_image_dominant_color = role
                    .cover_image_data_url
                    .as_ref()
                    .and(role.cover_image_dominant_color.clone());
                updated.local_storage_source_role_id = None;
                updated.updated_at = timestamp.clone();
                if role_equivalent(&existing, &updated)? {
                    operations.roles.unchanged += 1;
                } else {
                    snapshot.roles[index] = updated;
                    operations.roles.update += 1;
                }
            } else {
                let created = StateRoleRecord {
                    id: Uuid::new_v4().to_string(),
                    game_id,
                    name: role.name.clone(),
                    launch_url: role.launch_url.clone(),
                    notes: role.notes.clone(),
                    cover_image_data_url: role.cover_image_data_url.clone(),
                    cover_image_dominant_color: role
                        .cover_image_data_url
                        .as_ref()
                        .and(role.cover_image_dominant_color.clone()),
                    local_storage_source_role_id: None,
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                };
                role_id_map.insert(role.id.clone(), created.id.clone());
                snapshot.roles.push(created);
                operations.roles.create += 1;
            }
        }

        for role in &data.roles {
            let Some(imported_source_id) = role.local_storage_source_role_id.as_deref() else {
                continue;
            };
            let Some(target_id) = role_id_map.get(&role.id).cloned() else {
                continue;
            };
            let Some(source_id) = role_id_map.get(imported_source_id).cloned() else {
                warnings.push(warning(
                    "ROLE_LOCAL_STORAGE_SOURCE_MISSING",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
                continue;
            };
            let portable_source_is_root = data
                .roles
                .iter()
                .find(|candidate| candidate.id == imported_source_id)
                .is_some_and(|candidate| candidate.local_storage_source_role_id.is_none());
            let portable_target_has_dependents = data.roles.iter().any(|candidate| {
                candidate.local_storage_source_role_id.as_deref() == Some(role.id.as_str())
            });
            if !portable_source_is_root || portable_target_has_dependents {
                warnings.push(warning(
                    "ROLE_LOCAL_STORAGE_BINDING_INVALID",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
                continue;
            }
            let Some(target_index) = snapshot
                .roles
                .iter()
                .position(|candidate| candidate.id == target_id)
            else {
                continue;
            };
            let mut candidate = snapshot.roles[target_index].clone();
            candidate.local_storage_source_role_id = Some(source_id);
            let has_managed_keys = snapshot
                .games
                .iter()
                .find(|game| game.id == candidate.game_id)
                .is_some_and(|game| {
                    !game.local_storage_sync_keys.is_empty()
                        || !game.local_storage_sync_selectors.is_empty()
                });
            if !has_managed_keys
                || crate::domain::validate_role_local_storage_binding(&candidate, &snapshot.roles)
                    .is_err()
            {
                warnings.push(warning(
                    "ROLE_LOCAL_STORAGE_BINDING_INVALID",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
                continue;
            }
            snapshot.roles[target_index] = candidate;
        }
    }

    if selection.launch_workspaces {
        let mut used_names = snapshot
            .launch_workspaces
            .iter()
            .map(|workspace| normalize_name_key(&workspace.name))
            .collect::<HashSet<_>>();
        let mut seen_keys = HashSet::new();
        for workspace in &data.launch_workspaces {
            let missing = workspace
                .slots
                .iter()
                .filter_map(|slot| slot.role_id.as_ref())
                .filter(|role_id| !role_id_map.contains_key(*role_id))
                .count() as u32;
            if missing > 0 {
                warnings.push(warning(
                    "WORKSPACE_ROLE_MISSING",
                    Some(workspace.name.clone()),
                    None,
                    Some(missing),
                ));
            }
            let slot_count = template_slot_count(&workspace.template)?;
            if workspace
                .slots
                .iter()
                .skip(slot_count)
                .any(|slot| slot.role_id.is_some())
            {
                return Err(invalid(
                    "portable workspace assigns a role outside its template",
                ));
            }
            let identity = normalize_name_key(&workspace.name);
            let duplicate = !seen_keys.insert(identity.clone());
            let existing_index = (!duplicate)
                .then(|| {
                    snapshot
                        .launch_workspaces
                        .iter()
                        .position(|candidate| normalize_name_key(&candidate.name) == identity)
                })
                .flatten();
            let name = if existing_index.is_some() {
                workspace.name.clone()
            } else {
                reserve_import_name(&workspace.name, &mut used_names)?
            };
            if name != workspace.name {
                warnings.push(warning(
                    "WORKSPACE_NAME_RENAMED",
                    Some(workspace.name.clone()),
                    Some(name.clone()),
                    None,
                ));
            }
            let existing = existing_index.map(|index| snapshot.launch_workspaces[index].clone());
            let defaults = default_rects(&workspace.template)?;
            let source_rects = workspace
                .slots
                .iter()
                .take(slot_count)
                .map(|slot| LayoutRect {
                    x: slot.rect.x,
                    y: slot.rect.y,
                    width: slot.rect.width,
                    height: slot.rect.height,
                })
                .collect::<Vec<_>>();
            let repaired_rects = normalize_rect_edges(&source_rects);
            let slots = defaults
                .into_iter()
                .enumerate()
                .map(|(index, default_rect)| {
                    let source = workspace.slots.get(index);
                    let role_id = source
                        .and_then(|slot| slot.role_id.as_ref())
                        .and_then(|role_id| role_id_map.get(role_id))
                        .cloned();
                    StateWorkspaceSlotRecord {
                        id: source
                            .map(|slot| slot.id.clone())
                            .filter(|id| !id.is_empty())
                            .unwrap_or_else(|| format!("slot-{}", index + 1)),
                        browser_zoom_percent: role_id
                            .as_ref()
                            .and_then(|_| source.and_then(|slot| slot.browser_zoom_percent)),
                        role_id,
                        rect: repaired_rects
                            .get(index)
                            .map(|rect| StateNormalizedRectRecord {
                                x: rect.x,
                                y: rect.y,
                                width: rect.width,
                                height: rect.height,
                            })
                            .or_else(|| source.map(|slot| slot.rect.clone()))
                            .unwrap_or(default_rect),
                    }
                })
                .collect();
            let merged = StateLaunchWorkspaceRecord {
                id: existing
                    .as_ref()
                    .map(|workspace| workspace.id.clone())
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                name,
                template: workspace.template.clone(),
                slots,
                created_at: existing
                    .as_ref()
                    .map(|workspace| workspace.created_at.clone())
                    .unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp.clone(),
            };
            let merged_id = merged.id.clone();
            if let Some(index) = existing_index {
                if workspace_equivalent(&snapshot.launch_workspaces[index], &merged)? {
                    operations.launch_workspaces.unchanged += 1;
                } else {
                    snapshot.launch_workspaces[index] = merged;
                    operations.launch_workspaces.update += 1;
                }
            } else {
                snapshot.launch_workspaces.push(merged);
                operations.launch_workspaces.create += 1;
            }
            workspace_id_map.insert(workspace.id.clone(), merged_id);
        }
    }

    if selection.game_windows {
        let incoming_ids = data
            .game_windows
            .iter()
            .map(|window| window.id.as_str())
            .collect::<HashSet<_>>();
        let mut used_names = snapshot
            .game_windows
            .iter()
            .filter(|window| !incoming_ids.contains(window.id.as_str()))
            .map(|window| normalize_name_key(&window.name))
            .collect::<HashSet<_>>();
        let mut used_tab_ids = HashSet::new();
        for window in snapshot
            .game_windows
            .iter()
            .filter(|window| !incoming_ids.contains(window.id.as_str()))
        {
            for tab in &window.tabs {
                used_tab_ids.insert(tab.id.clone());
            }
        }

        for portable in &data.game_windows {
            let existing_index = snapshot
                .game_windows
                .iter()
                .position(|window| window.id == portable.id);
            let name = reserve_import_name(&portable.name, &mut used_names)?;
            if name != portable.name {
                warnings.push(warning(
                    "GAME_WINDOW_NAME_RENAMED",
                    Some(portable.name.clone()),
                    Some(name.clone()),
                    None,
                ));
            }
            let mut tabs = Vec::new();
            let mut claimed_sources = HashSet::new();
            let mut claimed_roles = HashSet::new();
            let mut imported_tab_ids = HashMap::new();
            for tab in &portable.tabs {
                let source_id = if tab.tab_type == "role" {
                    role_id_map.get(&tab.source_id)
                } else {
                    workspace_id_map.get(&tab.source_id)
                };
                let Some(source_id) = source_id.cloned() else {
                    warnings.push(warning(
                        "GAME_WINDOW_TAB_DEPENDENCY_MISSING",
                        Some(tab.name.clone()),
                        None,
                        None,
                    ));
                    continue;
                };
                let role_ids = if tab.tab_type == "role" {
                    vec![source_id.clone()]
                } else {
                    tab.role_ids
                        .iter()
                        .filter_map(|role_id| role_id_map.get(role_id).cloned())
                        .collect::<Vec<_>>()
                };
                let source_key = format!("{}:{source_id}", tab.tab_type);
                if role_ids.is_empty()
                    || claimed_sources.contains(&source_key)
                    || role_ids
                        .iter()
                        .any(|role_id| claimed_roles.contains(role_id))
                {
                    warnings.push(warning(
                        "GAME_WINDOW_TAB_ROLE_CONFLICT",
                        Some(tab.name.clone()),
                        None,
                        None,
                    ));
                    continue;
                }
                let tab_id = if !tab.id.trim().is_empty() && used_tab_ids.insert(tab.id.clone()) {
                    tab.id.clone()
                } else {
                    let id = Uuid::new_v4().to_string();
                    used_tab_ids.insert(id.clone());
                    id
                };
                let role_views = tab
                    .role_views
                    .iter()
                    .filter_map(|view| {
                        let role_id = role_id_map.get(&view.role_id)?.clone();
                        role_ids.contains(&role_id).then(|| {
                            crate::model::GameWindowRoleViewRecord {
                                role_id,
                                rect: view.rect.clone(),
                                browser_zoom_percent: view.browser_zoom_percent,
                            }
                        })
                    })
                    .collect();
                claimed_sources.insert(source_key);
                claimed_roles.extend(role_ids.iter().cloned());
                imported_tab_ids.insert(tab.id.clone(), tab_id.clone());
                tabs.push(GameWindowTabRecord {
                    id: tab_id,
                    tab_type: tab.tab_type.clone(),
                    source_id,
                    name: tab.name.clone(),
                    role_ids,
                    hidden: tab.hidden,
                    audio_muted: tab.audio_muted,
                    role_views,
                });
            }
            let existing = existing_index.map(|index| snapshot.game_windows[index].clone());
            let merged = StateGameWindowRecord {
                id: portable.id.clone(),
                name,
                target_display: portable.target_display.clone(),
                placement: portable.placement.clone(),
                active_tab_id: portable
                    .active_tab_id
                    .as_ref()
                    .and_then(|id| imported_tab_ids.get(id).cloned())
                    .or_else(|| tabs.first().map(|tab| tab.id.clone())),
                tabs,
                created_at: existing
                    .as_ref()
                    .map(|window| window.created_at.clone())
                    .unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp.clone(),
            };
            if let Some(index) = existing_index {
                if game_window_equivalent(&snapshot.game_windows[index], &merged)? {
                    operations.game_windows.unchanged += 1;
                } else {
                    snapshot.game_windows[index] = merged;
                    operations.game_windows.update += 1;
                }
            } else {
                snapshot.game_windows.push(merged);
                operations.game_windows.create += 1;
            }
        }
        crate::domain::validate_game_window_collection(&snapshot.game_windows)?;
    }

    let mut conflicts = Vec::new();
    let mut affected_macro_ids = Vec::new();
    if selection.macros {
        let resolution_by_id = resolutions
            .iter()
            .map(|resolution| (resolution_conflict_id(resolution), resolution))
            .collect::<HashMap<_, _>>();
        if resolution_by_id.len() != resolutions.len() {
            return Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_RESOLUTION_INVALID",
                message: "Portable import conflict resolution is invalid.".to_owned(),
            });
        }
        let existing_macros = snapshot.macros.clone();
        let mut seen_keys = HashSet::new();
        let mut used_copy_names = existing_macros
            .iter()
            .map(|macro_record| normalize_name_key(&macro_record.name))
            .collect::<HashSet<_>>();
        let mut planned = Vec::new();
        for macro_record in &data.macros {
            let mut seen_role_ids = HashSet::new();
            let role_ids = macro_record
                .role_ids
                .iter()
                .filter_map(|role_id| role_id_map.get(role_id).cloned())
                .filter(|role_id| seen_role_ids.insert(role_id.clone()))
                .collect::<Vec<_>>();
            let missing = macro_record
                .role_ids
                .iter()
                .collect::<HashSet<_>>()
                .into_iter()
                .filter(|role_id| !role_id_map.contains_key(*role_id))
                .count() as u32;
            if missing > 0 {
                warnings.push(warning(
                    "MACRO_ROLE_MISSING",
                    Some(macro_record.name.clone()),
                    None,
                    Some(missing),
                ));
            }
            if !macro_record.role_ids.is_empty() && role_ids.is_empty() {
                warnings.push(warning(
                    "MACRO_SKIPPED_NO_ROLES",
                    Some(macro_record.name.clone()),
                    None,
                    None,
                ));
                operations.macros.skip += 1;
                continue;
            }
            let identity = macro_identity(&macro_record.name, &role_ids);
            if !seen_keys.insert(identity.clone()) {
                let name = reserve_import_name(&macro_record.name, &mut used_copy_names)?;
                warnings.push(warning(
                    "MACRO_NAME_RENAMED",
                    Some(macro_record.name.clone()),
                    Some(name.clone()),
                    None,
                ));
                planned.push(PlannedMacro {
                    destination_id: Uuid::new_v4().to_string(),
                    existing: None,
                    macro_record: macro_record.clone(),
                    name,
                    role_ids,
                });
                continue;
            }
            let candidates = existing_macros
                .iter()
                .filter(|candidate| {
                    macro_identity(&candidate.name, &candidate.role_ids) == identity
                })
                .cloned()
                .collect::<Vec<_>>();
            if candidates.len() <= 1 {
                planned.push(PlannedMacro {
                    destination_id: candidates
                        .first()
                        .map(|candidate| candidate.id.clone())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    existing: candidates.first().cloned(),
                    macro_record: macro_record.clone(),
                    name: macro_record.name.clone(),
                    role_ids,
                });
                continue;
            }
            let conflict_id = format!("macro:{}", macro_record.id);
            match resolution_by_id.get(conflict_id.as_str()).copied() {
                Some(PortableMacroConflictResolutionRecord::Skip { .. }) => {
                    operations.macros.skip += 1;
                }
                Some(PortableMacroConflictResolutionRecord::Copy { .. }) => {
                    let name = reserve_import_name(&macro_record.name, &mut used_copy_names)?;
                    warnings.push(warning(
                        "MACRO_NAME_RENAMED",
                        Some(macro_record.name.clone()),
                        Some(name.clone()),
                        None,
                    ));
                    planned.push(PlannedMacro {
                        destination_id: Uuid::new_v4().to_string(),
                        existing: None,
                        macro_record: macro_record.clone(),
                        name,
                        role_ids,
                    });
                }
                Some(PortableMacroConflictResolutionRecord::Update {
                    target_macro_id, ..
                }) => {
                    let selected = candidates
                        .iter()
                        .find(|candidate| &candidate.id == target_macro_id)
                        .cloned()
                        .ok_or_else(|| CoreError::Domain {
                            code: "PORTABLE_IMPORT_RESOLUTION_INVALID",
                            message: "Portable import conflict resolution is invalid.".to_owned(),
                        })?;
                    planned.push(PlannedMacro {
                        destination_id: selected.id.clone(),
                        existing: Some(selected),
                        macro_record: macro_record.clone(),
                        name: macro_record.name.clone(),
                        role_ids,
                    });
                }
                None => conflicts.push(portable_conflict(
                    &conflict_id,
                    macro_record,
                    &role_ids,
                    &candidates,
                    &snapshot.roles,
                )),
            }
        }

        let mut macro_id_map = planned
            .iter()
            .map(|item| (item.macro_record.id.clone(), item.destination_id.clone()))
            .collect::<HashMap<_, _>>();
        loop {
            let missing_index = planned.iter().position(|item| {
                item.macro_record.steps.iter().any(|step| match step {
                    MacroStepDefinition::Macro { macro_id, .. } => {
                        !macro_id_map.contains_key(macro_id)
                    }
                    _ => false,
                })
            });
            let Some(index) = missing_index else { break };
            let removed = planned.remove(index);
            macro_id_map.remove(&removed.macro_record.id);
            warnings.push(warning(
                "MACRO_SKIPPED_MISSING_DEPENDENCY",
                Some(removed.name),
                None,
                None,
            ));
            operations.macros.skip += 1;
        }

        let replaced_ids = planned
            .iter()
            .filter_map(|item| item.existing.as_ref().map(|existing| existing.id.clone()))
            .collect::<HashSet<_>>();
        let mut accepted = existing_macros
            .iter()
            .filter(|macro_record| !replaced_ids.contains(&macro_record.id))
            .cloned()
            .collect::<Vec<_>>();
        let mut replacements = HashMap::new();
        let mut created = Vec::new();
        let mut directly_affected = Vec::new();
        for item in planned {
            let mut trigger = item.macro_record.trigger.clone();
            if trigger.as_ref().is_some_and(is_overlay_trigger) {
                warnings.push(warning(
                    "MACRO_SHORTCUT_CLEARED_RESERVED",
                    Some(item.name.clone()),
                    None,
                    None,
                ));
                trigger = None;
            } else if trigger.as_ref().is_some_and(|trigger| {
                accepted.iter().any(|candidate| {
                    candidate
                        .trigger
                        .as_ref()
                        .is_some_and(|candidate_trigger| triggers_equal(candidate_trigger, trigger))
                        && roles_overlap(&candidate.role_ids, &item.role_ids)
                })
            }) {
                warnings.push(warning(
                    "MACRO_SHORTCUT_CLEARED_CONFLICT",
                    Some(item.name.clone()),
                    None,
                    None,
                ));
                trigger = None;
            }
            let steps = item
                .macro_record
                .steps
                .iter()
                .cloned()
                .map(|step| remap_macro_step(step, &macro_id_map))
                .collect::<CoreResult<Vec<_>>>()?;
            let merged = StateMacroRecord {
                id: item.destination_id,
                enabled: item.macro_record.enabled,
                activation_mode: Some(if trigger.is_some() {
                    item.macro_record.activation_mode.clone()
                } else {
                    "toggle".to_owned()
                }),
                name: item.name,
                role_ids: item.role_ids,
                trigger,
                repeat: item.macro_record.repeat,
                steps,
                created_at: item
                    .existing
                    .as_ref()
                    .map(|existing| existing.created_at.clone())
                    .unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp.clone(),
            };
            if let Some(existing) = item.existing {
                if macro_equivalent(&existing, &merged)? {
                    replacements.insert(existing.id.clone(), existing.clone());
                    accepted.push(existing);
                    operations.macros.unchanged += 1;
                } else {
                    directly_affected.push(existing.id.clone());
                    replacements.insert(existing.id, merged.clone());
                    accepted.push(merged);
                    operations.macros.update += 1;
                }
            } else {
                accepted.push(merged.clone());
                created.push(merged);
                operations.macros.create += 1;
            }
        }
        snapshot.macros = existing_macros
            .iter()
            .map(|macro_record| {
                replacements
                    .get(&macro_record.id)
                    .cloned()
                    .unwrap_or_else(|| macro_record.clone())
            })
            .chain(created)
            .collect();
        validate_macro_records(&snapshot.macros)?;
        affected_macro_ids = existing_macros
            .iter()
            .filter(|macro_record| {
                directly_affected.contains(&macro_record.id)
                    || directly_affected
                        .iter()
                        .any(|target| macro_depends_on(&existing_macros, &macro_record.id, target))
            })
            .map(|macro_record| macro_record.id.clone())
            .collect();
    }

    if selection.preferences
        && let Some(preferences) = &data.preferences
    {
        if let Some(settings) = &preferences.game_browser_settings {
            validate_game_browser_settings(settings)?;
            snapshot.game_browser_settings = Some(settings.clone());
        }
        if let Some(settings) = &preferences.macro_settings {
            validate_macro_settings(settings)?;
            snapshot.macro_settings = Some(settings.clone());
        }
    }

    Ok(ImportPlan {
        affected_macro_ids,
        conflicts,
        operations,
        snapshot,
        warnings,
    })
}
