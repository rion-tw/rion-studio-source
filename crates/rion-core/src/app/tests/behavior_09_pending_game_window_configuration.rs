use crate::model::{GameWindowRoleSlotRecord, GameWindowTabRecord, StateNormalizedRectRecord};

fn pending_tab(
    id: &str,
    tab_type: &str,
    source_id: &str,
    name: &str,
    role_ids: &[&str],
) -> GameWindowTabRecord {
    GameWindowTabRecord {
        id: id.to_owned(),
        tab_type: tab_type.to_owned(),
        source_id: source_id.to_owned(),
        name: name.to_owned(),
        role_slots: role_ids
            .iter()
            .enumerate()
            .map(|(index, role_id)| GameWindowRoleSlotRecord {
                slot_id: format!("slot-{index}"),
                role_id: (*role_id).to_owned(),
                rect: StateNormalizedRectRecord {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                browser_zoom_percent: None,
            })
            .collect(),
        hidden: false,
        audio_muted: false,
    }
}

#[test]
fn pending_configuration_projection_keeps_saved_order_and_ignores_runtime_only_tabs() {
    let saved = vec![
        pending_tab("saved-b", "role", "role-b", "Saved B", &["role-b"]),
        pending_tab("saved-a", "role", "role-a", "Saved A", &["role-a"]),
    ];
    let runtime = vec![
        pending_tab("runtime-a", "role", "role-a", "Live A", &["role-a"]),
        pending_tab("runtime-extra", "role", "role-extra", "Live extra", &["role-extra"]),
        pending_tab("runtime-b", "role", "role-b", "Live B", &["role-b"]),
    ];

    let projected = super::merge_pending_saved_tabs(
        &saved,
        &runtime,
        &std::collections::HashSet::new(),
    );

    assert_eq!(
        projected.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
        vec!["saved-b", "saved-a"]
    );
    assert_eq!(projected[0].name, "Live B");
    assert_eq!(projected[1].name, "Live A");
}

#[test]
fn pending_configuration_projection_does_not_reintroduce_a_removed_saved_tab() {
    let saved = vec![pending_tab(
        "saved-kept",
        "role",
        "role-kept",
        "Kept",
        &["role-kept"],
    )];
    let runtime = vec![
        pending_tab("runtime-removed", "role", "role-removed", "Removed", &["role-removed"]),
        pending_tab("runtime-kept", "role", "role-kept", "Kept live", &["role-kept"]),
    ];

    let projected = super::merge_pending_saved_tabs(
        &saved,
        &runtime,
        &std::collections::HashSet::new(),
    );

    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].source_id, "role-kept");
}
