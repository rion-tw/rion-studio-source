use super::*;
use crate::model::{StateWorkspaceSlotRecord, WorkspaceWebContentRecord};

fn mixed_workspace_tab(id: &str, role_id: &str) -> RuntimeLiveTabRecord {
    let mut record = tab(id, role_id);
    record.tab_type = "workspace".to_owned();
    record.source_id = "workspace-a".to_owned();
    record.role_slots = vec![GameWindowRoleSlotRecord {
        slot_id: "slot-role".to_owned(),
        role_id: role_id.to_owned(),
        rect: StateNormalizedRectRecord {
            x: 0.0,
            y: 0.0,
            width: 0.5,
            height: 1.0,
        },
        browser_zoom_percent: None,
    }];
    record.workspace_slots = vec![
        StateWorkspaceSlotRecord {
            id: "slot-role".to_owned(),
            role_id: Some(role_id.to_owned()),
            web: None,
            browser_zoom_percent: None,
            rect: record.role_slots[0].rect.clone(),
        },
        StateWorkspaceSlotRecord {
            id: "slot-web".to_owned(),
            role_id: None,
            web: Some(WorkspaceWebContentRecord {
                name: "Fixture".to_owned(),
                start_url: "https://example.test/".to_owned(),
            }),
            browser_zoom_percent: Some(110.0),
            rect: StateNormalizedRectRecord {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
        },
    ];
    record
}

#[test]
fn mixed_workspace_slot_replacement_is_atomic_revision_fenced_and_zoom_synchronized() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-workspace-layout",
            "window-a",
            vec![("window-a", 1, vec![mixed_workspace_tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let revision = before.windows["window-a"].revision;
    let mut moved = before.windows["window-a"].tabs[0].workspace_slots.clone();
    moved[0].rect.width = 0.6;
    moved[1].rect.x = 0.6;
    moved[1].rect.width = 0.4;
    let applied = kernel
        .apply(RuntimeIntent::ReplaceTabWorkspaceSlots {
            expected_revision: Some(revision),
            operation_id: "move-workspace-divider".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
            workspace_slots: moved.clone(),
        })
        .unwrap();
    assert_eq!(applied.status, RuntimeCommitStatus::Applied);
    let stale = kernel
        .apply(RuntimeIntent::ReplaceTabWorkspaceSlots {
            expected_revision: Some(revision),
            operation_id: "stale-workspace-divider".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
            workspace_slots: before.windows["window-a"].tabs[0].workspace_slots.clone(),
        })
        .unwrap();
    assert_eq!(stale.status, RuntimeCommitStatus::Superseded);
    let after_move = kernel.snapshot().unwrap();
    let tab = &after_move.windows["window-a"].tabs[0];
    assert_eq!(tab.workspace_slots, moved);
    assert_eq!(tab.role_slots[0].rect, tab.workspace_slots[0].rect);

    let zoom = kernel
        .apply(RuntimeIntent::SetRoleZoom {
            browser_zoom_percent: Some(135.0),
            expected_revision: Some(after_move.windows["window-a"].revision),
            operation_id: "workspace-role-zoom".to_owned(),
            role_id: "role-a".to_owned(),
            tab_id: "tab-a".to_owned(),
            window_id: "window-a".to_owned(),
        })
        .unwrap();
    assert_eq!(zoom.status, RuntimeCommitStatus::Applied);
    let after_zoom = kernel.snapshot().unwrap();
    let tab = &after_zoom.windows["window-a"].tabs[0];
    assert_eq!(tab.role_slots[0].browser_zoom_percent, Some(135.0));
    assert_eq!(tab.workspace_slots[0].browser_zoom_percent, Some(135.0));
}

#[test]
fn mixed_workspace_slot_replacement_rejects_content_conflicts_without_mutation() {
    let kernel = RuntimeKernel::default();
    kernel
        .apply(topology(
            "seed-invalid-workspace-layout",
            "window-a",
            vec![("window-a", 1, vec![mixed_workspace_tab("tab-a", "role-a")])],
        ))
        .unwrap();
    let before = kernel.snapshot().unwrap();
    let mut invalid = before.windows["window-a"].tabs[0].workspace_slots.clone();
    invalid[1].role_id = Some("role-a".to_owned());
    assert!(
        kernel
            .apply(RuntimeIntent::ReplaceTabWorkspaceSlots {
                expected_revision: Some(before.windows["window-a"].revision),
                operation_id: "invalid-workspace-layout".to_owned(),
                tab_id: "tab-a".to_owned(),
                window_id: "window-a".to_owned(),
                workspace_slots: invalid,
            })
            .is_err()
    );
    assert_eq!(kernel.snapshot().unwrap().revision, before.revision);
}
