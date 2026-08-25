#[test]
fn physical_focus_departure_releases_in_request_order_with_exact_modifier_state() {
    let effects = physical_key_cleanup_effects(
        &[
            "KeyA".to_owned(),
            "ShiftRight".to_owned(),
            "ShiftLeft".to_owned(),
        ],
        &HashSet::new(),
    );
    assert_eq!(
        effects
            .iter()
            .map(|effect| effect.code.as_str())
            .collect::<Vec<_>>(),
        vec!["KeyA", "ShiftRight", "ShiftLeft"]
    );
    assert_eq!(
        effects[0].active_codes,
        vec!["ShiftLeft".to_owned(), "ShiftRight".to_owned()]
    );
    assert_eq!(effects[1].active_codes, vec!["ShiftLeft".to_owned()]);
    assert!(effects[2].active_codes.is_empty());
}

#[test]
fn physical_focus_departure_skips_handoff_owned_modifier_without_losing_its_flags() {
    let effects = physical_key_cleanup_effects(
        &["KeyA".to_owned(), "ControlRight".to_owned()],
        &HashSet::from(["ControlRight".to_owned()]),
    );
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].code, "KeyA");
    assert_eq!(
        effects[0].active_codes,
        vec!["ControlRight".to_owned()]
    );
}

#[test]
fn managed_shortcut_press_registry_replays_only_matching_terminal_receipts() {
    let lease = ManagedShortcutPressLease {
        code: "Digit2".to_owned(),
        input_epoch: 4,
        macro_id: "macro-a".to_owned(),
        modifier_codes: vec!["ShiftLeft".to_owned()],
        press_id: "press-1".to_owned(),
        role_id: "role-a".to_owned(),
        surface_generation: 7,
        webview_label: "role-webview-a".to_owned(),
    };
    let mut registry = ManagedShortcutPressRegistry::default();
    registry.insert(lease.clone());
    let (active, completed) = registry.matching("press-1").unwrap();
    assert_eq!(active, &lease);
    assert!(!completed);
    assert!(active.matches(
        "role-webview-a",
        "role-a",
        "press-1",
        "macro-a",
        "Digit2",
        &["ShiftLeft".to_owned()]
    ));
    assert!(!active.matches(
        "role-webview-b",
        "role-a",
        "press-1",
        "macro-a",
        "Digit2",
        &["ShiftLeft".to_owned()]
    ));
    assert!(active.matches_input_context("role-webview-a", "role-a", 7, 4));
    assert!(active.matches_input_context("role-webview-a", "role-a", 7, 5));
    assert!(!active.matches_input_context("role-webview-a", "role-a", 8, 5));
    assert!(!active.matches_input_context("role-webview-a", "role-a", 7, 3));

    registry.complete("press-1");
    assert!(registry.active_for_role("role-a").is_empty());
    assert!(registry.matching("press-1").unwrap().1);
}

#[test]
fn managed_shortcut_fence_drain_selects_only_the_active_role() {
    let lease = ManagedShortcutPressLease {
        code: "Digit2".to_owned(),
        input_epoch: 4,
        macro_id: "macro-a".to_owned(),
        modifier_codes: Vec::new(),
        press_id: "press-a".to_owned(),
        role_id: "role-a".to_owned(),
        surface_generation: 7,
        webview_label: "role-webview-a".to_owned(),
    };
    let mut registry = ManagedShortcutPressRegistry::default();
    registry.insert(lease.clone());
    registry.insert(ManagedShortcutPressLease {
        press_id: "press-b".to_owned(),
        role_id: "role-b".to_owned(),
        webview_label: "role-webview-b".to_owned(),
        ..lease
    });

    let drain = registry.active_for_role("role-a");
    assert_eq!(drain.len(), 1);
    assert_eq!(drain[0].press_id, "press-a");
}

#[test]
fn shortcut_handoff_cleanup_is_claimed_once_from_active_or_terminal_state() {
    let handoff = RuntimeShortcutModifierHandoff {
        modifier_codes: vec!["ControlLeft".to_owned(), "ShiftRight".to_owned()],
        #[cfg(windows)]
        source_role_id: Some("role-a".to_owned()),
        source_tab_id: "tab-a".to_owned(),
        #[cfg(windows)]
        source_webview_label: Some("role-webview-a".to_owned()),
        started_at: Instant::now(),
        window_id: "window-a".to_owned(),
    };
    let mut completed = ShortcutModifierCleanupRegistry::default();
    completed.remember_completed(&handoff);
    assert_eq!(
        completed.take_completed_for_tab("tab-a").unwrap().source_tab_id,
        "tab-a"
    );
    assert!(completed.take_completed_for_tab("tab-a").is_none());

    let mut active = ShortcutModifierCleanupRegistry::default();
    active.claim_active(&handoff);
    active.remember_completed(&handoff);
    assert!(active.take_completed_for_tab("tab-a").is_none());
}

#[test]
fn physical_cleanup_receipts_are_idempotent_but_identity_bound() {
    let receipt = PhysicalKeyCleanupReceipt {
        codes: vec!["KeyA".to_owned(), "ShiftLeft".to_owned()],
        handoff_owned_codes: Vec::new(),
        release_id: "release-1".to_owned(),
        released_codes: vec!["KeyA".to_owned(), "ShiftLeft".to_owned()],
        role_id: "role-a".to_owned(),
        surface_generation: 9,
        webview_label: "role-webview-a".to_owned(),
    };
    let mut registry = PhysicalKeyCleanupRegistry::default();
    registry.complete(receipt.clone());
    assert_eq!(registry.matching("release-1"), Some(&receipt));
    assert_ne!(
        registry.matching("release-1").unwrap(),
        &PhysicalKeyCleanupReceipt {
            codes: vec!["KeyB".to_owned()],
            ..receipt
        }
    );
}
