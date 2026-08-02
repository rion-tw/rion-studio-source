fn test_role_input_fence(input_epoch: u64, surface_generation: u64) -> RoleInputFence {
    RoleInputFence {
        input_epoch,
        navigation_operation: None,
        reason: "navigation".to_owned(),
        started_at: Instant::now(),
        drained: false,
        surface_generation,
        recovery_scheduled: false,
        reconciling: false,
        resuming: false,
    }
}

#[test]
fn stale_epoch_cannot_finish_or_resume_the_latest_role_fence() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    fences.insert("role-1".to_owned(), test_role_input_fence(2, 7));
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        1,
        7,
        Some("old-document".to_owned()),
    );
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        2,
        7,
        Some("old-document".to_owned()),
    );

    assert!(!navigation_input_is_ready(&fences, &tickets, "role-1", 1));
    fences.get_mut("role-1").unwrap().drained = true;
    assert!(mark_navigation_page_finished(&mut tickets, "role-main", "https").is_some());
    assert!(navigation_input_is_ready(&fences, &tickets, "role-1", 2));
}

#[test]
fn redirects_finish_the_current_ticket_without_matching_the_requested_url() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    let mut fence = test_role_input_fence(3, 8);
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        3,
        8,
        Some("before-redirect".to_owned()),
    );

    assert!(mark_navigation_page_finished(&mut tickets, "role-main", "https").is_some());
    assert!(navigation_input_is_ready(&fences, &tickets, "role-1", 3));
}

#[test]
fn popup_close_removes_only_its_ticket_and_does_not_release_a_pending_main_page() {
    let mut fences = HashMap::new();
    let mut tickets = HashMap::new();
    let mut fence = test_role_input_fence(5, 9);
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        5,
        9,
        Some("main-old".to_owned()),
    );
    update_navigation_input_fences(
        &mut tickets,
        "role-popup",
        "role-1",
        5,
        9,
        Some("popup-old".to_owned()),
    );

    tickets.remove("role-popup");
    assert!(!navigation_input_is_ready(&fences, &tickets, "role-1", 5));
    mark_navigation_page_finished(&mut tickets, "role-main", "https");
    assert!(navigation_input_is_ready(&fences, &tickets, "role-1", 5));
}

#[test]
fn a_drained_popup_close_fence_with_no_page_tickets_is_ready() {
    let mut fences = HashMap::new();
    let mut fence = test_role_input_fence(6, 10);
    fence.reason = "popup-close".to_owned();
    fence.drained = true;
    fences.insert("role-1".to_owned(), fence);

    assert!(navigation_input_is_ready(
        &fences,
        &HashMap::new(),
        "role-1",
        6
    ));
}

#[test]
fn watchdog_requires_a_new_complete_http_document_instance() {
    let complete = DocumentInstanceReadback {
        document_id: Some("new-document".to_owned()),
        ready_state: "complete".to_owned(),
        protocol: "https:".to_owned(),
    };
    assert!(document_instance_proves_completed_navigation(
        &complete,
        Some("old-document")
    ));
    assert!(!document_instance_proves_completed_navigation(
        &complete,
        Some("new-document")
    ));
    assert!(!document_instance_proves_completed_navigation(&complete, None));

    let loading = DocumentInstanceReadback {
        ready_state: "loading".to_owned(),
        ..complete
    };
    assert!(!document_instance_proves_completed_navigation(
        &loading,
        Some("old-document")
    ));
}

#[test]
fn watchdog_claims_at_most_one_recovery_for_the_current_epoch() {
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
