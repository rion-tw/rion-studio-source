fn read_quick_access_preferences(
    connection: &Connection,
) -> CoreResult<QuickAccessPreferencesRecord> {
    let stored = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='quickAccessPreferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<QuickAccessPreferencesRecord>(&payload).ok())
        .unwrap_or_else(default_quick_access_preferences);
    let preferences = crate::domain::normalize_quick_access_preferences(stored);
    Ok(QuickAccessPreferencesRecord {
        pinned_items: retain_existing_quick_access_items(connection, preferences.pinned_items)?,
        recent_items: retain_existing_quick_access_items(connection, preferences.recent_items)?,
    })
}

fn retain_existing_quick_access_items(
    connection: &Connection,
    items: Vec<QuickAccessItemRefRecord>,
) -> CoreResult<Vec<QuickAccessItemRefRecord>> {
    let mut existing = Vec::with_capacity(items.len());
    for item in items {
        if quick_access_item_exists(connection, &item)? {
            existing.push(item);
        }
    }
    Ok(existing)
}

fn write_quick_access_preferences(
    connection: &Connection,
    preferences: &QuickAccessPreferencesRecord,
) -> CoreResult<()> {
    connection
        .execute(
            "INSERT INTO settings(key, payload_json) VALUES ('quickAccessPreferences', ?1)
             ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
            params![serialize_payload(&serde_json::to_value(preferences).map_err(|error| {
                CoreError::StateDatabase(error.to_string())
            })?)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn quick_access_item_exists(
    connection: &Connection,
    item: &QuickAccessItemRefRecord,
) -> CoreResult<bool> {
    let table = match item.kind.as_str() {
        "role" => "roles",
        "workspace" => "workspaces",
        "gameWindow" => "game_windows",
        "macro" => "macros",
        _ => return Ok(false),
    };
    let sql = format!("SELECT 1 FROM {table} WHERE id=?1");
    connection
        .query_row(&sql, params![item.id], |_| Ok(()))
        .optional()
        .map(|value| value.is_some())
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn require_quick_access_item(
    connection: &Connection,
    item: QuickAccessItemRefRecord,
) -> CoreResult<QuickAccessItemRefRecord> {
    let item = crate::domain::normalize_quick_access_item(item)?;
    if quick_access_item_exists(connection, &item)? {
        Ok(item)
    } else {
        Err(CoreError::Domain {
            code: "QUICK_ACCESS_ITEM_NOT_FOUND",
            message: "Quick access item was not found.".to_owned(),
        })
    }
}

fn mutate_quick_access_pin(
    connection: &Connection,
    item: QuickAccessItemRefRecord,
    pinned: bool,
) -> CoreResult<QuickAccessPreferencesRecord> {
    let item = crate::domain::normalize_quick_access_item(item)?;
    if pinned && !quick_access_item_exists(connection, &item)? {
        return Err(CoreError::Domain {
            code: "QUICK_ACCESS_ITEM_NOT_FOUND",
            message: "Quick access item was not found.".to_owned(),
        });
    }
    let mut preferences = read_quick_access_preferences(connection)?;
    if pinned {
        if !preferences.pinned_items.contains(&item) {
            preferences.pinned_items.push(item);
        }
    } else {
        preferences.pinned_items.retain(|candidate| candidate != &item);
    }
    write_quick_access_preferences(connection, &preferences)?;
    Ok(preferences)
}

fn mutate_quick_access_recent(
    connection: &Connection,
    item: QuickAccessItemRefRecord,
) -> CoreResult<QuickAccessPreferencesRecord> {
    let item = require_quick_access_item(connection, item)?;
    let mut preferences = read_quick_access_preferences(connection)?;
    preferences.recent_items.retain(|candidate| candidate != &item);
    preferences.recent_items.insert(0, item);
    preferences
        .recent_items
        .truncate(crate::domain::QUICK_ACCESS_RECENT_LIMIT);
    write_quick_access_preferences(connection, &preferences)?;
    Ok(preferences)
}

fn clear_quick_access_recent(
    connection: &Connection,
) -> CoreResult<QuickAccessPreferencesRecord> {
    let mut preferences = read_quick_access_preferences(connection)?;
    preferences.recent_items.clear();
    write_quick_access_preferences(connection, &preferences)?;
    Ok(preferences)
}

fn prune_quick_access_items(
    connection: &Connection,
    kind: &str,
    ids: &[String],
) -> CoreResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let ids = ids.iter().map(String::as_str).collect::<std::collections::HashSet<_>>();
    let mut preferences = read_quick_access_preferences(connection)?;
    preferences
        .pinned_items
        .retain(|item| item.kind != kind || !ids.contains(item.id.as_str()));
    preferences
        .recent_items
        .retain(|item| item.kind != kind || !ids.contains(item.id.as_str()));
    write_quick_access_preferences(connection, &preferences)?;
    Ok(())
}
