fn topology_tab(id: &str) -> LiveTabRecord {
    LiveTabRecord {
        audio_muted: false,
        closable: true,
        icon_data_url: None,
        id: id.to_owned(),
        persistable: true,
        role_ids: vec![format!("role-{id}")],
        role_slots: Vec::new(),
        source_id: format!("source-{id}"),
        tab_type: "role".to_owned(),
        title: id.to_owned(),
        #[cfg(any(windows, target_os = "macos"))]
        workspace_template: None,
    }
}

fn topology_role_slot(tab_id: &str) -> GameWindowRoleSlotRecord {
    GameWindowRoleSlotRecord {
        slot_id: format!("slot-{tab_id}"),
        role_id: format!("role-{tab_id}"),
        rect: StateNormalizedRectRecord {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
        browser_zoom_percent: None,
    }
}

#[test]
fn role_zoom_and_layout_facades_commit_only_through_the_kernel_revision() {
    let store = LiveWindowTabStore::default();
    let mut tab = topology_tab("tab-a");
    tab.role_slots = vec![topology_role_slot("tab-a")];
    let seeded = store
        .commit(LiveTopologyCommitInput {
            commit_id: "seed-role-layout".to_owned(),
            source: "command",
            primary_window_id: "window-a".to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: Some("tab-a".to_owned()),
                hidden_tab_ids: HashSet::new(),
                tabs: vec![tab],
                ui_sequence: 1,
                window_generation: 1,
                window_id: "window-a".to_owned(),
            }],
        })
        .unwrap();
    let zoom = store
        .commit_role_zoom(
            seeded.revision,
            "tab-a",
            "window-a",
            "role-tab-a",
            Some(135.0),
        )
        .unwrap();
    assert_eq!(zoom.status, LiveTopologyCommitStatus::Applied);

    let mut moved = topology_role_slot("tab-a");
    moved.rect.x = 0.25;
    moved.rect.width = 0.75;
    moved.browser_zoom_percent = Some(135.0);
    let layout = store
        .commit_tab_role_slots(zoom.revision, "tab-a", "window-a", vec![moved.clone()])
        .unwrap();
    assert_eq!(layout.status, LiveTopologyCommitStatus::Applied);
    let stale = store
        .commit_role_zoom(
            zoom.revision,
            "tab-a",
            "window-a",
            "role-tab-a",
            Some(80.0),
        )
        .unwrap();
    assert_eq!(stale.status, LiveTopologyCommitStatus::Superseded);
    let snapshot = store.kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(snapshot.revision, layout.revision);
    assert_eq!(snapshot.tabs[0].role_slots, [moved]);
}

#[test]
fn live_topology_commit_is_atomic_and_primary_destination_owns_duplicates() {
    let store = LiveWindowTabStore::default();
    let receipt = store
        .commit(LiveTopologyCommitInput {
            commit_id: "commit-cross-window".to_owned(),
            source: "command",
            primary_window_id: "window-b".to_owned(),
            windows: vec![
                LiveWindowTopologyCommit {
                    active_tab_id: Some("tab-a".to_owned()),
                    hidden_tab_ids: HashSet::new(),
                    tabs: vec![topology_tab("tab-a"), topology_tab("tab-b")],
                    ui_sequence: 1,
                    window_generation: 4,
                    window_id: "window-a".to_owned(),
                },
                LiveWindowTopologyCommit {
                    active_tab_id: Some("missing".to_owned()),
                    hidden_tab_ids: HashSet::new(),
                    tabs: vec![topology_tab("tab-b"), topology_tab("tab-c")],
                    ui_sequence: 1,
                    window_generation: 8,
                    window_id: "window-b".to_owned(),
                },
            ],
        })
        .unwrap();

    assert_eq!(receipt.status, LiveTopologyCommitStatus::Applied);
    assert!(receipt.membership_changed);
    assert_eq!(receipt.window_ids, ["window-a", "window-b"]);
    let windows = store.kernel.snapshot().unwrap().windows;
    let window_a = &windows["window-a"];
    let window_b = &windows["window-b"];
    assert_eq!(window_a.all_tab_ids(), ["tab-a"]);
    assert_eq!(window_b.all_tab_ids(), ["tab-b", "tab-c"]);
    assert_eq!(window_b.selected_tab_id.as_deref(), Some("tab-b"));
    assert_eq!(window_a.revision, window_b.revision);
    assert_eq!(window_a.revision, receipt.revision);
}

#[test]
fn dormant_hydration_first_commit_contains_saved_tabs_and_appended_launch() {
    let store = LiveWindowTabStore::default();
    let mut appended = topology_tab("provisional-test");
    appended.persistable = false;
    appended.source_id = "source-test".to_owned();
    let receipt = store
        .commit(LiveTopologyCommitInput {
            commit_id: "saved-window-hydration-with-launch".to_owned(),
            source: "restore",
            primary_window_id: "window-1".to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: Some(appended.id.clone()),
                hidden_tab_ids: HashSet::new(),
                tabs: vec![topology_tab("test4"), topology_tab("test5"), appended],
                ui_sequence: 1,
                window_generation: 2,
                window_id: "window-1".to_owned(),
            }],
        })
        .unwrap();

    assert_eq!(receipt.status, LiveTopologyCommitStatus::Applied);
    let window = store.kernel.snapshot_window("window-1").unwrap().unwrap();
    assert_eq!(
        window.all_tab_ids(),
        ["test4", "test5", "provisional-test"]
    );
    assert_eq!(
        window.selected_tab_id.as_deref(),
        Some("provisional-test")
    );
}

#[test]
fn selection_order_and_metadata_commits_do_not_request_membership_rebinding() {
    let store = LiveWindowTabStore::default();
    let commit = |sequence, active: &str, tabs: Vec<LiveTabRecord>| LiveTopologyCommitInput {
        commit_id: format!("commit-{sequence}"),
        source: "command",
        primary_window_id: "window-a".to_owned(),
        windows: vec![LiveWindowTopologyCommit {
            active_tab_id: Some(active.to_owned()),
            hidden_tab_ids: HashSet::new(),
            tabs,
            ui_sequence: sequence,
            window_generation: 3,
            window_id: "window-a".to_owned(),
        }],
    };
    let initial = store
        .commit(commit(
            1,
            "tab-a",
            vec![topology_tab("tab-a"), topology_tab("tab-b")],
        ))
        .unwrap();
    assert!(initial.membership_changed);

    let mut renamed = topology_tab("tab-a");
    renamed.title = "renamed".to_owned();
    let presentation_only = store
        .commit(commit(
            2,
            "tab-b",
            vec![topology_tab("tab-b"), renamed],
        ))
        .unwrap();

    assert_eq!(presentation_only.status, LiveTopologyCommitStatus::Applied);
    assert!(!presentation_only.membership_changed);
}

#[test]
fn stale_live_topology_commit_is_superseded_without_mutating_memory() {
    let store = LiveWindowTabStore::default();
    let commit = |sequence, tabs: Vec<LiveTabRecord>| LiveTopologyCommitInput {
        commit_id: format!("commit-{sequence}"),
        source: "command",
        primary_window_id: "window-a".to_owned(),
        windows: vec![LiveWindowTopologyCommit {
            active_tab_id: tabs.first().map(|tab| tab.id.clone()),
            hidden_tab_ids: HashSet::new(),
            tabs,
            ui_sequence: sequence,
            window_generation: 3,
            window_id: "window-a".to_owned(),
        }],
    };
    let applied = store
        .commit(commit(7, vec![topology_tab("tab-a"), topology_tab("tab-b")]))
        .unwrap();
    let stale = store
        .commit(commit(6, vec![topology_tab("tab-b")]))
        .unwrap();

    assert_eq!(stale.status, LiveTopologyCommitStatus::Superseded);
    assert_eq!(stale.revision, applied.revision);
    let windows = store.kernel.snapshot().unwrap().windows;
    let window = &windows["window-a"];
    assert_eq!(window.all_tab_ids(), ["tab-a", "tab-b"]);
    assert_eq!(window.ui_sequence, 7);
}

#[test]
fn stale_live_placement_is_superseded_without_rewriting_the_latest_geometry() {
    let store = LiveWindowTabStore::default();
    let placement = |x| GameWindowPlacementRecord {
        normal_bounds: StatePixelBoundsRecord {
            x,
            y: 20,
            width: 960,
            height: 640,
        },
        saved_work_area: StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        },
        presentation: "normal".to_owned(),
    };
    let commit = |sequence, x| LiveWindowPlacementCommitInput {
        placement: placement(x),
        target_display: DisplayTargetRecord {
            id: 1,
            fingerprint: None,
        },
        ui_sequence: sequence,
        window_generation: 3,
        window_id: "window-a".to_owned(),
    };

    let latest = store.commit_placement(commit(8, 80)).unwrap();
    let stale = store.commit_placement(commit(7, 10)).unwrap();

    assert_eq!(latest.status, LiveTopologyCommitStatus::Applied);
    assert_eq!(stale.status, LiveTopologyCommitStatus::Superseded);
    assert_eq!(stale.revision, latest.revision);
    let window = store.kernel.snapshot_window("window-a").unwrap().unwrap();
    assert_eq!(
        window
            .placement
            .as_ref()
            .unwrap()
            .normal_bounds
            .x,
        80
    );
}

#[test]
fn native_projection_updates_cannot_change_live_topology() {
    let registry = PresentationRegistry::default();
    registry
        .commit_live_topology(LiveTopologyCommitInput {
            commit_id: "commit-projection-isolation".to_owned(),
            source: "command",
            primary_window_id: "window-a".to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: Some("tab-a".to_owned()),
                hidden_tab_ids: HashSet::new(),
                tabs: vec![topology_tab("tab-a"), topology_tab("tab-b")],
                ui_sequence: 1,
                window_generation: 1,
                window_id: "window-a".to_owned(),
            }],
        })
        .unwrap();
    let before = {
        let live = registry.live.kernel.snapshot_window("window-a").unwrap().unwrap();
        (live.revision, live.all_tab_ids(), live.selected_tab_id.clone())
    };
    {
        let projection = registry.projection_coordinator("window-a").unwrap();
        let mut projection = projection.lock().unwrap();
        projection.applied_revision = 999;
        projection.applied_tab_id = Some("tab-b".to_owned());
        projection.host_visibility = false;
    }
    let after = {
        let live = registry.live.kernel.snapshot_window("window-a").unwrap().unwrap();
        (live.revision, live.all_tab_ids(), live.selected_tab_id.clone())
    };

    assert_eq!(after, before);
}

#[test]
fn busy_native_projection_never_blocks_or_rolls_back_a_live_commit() {
    let registry = PresentationRegistry::default();
    let projection = registry.projection_coordinator("window-a").unwrap();
    let projection_guard = projection.lock().unwrap();

    let receipt = registry
        .commit_live_topology(LiveTopologyCommitInput {
            commit_id: "commit-while-projection-busy".to_owned(),
            source: "appKit",
            primary_window_id: "window-a".to_owned(),
            windows: vec![LiveWindowTopologyCommit {
                active_tab_id: Some("tab-a".to_owned()),
                hidden_tab_ids: HashSet::new(),
                tabs: vec![topology_tab("tab-a")],
                ui_sequence: 1,
                window_generation: 1,
                window_id: "window-a".to_owned(),
            }],
        })
        .unwrap();

    assert_eq!(receipt.status, LiveTopologyCommitStatus::Applied);
    assert_eq!(
        registry.tab_window("tab-a").unwrap().as_deref(),
        Some("window-a")
    );
    assert!(registry.projection_membership_needs_follow());
    drop(projection_guard);
    registry.follow_live_projection_membership().unwrap();
    assert!(!registry.projection_membership_needs_follow());
}

#[test]
fn missing_live_window_is_seeded_without_holding_its_mutex_through_commit() {
    let registry = Arc::new(PresentationRegistry::default());

    let (completed, completion) = mpsc::channel();
    let worker_registry = Arc::clone(&registry);
    let worker = thread::spawn(move || {
        let result = (|| {
            let mut next = worker_registry.snapshot_live_window("window-a")?;
            next.insert_tab(topology_tab("provisional-tab"), 0, true);
            worker_registry.commit_live_window_record("command", "window-a", &next)
        })();
        completed.send(result).unwrap();
    });

    let receipt = completion
        .recv_timeout(Duration::from_millis(250))
        .expect("snapshot followed by commit must not self-deadlock")
        .unwrap();
    worker.join().unwrap();
    assert_eq!(receipt.status, LiveTopologyCommitStatus::Applied);
    assert_eq!(
        registry
            .snapshot_live_window("window-a")
            .unwrap()
            .all_tab_ids(),
        ["provisional-tab"]
    );
}

#[test]
fn reorder_known_tabs_uses_stable_keys_for_memory_and_persistence_snapshots() {
    let mut live = LiveWindowRecord {
        tabs: vec![
            topology_tab("tab-a"),
            topology_tab("tab-b"),
            topology_tab("tab-c"),
            topology_tab("tab-d"),
        ],
        ..LiveWindowRecord::default()
    };

    live.reorder_known_tabs(&[
        "tab-c".to_owned(),
        "tab-a".to_owned(),
        "tab-d".to_owned(),
        "tab-b".to_owned(),
    ]);

    assert_eq!(
        live.all_tab_ids(),
        ["tab-c", "tab-a", "tab-d", "tab-b"]
    );
}
