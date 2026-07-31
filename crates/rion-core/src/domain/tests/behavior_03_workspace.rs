    #[test]
    fn workspace_store_domain_contracts_match_v1() {
        crate::v1_case!("state-migration-1d14f6cf4383", {
            let mut workspaces = Vec::new();
            create_workspace(&mut workspaces, workspace_input(json!({"name":"Copy"}))).unwrap();
            let mut copy = workspaces.clone();
            copy[0].slots[0].role_id = Some("changed".to_owned());
            assert!(workspaces[0].slots[0].role_id.is_none());
        });

        crate::v1_case!("state-migration-16b79eaa516a", {
            let mut workspaces = Vec::new();
            let created =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Default"})))
                    .unwrap();
            assert_eq!(created.template, "two_columns");
            assert_eq!(created.slots.len(), 2);
            assert_eq!(created.slots[0].id, "slot-1");
            assert_eq!(created.slots[1].id, "slot-2");
        });

        crate::v1_case!("state-migration-75ebe8c3c038", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Zoom","slots":[
                        {"roleId":"r1","browserZoomPercent":25},
                        {"roleId":"r2"}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[0].browser_zoom_percent, Some(25.0));
            assert!(created.slots[1].browser_zoom_percent.is_none());
            assert!(
                create_workspace(
                    &mut workspaces,
                    workspace_input(json!({
                        "name":"Invalid zoom",
                        "slots":[{"roleId":"r3","browserZoomPercent":301}]
                    }))
                )
                .is_err()
            );
            assert!(
                create_workspace(
                    &mut workspaces,
                    workspace_input(json!({
                        "name":"Too small zoom",
                        "slots":[{"roleId":"r4","browserZoomPercent":24}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-40b550e6e02f", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Assigned","slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            update_workspace(
                &mut workspaces,
                &created.id,
                serde_json::from_value(json!({
                    "slots":[{"roleId":"r1"},{}]
                }))
                .unwrap(),
            )
            .unwrap();
            assert!(
                set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r2", 125.0)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r1", 125.0)
                    .unwrap()
                    .unwrap()
                    .slots[0]
                    .browser_zoom_percent,
                Some(125.0)
            );
        });

        crate::v1_case!("state-migration-4ac7d2da52d7", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Serialized zoom",
                    "slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r1", 110.0).unwrap();
            set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r2", 125.0).unwrap();
            assert_eq!(workspaces[0].slots[0].browser_zoom_percent, Some(110.0));
            assert_eq!(workspaces[0].slots[1].browser_zoom_percent, Some(125.0));
        });

        crate::v1_case!("state-migration-b94ebf809cc1", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Adaptive",
                    "resourcePolicy":{"mode":"adaptive"}
                })),
            )
            .unwrap();
            assert!(
                serde_json::to_value(created)
                    .unwrap()
                    .get("resourcePolicy")
                    .is_none()
            );
        });

        crate::v1_case!("state-migration-a26b7bfb3502", {
            let mut workspaces = Vec::new();
            create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Cleanup",
                    "slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            clear_workspace_role(&mut workspaces, "r1");
            clear_workspace_role(&mut workspaces, "r2");
            assert!(
                workspaces[0]
                    .slots
                    .iter()
                    .all(|slot| slot.role_id.is_none())
            );
        });

        crate::v1_case!("state-migration-456c08bd8759", {
            let mut workspaces = Vec::new();
            let first = create_workspace(&mut workspaces, workspace_input(json!({"name":"First"})))
                .unwrap();
            let second =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Second"})))
                    .unwrap();
            let timestamps = [first.updated_at.clone(), second.updated_at.clone()];
            reorder_workspaces(&mut workspaces, &[second.id.clone(), first.id.clone()]).unwrap();
            assert_eq!(
                workspaces
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                vec![second.id.as_str(), first.id.as_str()]
            );
            assert_eq!(workspaces[0].updated_at, timestamps[1]);
            assert_eq!(workspaces[1].updated_at, timestamps[0]);
            let third = create_workspace(&mut workspaces, workspace_input(json!({"name":"Third"})))
                .unwrap();
            assert_eq!(workspaces.last().unwrap().id, third.id);
        });

        crate::v1_case!("state-migration-4b4f49acea6a", {
            let mut workspaces = Vec::new();
            let created =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Layout"})))
                    .unwrap();
            let updated = update_workspace(
                &mut workspaces,
                &created.id,
                serde_json::from_value(json!({
                    "template":"three_columns",
                    "slots":[{"roleId":"r1"},{"roleId":"r2"},{}]
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(updated.template, "three_columns");
            assert_eq!(updated.slots.len(), 3);
            assert!(
                update_workspace(
                    &mut workspaces,
                    &created.id,
                    serde_json::from_value(json!({
                        "slots":[{"roleId":"r1"},{"roleId":"r1"},{}]
                    }))
                    .unwrap(),
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-42919f758e6e", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Resizable thirds","template":"three_columns",
                    "slots":[
                        {"rect":{"x":0,"y":0,"width":0.25,"height":1}},
                        {"rect":{"x":0.25,"y":0,"width":0.5,"height":1}},
                        {"rect":{"x":0.75,"y":0,"width":0.25,"height":1}}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[1].rect.width, 0.5);
        });

        crate::v1_case!("state-migration-b57b56106912", {
            assert_workspace_template(
                "three_columns",
                &[
                    [0.0, 0.0, 0.3333, 1.0],
                    [0.3333, 0.0, 0.3334, 1.0],
                    [0.6667, 0.0, 0.3333, 1.0],
                ],
            );
        });

        crate::v1_case!("state-migration-0350a4c0ff11", {
            let rects = normalize_workspace_rect_edges(vec![
                StateNormalizedRectRecord {
                    x: 0.0,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
                StateNormalizedRectRecord {
                    x: 0.3333,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
                StateNormalizedRectRecord {
                    x: 0.6667,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
            ]);
            assert_eq!(rects[1].width, 0.3334);
            assert_eq!(rects[0].width, 0.3333);
            assert_eq!(rects[2].width, 0.3333);
        });

        crate::v1_case!("state-migration-323cefb9afae", {
            assert_workspace_template(
                "main_right_stack_left",
                &[
                    [0.5, 0.0, 0.5, 1.0],
                    [0.0, 0.0, 0.5, 0.5],
                    [0.0, 0.5, 0.5, 0.5],
                ],
            );
        });

        crate::v1_case!("state-migration-1588b59a839e", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Resizable right","template":"main_right_stack_left",
                    "slots":[
                        {"rect":{"x":0.6,"y":0,"width":0.4,"height":1}},
                        {"rect":{"x":0,"y":0,"width":0.6,"height":0.4}},
                        {"rect":{"x":0,"y":0.4,"width":0.6,"height":0.6}}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[0].rect.x, 0.6);
            assert_eq!(created.slots[2].rect.height, 0.6);
        });

        crate::v1_case!("state-migration-37306492d6a9", {
            assert_workspace_template(
                "main_center_side_stacks",
                &[
                    [0.3, 0.0, 0.4, 1.0],
                    [0.0, 0.0, 0.3, 0.5],
                    [0.0, 0.5, 0.3, 0.5],
                    [0.7, 0.0, 0.3, 0.5],
                    [0.7, 0.5, 0.3, 0.5],
                ],
            );
        });

        crate::v1_case!("state-migration-abb686727e4e", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Resizable four","template":"four_columns",
                    "slots":[
                        {"rect":{"x":0,"y":0,"width":0.2,"height":1}},
                        {"rect":{"x":0.2,"y":0,"width":0.3,"height":1}},
                        {"rect":{"x":0.5,"y":0,"width":0.3,"height":1}},
                        {"rect":{"x":0.8,"y":0,"width":0.2,"height":1}}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[1].rect.width, 0.3);
            assert_eq!(created.slots[3].rect.x, 0.8);
        });

        crate::v1_case!("state-migration-8e8c9045207a", {
            assert_workspace_template(
                "three_columns",
                &[
                    [0.0, 0.0, 0.3333, 1.0],
                    [0.3333, 0.0, 0.3334, 1.0],
                    [0.6667, 0.0, 0.3333, 1.0],
                ],
            );
        });
        crate::v1_case!("state-migration-7e275803fcea", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Quad","template":"quad"})),
            )
            .unwrap();
            assert_eq!(workspace.slots.len(), 4);
        });
        crate::v1_case!("state-migration-426c9c61f12c", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Four","template":"four_columns"})),
            )
            .unwrap();
            assert_eq!(workspace.slots.len(), 4);
        });

        crate::v1_case!("state-migration-781fa7614848", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Custom zoom","browserZoomPercent":125
                })),
            )
            .unwrap();
            assert!(
                serde_json::to_value(&created)
                    .unwrap()
                    .get("browserZoomPercent")
                    .is_none()
            );
            let updated = update_workspace(
                &mut workspaces,
                &created.id,
                serde_json::from_value(json!({"browserZoomPercent":90})).unwrap(),
            )
            .unwrap();
            assert!(
                serde_json::to_value(updated)
                    .unwrap()
                    .get("browserZoomPercent")
                    .is_none()
            );
        });

        crate::v1_case!("state-migration-ebaa1c20914a", {
            assert_workspace_template(
                "four_columns",
                &[
                    [0.0, 0.0, 0.25, 1.0],
                    [0.25, 0.0, 0.25, 1.0],
                    [0.5, 0.0, 0.25, 1.0],
                    [0.75, 0.0, 0.25, 1.0],
                ],
            );
        });

        crate::v1_case!("state-migration-764ee3055e09", {
            assert_workspace_template(
                "three_top_two_bottom",
                &[
                    [0.0, 0.0, 0.3333, 0.5],
                    [0.3333, 0.0, 0.3334, 0.5],
                    [0.6667, 0.0, 0.3333, 0.5],
                    [0.0, 0.5, 0.5, 0.5],
                    [0.5, 0.5, 0.5, 0.5],
                ],
            );
        });
        crate::v1_case!("state-migration-fbdf387e5729", {
            assert_workspace_template(
                "two_top_three_bottom",
                &[
                    [0.0, 0.0, 0.5, 0.5],
                    [0.5, 0.0, 0.5, 0.5],
                    [0.0, 0.5, 0.3333, 0.5],
                    [0.3333, 0.5, 0.3334, 0.5],
                    [0.6667, 0.5, 0.3333, 0.5],
                ],
            );
        });
        crate::v1_case!("state-migration-e0ba5057971f", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Six","template":"six_grid"})),
            )
            .unwrap();
            assert_eq!(workspace.slots.len(), 6);
            assert_eq!(workspace.slots[3].rect.y, 0.5);
        });
        crate::v1_case!("state-migration-12fbf3f5504d", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Eight","template":"eight_grid"})),
            )
            .unwrap();
            assert_eq!(workspace.slots.len(), 8);
            assert_eq!(workspace.slots[4].rect.y, 0.5);
        });

        crate::v1_case!("state-migration-219a4ed72571", {
            let mut workspaces = Vec::new();
            create_workspace(&mut workspaces, workspace_input(json!({"name":"Party"}))).unwrap();
            assert!(
                create_workspace(&mut workspaces, workspace_input(json!({"name":" party "})))
                    .is_err()
            );
            assert!(
                create_workspace(
                    &mut workspaces,
                    workspace_input(json!({
                        "name":"Outside","template":"single",
                        "slots":[{},{"roleId":"r1"}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-997864952f1b", {
            let mut workspaces = Vec::new();
            let workspace =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Order"})))
                    .unwrap();
            for order in [
                vec![],
                vec![workspace.id.clone(), workspace.id.clone()],
                vec!["missing".to_owned()],
            ] {
                let mut attempt = workspaces.clone();
                assert!(reorder_workspaces(&mut attempt, &order).is_err());
                assert_eq!(attempt[0].id, workspace.id);
            }
        });

        crate::v1_case!("state-migration-6bb1641c8896", {
            let mut workspaces = Vec::new();
            create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Keep","slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            clear_workspace_role(&mut workspaces, "r1");
            assert_eq!(workspaces.len(), 1);
            assert!(workspaces[0].slots[0].role_id.is_none());
            assert_eq!(workspaces[0].slots[1].role_id.as_deref(), Some("r2"));
        });

        crate::v1_case!("state-migration-002e4a037a07", {
            let mut workspaces = Vec::new();
            create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Adaptive cleanup",
                    "resourcePolicy":{"mode":"adaptive"},
                    "slots":[{"roleId":"r1"},{}]
                })),
            )
            .unwrap();
            clear_workspace_role(&mut workspaces, "r1");
            assert!(workspaces[0].slots[0].role_id.is_none());
            assert!(
                serde_json::to_value(&workspaces[0])
                    .unwrap()
                    .get("resourcePolicy")
                    .is_none()
            );
        });
    }
