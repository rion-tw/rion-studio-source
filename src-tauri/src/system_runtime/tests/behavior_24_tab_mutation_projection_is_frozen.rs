fn mutation_window(window_id: &str, generation: u64, tabs: &[&str]) -> RuntimeTabDragWindowSnapshot {
    RuntimeTabDragWindowSnapshot {
        active_tab_id: tabs.first().map(|tab_id| (*tab_id).to_owned()),
        generation,
        tab_ids: tabs.iter().map(|tab_id| (*tab_id).to_owned()).collect(),
        window_id: window_id.to_owned(),
    }
}

#[test]
fn tab_mutation_freezes_exact_reorder_and_move_projection() {
    let platform = "windows";
    let source = mutation_window("source", 7, &["tab-a", "tab-b", "tab-c"]);
    let target = mutation_window("target", 11, &["tab-x", "tab-y"]);

    let (reordered, active, index) = expected_tab_mutation_projection(
        "reorder",
        "tab-c",
        &source,
        None,
        Some("tab-b"),
    );
    assert_eq!(reordered, vec!["tab-a", "tab-c", "tab-b"], "{platform}");
    assert_eq!(active.as_deref(), Some("tab-a"), "{platform}");
    assert_eq!(index, Some(1), "{platform}");

    let (moved, active, index) = expected_tab_mutation_projection(
        "move",
        "tab-b",
        &source,
        Some(&target),
        Some("tab-y"),
    );
    assert_eq!(moved, vec!["tab-x", "tab-b", "tab-y"], "{platform}");
    assert_eq!(active.as_deref(), Some("tab-b"), "{platform}");
    assert_eq!(index, Some(1), "{platform}");
}

#[test]
fn hide_projection_removes_the_tab_and_uses_a_stable_fallback() {
    let platform = "macos";
    let source = mutation_window("source", 7, &["tab-a", "tab-b", "tab-c"]);
    let (order, active, index) =
        expected_tab_mutation_projection("hide", "tab-a", &source, None, None);
    assert_eq!(order, vec!["tab-b", "tab-c"], "{platform}");
    assert_eq!(active.as_deref(), Some("tab-b"), "{platform}");
    assert_eq!(index, None, "{platform}");
}

#[test]
fn stop_projection_removes_the_tab_and_uses_the_macos_successor_fallback() {
    for platform in ["macos", "windows"] {
        let mut source = mutation_window("source", 7, &["tab-a", "tab-b", "tab-c"]);
        source.active_tab_id = Some("tab-b".to_owned());
        let (order, active, index) =
            expected_tab_mutation_projection("stop", "tab-b", &source, None, None);
        assert_eq!(order, vec!["tab-a", "tab-c"], "{platform}");
        assert_eq!(active.as_deref(), Some("tab-c"), "{platform}");
        assert_eq!(index, None, "{platform}");
    }
}

#[test]
fn active_stop_is_joined_and_supersedes_later_topology_mutations() {
    for platform in ["macos", "windows"] {
        let joined = classify_active_tab_stop(Some("native-stop-1"), "stop");
        assert!(
            matches!(
                joined,
                Some(RuntimeTabMutationAcceptance::ExistingStop(operation_id))
                    if operation_id == "native-stop-1"
            ),
            "{platform}"
        );
        assert!(
            matches!(
                classify_active_tab_stop(Some("native-stop-1"), "move"),
                Some(RuntimeTabMutationAcceptance::Superseded)
            ),
            "{platform}"
        );
        assert!(
            classify_active_tab_stop(None, "hide").is_none(),
            "{platform}"
        );
    }
}

#[test]
fn per_tab_mutation_lane_rejects_capacity_without_evicting_accepted_work() {
    let platform = "windows";
    let lane = TabMutationLane::default();
    for _ in 0..TAB_MUTATION_LANE_CAPACITY {
        assert!(lane.try_enqueue(), "{platform}");
    }
    assert!(!lane.try_enqueue(), "{platform}");
    assert_eq!(
        lane.queued.load(Ordering::Acquire),
        TAB_MUTATION_LANE_CAPACITY,
        "{platform}"
    );
    lane.finish_queued();
    assert!(lane.try_enqueue(), "{platform}");
}
