fn migrate_game_window_role_slots(connection: &Connection) -> CoreResult<()> {
    let workspaces = read_payloads(connection, "workspaces")?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<StateLaunchWorkspaceRecord>(value.clone()).ok())
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect::<HashMap<_, _>>();
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
        let mut payload = parse_payload(&payload_json)?;
        let Some(tabs) = payload.get_mut("tabs").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut changed = false;
        for tab in tabs {
            let Some(tab) = tab.as_object_mut() else {
                continue;
            };
            if tab
                .get("roleSlots")
                .and_then(Value::as_array)
                .is_some_and(|slots| !slots.is_empty())
            {
                continue;
            }
            let role_ids = tab
                .get("roleIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if role_ids.is_empty() {
                continue;
            }
            let role_views = tab
                .get("roleViews")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let workspace = (tab.get("tabType").and_then(Value::as_str) == Some("workspace"))
                .then(|| tab.get("sourceId").and_then(Value::as_str))
                .flatten()
                .and_then(|workspace_id| workspaces.get(workspace_id));
            let count = role_ids.len().max(1) as f64;
            let role_slots = role_ids
                .iter()
                .enumerate()
                .map(|(index, role_id)| {
                    let view = role_views.iter().find(|view| {
                        view.get("roleId").and_then(Value::as_str) == Some(role_id.as_str())
                    });
                    let workspace_slot = workspace.and_then(|workspace| {
                        workspace.slots.iter().find(|slot| {
                            slot.role_id.as_deref() == Some(role_id.as_str())
                        })
                    });
                    let rect = view
                        .and_then(|view| view.get("rect").cloned())
                        .or_else(|| {
                            workspace_slot.and_then(|slot| serde_json::to_value(&slot.rect).ok())
                        })
                        .unwrap_or_else(|| {
                            json!({
                                "x": index as f64 / count,
                                "y": 0.0,
                                "width": 1.0 / count,
                                "height": 1.0
                            })
                        });
                    let zoom = view
                        .and_then(|view| view.get("browserZoomPercent").cloned())
                        .or_else(|| {
                            workspace_slot
                                .and_then(|slot| slot.browser_zoom_percent)
                                .map(Value::from)
                        });
                    let mut slot = Map::new();
                    slot.insert(
                        "slotId".to_owned(),
                        json!(workspace_slot
                            .map(|slot| slot.id.clone())
                            .unwrap_or_else(|| format!("legacy:{index}:{role_id}"))),
                    );
                    slot.insert("roleId".to_owned(), json!(role_id));
                    slot.insert("rect".to_owned(), rect);
                    if let Some(zoom) = zoom {
                        slot.insert("browserZoomPercent".to_owned(), zoom);
                    }
                    Value::Object(slot)
                })
                .collect();
            tab.insert("roleSlots".to_owned(), Value::Array(role_slots));
            tab.remove("roleIds");
            tab.remove("roleViews");
            changed = true;
        }
        if changed {
            connection
                .execute(
                    "UPDATE game_windows SET payload_json=?1 WHERE id=?2",
                    params![serialize_payload(&payload)?, window_id],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}
