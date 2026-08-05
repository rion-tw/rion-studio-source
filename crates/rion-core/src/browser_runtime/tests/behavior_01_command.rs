use super::*;
use serde_json::json;

fn command(value: serde_json::Value) -> BrowserRuntimeCommand {
    serde_json::from_value(value).unwrap()
}

#[test]
fn tracks_role_ownership_without_accepting_live_topology_commands() {
    let mut runtime = RoleOwnershipRuntime::default();
    let created = runtime
        .invoke(command(json!({
            "type":"createTab","sourceId":"w1","name":"Party",
            "tabType":"workspace","workspaceId":"w1","roleSlots":["r1","r2"]
        })))
        .unwrap();
    let tab_id = created.created_tab_id.unwrap();
    for role_id in ["r1", "r2"] {
        runtime
            .invoke(command(json!({
                "type":"roleTransition","roleId":role_id,"runtime":"embedded",
                "tabId":tab_id,"state":"launching"
            })))
            .unwrap();
        runtime
            .invoke(command(json!({
                "type":"roleTransition","roleId":role_id,"runtime":"embedded",
                "tabId":tab_id,"state":"running"
            })))
            .unwrap();
    }

    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.workspaces[0].state, "running");
    assert!(snapshot.workspaces[0].window_id.is_empty());
    for removed_topology_command in [
        json!({"type":"activateTab","tabId":tab_id}),
        json!({"type":"hideTab","tabId":tab_id}),
        json!({"type":"reorderTab","tabId":tab_id}),
        json!({"type":"moveTab","tabId":tab_id,"windowId":"window-2"}),
    ] {
        assert!(serde_json::from_value::<BrowserRuntimeCommand>(removed_topology_command).is_err());
    }
}

#[test]
fn duplicate_workspace_roles_project_blocked_slots_and_invalid_transitions_fail() {
    let mut runtime = RoleOwnershipRuntime::default();
    let first = runtime
        .invoke(command(json!({
            "type":"createTab","sourceId":"w1","name":"One",
            "tabType":"workspace","workspaceId":"w1","roleSlots":["r1","r2"]
        })))
        .unwrap()
        .created_tab_id
        .unwrap();
    runtime
        .invoke(command(json!({
            "type":"roleTransition","roleId":"r1","runtime":"embedded",
            "tabId":first,"state":"launching"
        })))
        .unwrap();
    let second = runtime
        .invoke(command(json!({
            "type":"createTab","sourceId":"w2","name":"Two",
            "tabType":"workspace","workspaceId":"w2","roleSlots":["r1"]
        })))
        .unwrap();
    assert_eq!(second.snapshot.workspaces.len(), 2);
    assert_eq!(
        second
            .snapshot
            .tabs
            .iter()
            .find(|tab| tab.source_id == "w2")
            .unwrap()
            .slots[0]
            .state,
        "blocked"
    );
    assert_eq!(
        runtime
            .invoke(command(json!({
                "type":"roleTransition","roleId":"r2","runtime":"embedded",
                "tabId":first,"state":"running"
            })))
            .unwrap_err()
            .code(),
        "RUNTIME_TRANSITION_INVALID"
    );
}

#[test]
fn role_slot_claims_move_one_owner_and_reject_stale_or_repeated_generations() {
    let mut runtime = RoleOwnershipRuntime::default();
    let source_tab_id = runtime
        .invoke(command(json!({
            "type":"createTab","sourceId":"w1","name":"One",
            "tabType":"workspace","workspaceId":"w1","roleSlots":["r1"]
        })))
        .unwrap()
        .created_tab_id
        .unwrap();
    runtime
        .invoke(command(json!({
            "type":"roleTransition","roleId":"r1","runtime":"embedded",
            "tabId":source_tab_id,"state":"launching"
        })))
        .unwrap();
    let target_tab_id = runtime
        .invoke(command(json!({
            "type":"createTab","sourceId":"w2","name":"Two",
            "tabType":"workspace","workspaceId":"w2","roleSlots":["r1"]
        })))
        .unwrap()
        .created_tab_id
        .unwrap();
    let before = runtime.snapshot();
    let source_owner = before.roles[0].owner.clone();
    let target_slot_id = before
        .tabs
        .iter()
        .find(|tab| tab.id == target_tab_id)
        .unwrap()
        .slots[0]
        .slot_id
        .clone();

    let claimed = runtime
        .invoke(BrowserRuntimeCommand::ClaimRoleSlot {
            role_id: "r1".to_owned(),
            tab_id: target_tab_id.clone(),
            slot_id: target_slot_id.clone(),
            expected_owner_generation: Some(source_owner.generation),
        })
        .unwrap()
        .snapshot;
    let claimed_owner = claimed.roles[0].owner.clone();
    assert_eq!(claimed_owner.tab_id, target_tab_id);
    assert_eq!(claimed_owner.slot_id, target_slot_id);
    assert!(claimed_owner.generation > source_owner.generation);
    assert_eq!(
        claimed
            .tabs
            .iter()
            .find(|tab| tab.id == source_tab_id)
            .unwrap()
            .slots[0]
            .state,
        "blocked"
    );

    let stale = runtime
        .invoke(BrowserRuntimeCommand::ClaimRoleSlot {
            role_id: "r1".to_owned(),
            tab_id: source_tab_id,
            slot_id: source_owner.slot_id,
            expected_owner_generation: Some(source_owner.generation),
        })
        .unwrap_err();
    assert_eq!(stale.code(), "RUNTIME_ROLE_OWNER_STALE");
    let repeated = runtime
        .invoke(BrowserRuntimeCommand::ClaimRoleSlot {
            role_id: "r1".to_owned(),
            tab_id: target_tab_id,
            slot_id: target_slot_id,
            expected_owner_generation: Some(claimed_owner.generation),
        })
        .unwrap_err();
    assert_eq!(repeated.code(), "RUNTIME_ROLE_SLOT_ALREADY_OWNED");
}

#[test]
fn compatibility_projection_has_no_active_or_user_order_authority() {
    let mut runtime = RoleOwnershipRuntime::default();
    let first = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let second = "00000000-0000-4000-8000-000000000000";
    let third = "88888888-8888-4888-8888-888888888888";
    for (tab_id, role_id) in [(first, "r1"), (second, "r2"), (third, "r3")] {
        runtime
            .invoke(command(json!({
                "type":"createTab","tabId":tab_id,"sourceId":role_id,"name":role_id,
                "tabType":"role","roleSlots":[role_id]
            })))
            .unwrap();
    }
    let snapshot = runtime.snapshot();
    let identity_order = [second, third, first];
    assert!(snapshot.windows.is_empty());
    assert_eq!(
        snapshot
            .tabs
            .iter()
            .map(|tab| tab.id.as_str())
            .collect::<Vec<_>>(),
        identity_order
    );
}
