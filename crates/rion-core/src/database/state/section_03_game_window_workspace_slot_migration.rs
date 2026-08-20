fn migrate_game_window_workspace_slots(connection: &Connection) -> CoreResult<()> {
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
            if tab.get("tabType").and_then(Value::as_str) != Some("workspace")
                || tab
                    .get("workspaceSlots")
                    .and_then(Value::as_array)
                    .is_some_and(|slots| !slots.is_empty())
            {
                continue;
            }
            let Some(workspace) = tab
                .get("sourceId")
                .and_then(Value::as_str)
                .and_then(|workspace_id| workspaces.get(workspace_id))
            else {
                continue;
            };
            let role_slots = tab
                .get("roleSlots")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut workspace_slots = serde_json::to_value(&workspace.slots)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            if let Some(slots) = workspace_slots.as_array_mut() {
                for slot in slots {
                    let Some(slot) = slot.as_object_mut() else {
                        continue;
                    };
                    let slot_id = slot.get("id").and_then(Value::as_str);
                    let role_id = slot.get("roleId").and_then(Value::as_str);
                    let saved = role_slots.iter().find(|saved| {
                        saved.get("slotId").and_then(Value::as_str) == slot_id
                            || (role_id.is_some()
                                && saved.get("roleId").and_then(Value::as_str) == role_id)
                    });
                    let Some(saved) = saved else {
                        continue;
                    };
                    if let Some(rect) = saved.get("rect") {
                        slot.insert("rect".to_owned(), rect.clone());
                    }
                    if let Some(zoom) = saved.get("browserZoomPercent") {
                        slot.insert("browserZoomPercent".to_owned(), zoom.clone());
                    } else {
                        slot.remove("browserZoomPercent");
                    }
                }
            }
            let role_slots = workspace_slots
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|slot| {
                    let role_id = slot.get("roleId")?.as_str()?;
                    let mut role_slot = Map::new();
                    role_slot.insert("slotId".to_owned(), slot.get("id")?.clone());
                    role_slot.insert("roleId".to_owned(), json!(role_id));
                    role_slot.insert("rect".to_owned(), slot.get("rect")?.clone());
                    if let Some(zoom) = slot.get("browserZoomPercent") {
                        role_slot.insert("browserZoomPercent".to_owned(), zoom.clone());
                    }
                    Some(Value::Object(role_slot))
                })
                .collect::<Vec<_>>();
            tab.insert("roleSlots".to_owned(), Value::Array(role_slots));
            tab.insert("workspaceSlots".to_owned(), workspace_slots);
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
