fn apply_games_to_import_plan(
    data: &PortableDataRecord,
    snapshot: &mut CoreStateSnapshotRecord,
    game_id_map: &mut HashMap<String, String>,
    warnings: &mut Vec<PortableImportWarningRecord>,
    operations: &mut PortableImportOperationsRecord,
    timestamp: &str,
) -> CoreResult<()> {
    let mut used_names = snapshot
        .games
        .iter()
        .map(|game| normalize_name_key(&game.name))
        .collect::<HashSet<_>>();
    let mut seen_keys = HashSet::new();
    for game in &data.games {
        let identity_key = if game.source == "builtin" {
            game.builtin_key
                .as_ref()
                .map(|key| format!("builtin:{key}"))
                .unwrap_or_else(|| format!("custom:{}", normalize_name_key(&game.name)))
        } else {
            format!("custom:{}", normalize_name_key(&game.name))
        };
        let duplicate = !seen_keys.insert(identity_key);
        let existing_index = if duplicate {
            None
        } else if game.source == "builtin" {
            game.builtin_key.as_ref().and_then(|key| {
                snapshot
                    .games
                    .iter()
                    .position(|candidate| candidate.builtin_key.as_ref() == Some(key))
            })
        } else if game.inferred == Some(true) {
            snapshot.games.iter().position(|candidate| {
                candidate.source == "custom"
                    && candidate.default_launch_url == game.default_launch_url
            })
        } else {
            snapshot.games.iter().position(|candidate| {
                candidate.source == "custom"
                    && normalize_name_key(&candidate.name) == normalize_name_key(&game.name)
            })
        };
        if let Some(index) = existing_index {
            let existing = snapshot.games[index].clone();
            game_id_map.insert(game.id.clone(), existing.id.clone());
            if game.inferred == Some(true) {
                operations.games.unchanged += 1;
                continue;
            }
            let mut updated = existing.clone();
            if existing.source != "builtin" {
                updated.name = game.name.clone();
                updated.icon_image_data_url = game.icon_image_data_url.clone();
                updated.cover_image_data_url = game.cover_image_data_url.clone();
            }
            updated.default_launch_url = game.default_launch_url.clone();
            updated.local_storage_sync_keys = game.local_storage_sync_keys.clone();
            updated.updated_at = timestamp.to_owned();
            if game_equivalent(&existing, &updated)? {
                operations.games.unchanged += 1;
            } else {
                if existing.source == "builtin" {
                    warnings.push(warning(
                        "BUILTIN_GAME_DEFAULTS_REPLACED",
                        Some(existing.name.clone()),
                        None,
                        None,
                    ));
                }
                snapshot.games[index] = updated;
                operations.games.update += 1;
            }
            continue;
        }

        let mut source = game.clone();
        if duplicate && source.source == "builtin" {
            source.source = "custom".to_owned();
            source.builtin_key = None;
        }
        let name = reserve_import_name(&source.name, &mut used_names)?;
        if name != game.name {
            warnings.push(warning(
                "GAME_NAME_RENAMED",
                Some(game.name.clone()),
                Some(name.clone()),
                None,
            ));
        }
        let builtin = source.builtin_key.as_deref().and_then(builtin_by_key);
        let created = StateGameRecord {
            id: builtin
                .map(|definition| definition.id.to_owned())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            source: if builtin.is_some() {
                "builtin"
            } else {
                "custom"
            }
            .to_owned(),
            builtin_key: builtin.map(|definition| definition.key.to_owned()),
            name: builtin
                .map(|definition| definition.name.to_owned())
                .unwrap_or(name),
            icon_image_data_url: builtin
                .is_none()
                .then_some(source.icon_image_data_url)
                .flatten(),
            cover_image_data_url: builtin
                .is_none()
                .then_some(source.cover_image_data_url)
                .flatten(),
            default_launch_url: source.default_launch_url,
            local_storage_sync_keys: source.local_storage_sync_keys,
            created_at: timestamp.to_owned(),
            updated_at: timestamp.to_owned(),
        };
        game_id_map.insert(game.id.clone(), created.id.clone());
        snapshot.games.push(created);
        operations.games.create += 1;
    }

    Ok(())
}
