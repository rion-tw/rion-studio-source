const CLEARED_ZOOM_FIXTURE_TIMESTAMP: &str = "2026-01-01T00:00:00Z";

fn cleared_zoom_fixture() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    let role = |id: &str| {
        json!({
            "id": id, "gameId": "g1", "name": id, "launchUrl": "https://example.test/play",
            "notes": "", "createdAt": CLEARED_ZOOM_FIXTURE_TIMESTAMP,
            "updatedAt": CLEARED_ZOOM_FIXTURE_TIMESTAMP
        })
    };
    replace_snapshot(
        &mut connection,
        &json!({
            "games": [{
                "id": "g1", "source": "custom", "name": "Game",
                "defaultLaunchUrl": "https://example.test/play", "browserLaunchMode": "inherit",
                "createdAt": CLEARED_ZOOM_FIXTURE_TIMESTAMP,
                "updatedAt": CLEARED_ZOOM_FIXTURE_TIMESTAMP
            }],
            "roles": [role("r1"), role("r2")],
            "launchWorkspaces": [{
                "id": "w1", "name": "Zoomed", "template": "two_columns",
                "slots": [
                    {
                        "id": "slot-1", "roleId": "r1", "browserZoomPercent": 150.0,
                        "rect": { "x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0 }
                    },
                    {
                        "id": "slot-2", "roleId": "r2", "browserZoomPercent": 125.0,
                        "rect": { "x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0 }
                    }
                ],
                "createdAt": CLEARED_ZOOM_FIXTURE_TIMESTAMP,
                "updatedAt": CLEARED_ZOOM_FIXTURE_TIMESTAMP
            }],
            "gameWindows": [],
            "macros": []
        }),
    )
    .unwrap();
    connection
}

fn assert_r1_slot_cleared_without_zoom(connection: &Connection, mutation: &str) {
    let workspaces =
        read_typed_collection::<StateLaunchWorkspaceRecord>(connection, "launchWorkspaces")
            .unwrap();
    let workspace = &workspaces[0];
    assert_eq!(workspace.slots[0].role_id, None, "{mutation}");
    assert_eq!(
        workspace.slots[0].browser_zoom_percent, None,
        "{mutation}: an emptied slot must not keep the removed role's zoom"
    );
    assert_eq!(workspace.slots[1].role_id.as_deref(), Some("r2"), "{mutation}");
    assert_eq!(
        workspace.slots[1].browser_zoom_percent,
        Some(125.0),
        "{mutation}"
    );
    assert_ne!(
        workspace.updated_at, CLEARED_ZOOM_FIXTURE_TIMESTAMP,
        "{mutation}"
    );
}

#[test]
fn removing_a_role_from_workspaces_clears_the_emptied_slot_zoom() {
    let mutations = [
        (
            "RoleDelete",
            StateMutation::RoleDelete {
                id: "r1".to_owned(),
                operation_id: None,
            },
        ),
        (
            "RolesDelete",
            StateMutation::RolesDelete {
                ids: vec!["r1".to_owned()],
                operation_ids: HashMap::new(),
            },
        ),
        (
            "WorkspaceClearRole",
            StateMutation::WorkspaceClearRole {
                role_id: "r1".to_owned(),
            },
        ),
    ];
    for (name, mutation) in mutations {
        let mut connection = cleared_zoom_fixture();
        apply_domain_mutation(&mut connection, mutation).unwrap();
        assert_r1_slot_cleared_without_zoom(&connection, name);
    }
}
