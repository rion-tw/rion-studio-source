#[test]
fn redirect_ignores_old_drain_and_old_page_finished_events() {
    let mut tickets = HashMap::new();
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        1,
        Some("https://game.test/start"),
    );
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        2,
        Some("https://game.test/redirected"),
    );

    mark_navigation_input_drained(&mut tickets, "role-1", 1);
    assert!(mark_navigation_page_finished(
        &mut tickets,
        "role-main",
        "https://game.test/start"
    )
    .is_none());
    assert!(!navigation_input_is_ready(&tickets, "role-1", 2));

    mark_navigation_input_drained(&mut tickets, "role-1", 2);
    assert!(mark_navigation_page_finished(
        &mut tickets,
        "role-main",
        "https://game.test/redirected"
    )
    .is_some());
    assert!(navigation_input_is_ready(&tickets, "role-1", 2));
}

#[test]
fn main_and_popup_navigation_tickets_cannot_resume_each_other_early() {
    let mut tickets = HashMap::new();
    update_navigation_input_fences(
        &mut tickets,
        "role-main",
        "role-1",
        4,
        Some("https://game.test/main"),
    );
    update_navigation_input_fences(
        &mut tickets,
        "role-popup",
        "role-1",
        5,
        Some("https://game.test/popup"),
    );
    mark_navigation_input_drained(&mut tickets, "role-1", 5);

    mark_navigation_page_finished(
        &mut tickets,
        "role-popup",
        "https://game.test/popup",
    );
    assert!(!navigation_input_is_ready(&tickets, "role-1", 5));

    mark_navigation_page_finished(&mut tickets, "role-main", "https://game.test/main");
    assert!(navigation_input_is_ready(&tickets, "role-1", 5));
}
