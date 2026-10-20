/// Repairs saved Game Windows left with tabs for Roles or Workspaces that were
/// deleted before deletion pruned them. Restoring such a window stopped at the
/// first missing source, so it could never be shown again. A window that does
/// not decode or normalize is left unchanged rather than blocking startup.
fn migrate_dangling_game_window_sources(connection: &Connection) -> CoreResult<()> {
    let role_ids = read_entity_ids(connection, "SELECT id FROM roles")?;
    let workspace_ids = read_entity_ids(connection, "SELECT id FROM workspaces")?;
    let rows = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM game_windows ORDER BY ordinal")
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
    };
    for (window_id, payload_json) in rows {
        let Ok(window) = serde_json::from_str::<StateGameWindowRecord>(&payload_json) else {
            continue;
        };
        let mut missing_roles = std::collections::HashSet::new();
        let mut missing_workspaces = std::collections::HashSet::new();
        for tab in &window.tabs {
            match tab.tab_type.as_str() {
                "role" if !role_ids.contains(&tab.source_id) => {
                    missing_roles.insert(tab.source_id.clone());
                }
                "workspace" if !workspace_ids.contains(&tab.source_id) => {
                    missing_workspaces.insert(tab.source_id.clone());
                }
                "workspace" => {
                    let slot_roles = tab.role_slots.iter().map(|slot| &slot.role_id).chain(
                        tab.workspace_slots
                            .iter()
                            .filter_map(|slot| slot.role_id.as_ref()),
                    );
                    for role_id in slot_roles {
                        if !role_ids.contains(role_id) {
                            missing_roles.insert(role_id.clone());
                        }
                    }
                }
                _ => {}
            }
        }
        if missing_roles.is_empty() && missing_workspaces.is_empty() {
            continue;
        }
        let mut windows = [window];
        let pruned = prune_game_window_sources(
            &mut windows,
            &missing_roles.into_iter().collect::<Vec<_>>(),
            &missing_workspaces.into_iter().collect::<Vec<_>>(),
        );
        if !matches!(pruned, Ok(changed) if !changed.is_empty()) {
            continue;
        }
        let [window] = windows;
        connection
            .execute(
                "UPDATE game_windows SET payload_json=?1 WHERE id=?2",
                params![serialize_payload(&json_value(&window)?)?, window_id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn read_entity_ids(
    connection: &Connection,
    query: &str,
) -> CoreResult<std::collections::HashSet<String>> {
    let mut statement = connection
        .prepare(query)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
}
