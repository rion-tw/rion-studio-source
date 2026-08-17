fn test_role_input_fence(input_epoch: u64, surface_generation: u64) -> RoleInputFence {
    RoleInputFence {
        input_epoch,
        navigation_operation: None,
        reason: "navigation".to_owned(),
        started_at: Instant::now(),
        drained: false,
        surface_generation,
        recovery_scheduled: false,
        macro_recovery_id: None,
        pending_macro_restart_count: 0,
        resuming: false,
    }
}

#[test]
fn teardown_navigation_never_installs_a_new_input_fence_for_a_closing_role() {
    assert!(navigation_requires_input_fence(false, false));
    assert!(!navigation_requires_input_fence(true, false));
    assert!(!navigation_requires_input_fence(false, true));
    assert!(!navigation_requires_input_fence(true, true));
}

#[test]
fn exact_native_release_neutralizes_the_input_lane_without_reusing_its_epoch() {
    let lane = RoleInputDispatchLane::default();
    lane.epoch.store(9, Ordering::Release);
    lane.surface_generation.store(4, Ordering::Release);
    lane.quarantined.store(true, Ordering::Release);
    lane.normal_enabled.store(false, Ordering::Release);

    retire_role_input_lane(&lane);

    assert_eq!(lane.epoch.load(Ordering::Acquire), 9);
    assert_eq!(lane.surface_generation.load(Ordering::Acquire), 0);
    assert!(!lane.quarantined.load(Ordering::Acquire));
    assert!(lane.normal_enabled.load(Ordering::Acquire));
}

#[test]
fn stale_epoch_cannot_finish_or_resume_the_latest_role_fence() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    fences.insert("role-1".to_owned(), test_role_input_fence(2, 7));
    update_main_frame_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        1,
        7,
        Some("old-document".to_owned()),
    );
    update_main_frame_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        2,
        7,
        Some("old-document".to_owned()),
    );

    assert!(!main_frame_navigation_input_is_ready(
        &fences, &tickets, "role-1", 1
    ));
    fences.get_mut("role-1").unwrap().drained = true;
    assert!(
        mark_main_frame_navigation_page_finished(&mut tickets, "role-main", "https").is_some()
    );
    assert!(main_frame_navigation_input_is_ready(
        &fences, &tickets, "role-1", 2
    ));
}

#[test]
fn redirects_finish_the_current_ticket_without_matching_the_requested_url() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    let mut fence = test_role_input_fence(3, 8);
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);
    update_main_frame_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        3,
        8,
        Some("before-redirect".to_owned()),
    );

    assert!(
        mark_main_frame_navigation_page_finished(&mut tickets, "role-main", "https").is_some()
    );
    assert!(main_frame_navigation_input_is_ready(
        &fences, &tickets, "role-1", 3
    ));
}

#[test]
fn completed_main_frame_cannot_be_failed_by_a_late_deadline() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    fences.insert("role-1".to_owned(), test_role_input_fence(4, 8));
    update_main_frame_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        4,
        8,
        Some("old-document".to_owned()),
    );

    assert!(main_frame_navigation_deadline_is_current(
        &fences,
        &tickets,
        "role-main",
        "role-1",
        4,
        8
    ));
    mark_main_frame_navigation_page_finished(&mut tickets, "role-main", "https");

    assert!(!main_frame_navigation_deadline_is_current(
        &fences,
        &tickets,
        "role-main",
        "role-1",
        4,
        8
    ));
    assert!(!main_frame_navigation_deadline_is_current(
        &fences,
        &tickets,
        "role-main",
        "role-1",
        3,
        8
    ));
    assert!(!main_frame_navigation_deadline_is_current(
        &fences,
        &tickets,
        "role-main",
        "role-1",
        4,
        7
    ));
}

#[test]
fn popup_close_removes_only_its_ticket_and_does_not_release_a_pending_main_page() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    let mut fence = test_role_input_fence(5, 9);
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);
    update_main_frame_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        5,
        9,
        Some("main-old".to_owned()),
    );
    update_main_frame_navigation_input_fences(
        &mut tickets,
        "role-popup",
        "role-1",
        5,
        9,
        Some("popup-old".to_owned()),
    );

    tickets.remove("role-popup");
    assert!(!main_frame_navigation_input_is_ready(
        &fences, &tickets, "role-1", 5
    ));
    mark_main_frame_navigation_page_finished(&mut tickets, "role-main", "https");
    assert!(main_frame_navigation_input_is_ready(
        &fences, &tickets, "role-1", 5
    ));
}

#[test]
fn a_drained_popup_close_fence_with_no_page_tickets_is_ready() {
    let mut fences = HashMap::new();
    let mut fence = test_role_input_fence(6, 10);
    fence.reason = "popup-close".to_owned();
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);

    assert!(main_frame_navigation_input_is_ready(
        &fences,
        &HashMap::new(),
        "role-1",
        6
    ));
}

#[test]
fn deadline_claims_at_most_one_recovery_for_the_current_epoch() {
    let mut fences = HashMap::new();
    fences.insert("role-1".to_owned(), test_role_input_fence(7, 11));

    assert_eq!(
        claim_input_fence_recovery(&mut fences, "role-1", 7),
        Some(11)
    );
    assert_eq!(claim_input_fence_recovery(&mut fences, "role-1", 7), None);
    assert_eq!(claim_input_fence_recovery(&mut fences, "role-1", 6), None);
}

#[test]
fn ready_fence_claims_only_one_resume_attempt() {
    let mut fences = HashMap::new();
    let mut fence = test_role_input_fence(8, 12);
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);
    let tickets = HashMap::new();

    assert!(claim_navigation_input_resume(
        &mut fences,
        &tickets,
        "role-1",
        8
    ));
    assert!(!claim_navigation_input_resume(
        &mut fences,
        &tickets,
        "role-1",
        8
    ));
}
