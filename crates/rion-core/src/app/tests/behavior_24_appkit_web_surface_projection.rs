fn appkit_web_projection(
    core: &AppCore,
    window_id: &str,
    width: i32,
    height: i32,
    minimized: bool,
) -> crate::model::AppKitRuntimeWindowProjectionRecord {
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let window = snapshot.windows.get(window_id).unwrap();
    let mut observation = appkit_test_observation(window_id, 1);
    observation.window_generation = window.window_generation;
    observation.topology_revision = window.revision;
    observation.content_bounds.width = width;
    observation.content_bounds.height = height;
    observation.minimized = minimized;
    let event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![observation],
        action: crate::model::AppKitRuntimeEventActionRecord::Layout { layout_sequence: 1 },
    };
    core.build_appkit_projection(&event)
        .unwrap()
        .windows
        .into_iter()
        .next()
        .unwrap()
}

fn launch_appkit_web_workspace(
    core: Arc<AppCore>,
    workspace_id: &str,
    window_id: &str,
) -> String {
    let (result, actions) = drive_command(
        core,
        web_workspace_launch(workspace_id, window_id),
        None,
    );
    result.unwrap_or_else(|error| panic!("{window_id}: {error:?}"));
    actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedCreateTab { tab } => Some(tab.tab_id.clone()),
            _ => None,
        })
        .unwrap()
}

#[test]
fn appkit_projects_web_only_mixed_and_multi_web_layouts_without_managed_ownership() {
    let (_directory, core) = chromium_web_core("darwin");
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let web_only = create_web_only_workspace(&core, "AppKit Web Only");
    let mixed = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "AppKit Mixed",
                "template": "two_columns",
                "slots": [
                    {
                        "id": "managed-left",
                        "roleId": role_id,
                        "browserZoomPercent": 100,
                        "rect": workspace_rect(0, 2)
                    },
                    {
                        "id": "web-right",
                        "web": {"name": "Right", "startUrl": "https://right.example.test"},
                        "rect": workspace_rect(1, 2)
                    }
                ]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let multi = core
        .invoke(command(json!({
            "type": "workspaceCreate",
            "input": {
                "name": "AppKit Multi Web",
                "template": "two_columns",
                "slots": [
                    {
                        "id": "web-left",
                        "web": {"name": "Left", "startUrl": "https://left.example.test"},
                        "rect": workspace_rect(0, 2)
                    },
                    {
                        "id": "web-right",
                        "web": {"name": "Right", "startUrl": "https://right.example.test"},
                        "rect": workspace_rect(1, 2)
                    }
                ]
            }
        })))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let web_only_tab = launch_appkit_web_workspace(
        Arc::clone(&core),
        &web_only,
        "appkit-web-only-window",
    );
    let mixed_tab =
        launch_appkit_web_workspace(Arc::clone(&core), &mixed, "appkit-mixed-window");
    let multi_tab =
        launch_appkit_web_workspace(Arc::clone(&core), &multi, "appkit-multi-window");

    let web_only_projection =
        appkit_web_projection(&core, "appkit-web-only-window", 900, 600, false);
    assert!(web_only_projection.roles.is_empty());
    assert_eq!(web_only_projection.web_surfaces.len(), 1);
    assert_eq!(web_only_projection.web_surfaces[0].tab_id, web_only_tab);
    assert!(web_only_projection.web_surfaces[0].visible);

    let mixed_projection =
        appkit_web_projection(&core, "appkit-mixed-window", 1000, 600, false);
    assert_eq!(mixed_projection.roles.len(), 1);
    assert_eq!(mixed_projection.roles[0].role_id, role_id);
    assert_eq!(mixed_projection.web_surfaces.len(), 1);
    assert_eq!(mixed_projection.web_surfaces[0].tab_id, mixed_tab);
    assert_eq!(mixed_projection.web_surfaces[0].slot_id, "web-right");
    assert!(mixed_projection.roles[0].bounds.width < 1000);
    assert!(mixed_projection.web_surfaces[0].bounds.x > 0);

    let before_resize = appkit_web_projection(&core, "appkit-multi-window", 800, 500, false);
    assert!(before_resize.roles.is_empty());
    assert_eq!(before_resize.web_surfaces.len(), 2);
    assert!(before_resize
        .web_surfaces
        .iter()
        .all(|surface| surface.tab_id == multi_tab && surface.visible));
    assert_eq!(
        before_resize
            .web_surfaces
            .iter()
            .map(|surface| surface.slot_id.as_str())
            .collect::<Vec<_>>(),
        ["web-left", "web-right"]
    );
    let after_resize = appkit_web_projection(&core, "appkit-multi-window", 1200, 800, false);
    assert_eq!(
        before_resize.web_surfaces[0].attempt_generation,
        after_resize.web_surfaces[0].attempt_generation
    );
    assert_eq!(before_resize.window_generation, after_resize.window_generation);
    assert_eq!(before_resize.topology_revision, after_resize.topology_revision);
    assert!(
        after_resize.web_surfaces[0].bounds.width
            > before_resize.web_surfaces[0].bounds.width
    );
    assert!(
        after_resize.web_surfaces[0].bounds.height
            > before_resize.web_surfaces[0].bounds.height
    );
    let minimized = appkit_web_projection(&core, "appkit-multi-window", 1200, 800, true);
    assert!(minimized.web_surfaces.iter().all(|surface| !surface.visible));

    let runtime = core.browser_runtime_snapshot().unwrap();
    assert_eq!(runtime.roles.len(), 1);
    assert!(runtime.roles.iter().all(|role| role.role_id != web_only_tab));
    assert_eq!(core.browser_statuses().unwrap().len(), 1);
    core.shutdown();
}

#[test]
fn appkit_cross_window_move_reparents_exact_web_surface_attempt_and_generation_fences() {
    let (_directory, core) = chromium_web_core("darwin");
    let source_workspace = create_web_only_workspace(&core, "Move Source Web");
    let target_workspace = create_web_only_workspace(&core, "Move Target Web");
    let source_tab = launch_appkit_web_workspace(
        Arc::clone(&core),
        &source_workspace,
        "appkit-source-window",
    );
    let target_tab = launch_appkit_web_workspace(
        Arc::clone(&core),
        &target_workspace,
        "appkit-target-window",
    );
    let before = appkit_web_projection(&core, "appkit-source-window", 900, 600, false);
    let moved_identity = before.web_surfaces[0].clone();
    let snapshot = core.browser_runtime.snapshot().unwrap();
    let source = snapshot.windows.get("appkit-source-window").unwrap();
    let target = snapshot.windows.get("appkit-target-window").unwrap();
    let mut target_observation = appkit_test_observation("appkit-target-window", 2);
    target_observation.window_generation = target.window_generation;
    target_observation.topology_revision = target.revision;
    let mut source_observation = appkit_test_observation("appkit-source-window", 1);
    source_observation.window_generation = source.window_generation;
    source_observation.topology_revision = source.revision;
    let event = crate::model::AppKitRuntimeEventRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        adapter_sequence: 1,
        hosts: vec![target_observation, source_observation],
        action: crate::model::AppKitRuntimeEventActionRecord::Move {
            session_id: "move-web-surface-1".to_owned(),
            tab_id: source_tab.clone(),
            source_window_id: "appkit-source-window".to_owned(),
            target_window_id: "appkit-target-window".to_owned(),
            before_tab_id: None,
            ordered_tab_ids: vec![target_tab.clone(), source_tab.clone()],
            phase: "drop".to_owned(),
        },
    };
    let (result, actions, _) = drive_async_command(
        Arc::clone(&core),
        CoreCommand::BrowserAppKitRuntimeEvent { event },
        None,
    );
    let receipt: crate::model::AppKitRuntimeEventReceiptRecord =
        serde_json::from_value(result.unwrap()).unwrap();
    assert_eq!(receipt.status, crate::model::SystemRuntimeOperationStatus::Applied);
    let projection = actions
        .iter()
        .find_map(|action| match action {
            CoreEffectAction::EmbeddedApplyAppKitProjection { projection } => {
                Some(projection.as_ref())
            }
            _ => None,
        })
        .unwrap();
    let target = projection
        .windows
        .iter()
        .find(|window| window.identity.logical_window_id == "appkit-target-window")
        .unwrap();
    let source = projection
        .windows
        .iter()
        .find(|window| window.identity.logical_window_id == "appkit-source-window")
        .unwrap();
    let moved = target
        .web_surfaces
        .iter()
        .find(|surface| surface.tab_id == source_tab)
        .unwrap();
    assert_eq!(moved.surface_id, moved_identity.surface_id);
    assert_eq!(moved.slot_id, moved_identity.slot_id);
    assert_eq!(moved.attempt_generation, moved_identity.attempt_generation);
    assert!(moved.visible);
    assert!(source.web_surfaces.is_empty());
    assert_eq!(target.window_generation, receipt.window_generation);
    assert_eq!(target.topology_revision, receipt.topology_revision);
    assert_eq!(
        core.browser_runtime_snapshot()
            .unwrap()
            .tabs
            .into_iter()
            .find(|tab| tab.id == source_tab)
            .unwrap()
            .window_id,
        "appkit-target-window"
    );
    core.shutdown();
}
