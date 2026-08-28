fn presentation_input_lease(
    role_id: &str,
    lane: Arc<RoleInputDispatchLane>,
) -> NativePresentationInputLaneLease {
    NativePresentationInputLaneLease {
        lane,
        role_id: role_id.to_owned(),
    }
}

#[test]
fn presentation_input_lanes_are_sorted_and_deduplicated_by_role_id() {
    let lane_a = Arc::new(RoleInputDispatchLane::default());
    let lane_b = Arc::new(RoleInputDispatchLane::default());
    let leases = ordered_native_presentation_input_lane_leases(vec![
        presentation_input_lease("role-b", Arc::clone(&lane_b)),
        presentation_input_lease("role-a", Arc::clone(&lane_a)),
        presentation_input_lease("role-b", Arc::clone(&lane_b)),
    ]);

    assert_eq!(
        leases
            .iter()
            .map(|lease| lease.role_id.as_str())
            .collect::<Vec<_>>(),
        vec!["role-a", "role-b"]
    );
}

#[test]
fn presentation_waits_for_in_flight_input_then_releases_the_background_lane() {
    let lane = Arc::new(RoleInputDispatchLane::default());
    let input_terminal = Arc::new(AtomicBool::new(false));
    let surface_visible = Arc::new(AtomicBool::new(true));
    let (input_admitted, input_admitted_rx) = std::sync::mpsc::sync_channel(1);
    let (release_input, release_input_rx) = std::sync::mpsc::sync_channel(1);

    let input_lane = Arc::clone(&lane);
    let input_terminal_worker = Arc::clone(&input_terminal);
    let input = std::thread::spawn(move || {
        let _guard = input_lane.sequence.lock().unwrap();
        input_admitted.send(()).unwrap();
        release_input_rx.recv().unwrap();
        input_terminal_worker.store(true, Ordering::Release);
    });
    input_admitted_rx.recv().unwrap();

    let leases = ordered_native_presentation_input_lane_leases(vec![
        presentation_input_lease("role-a", Arc::clone(&lane)),
    ]);
    let input_terminal_presentation = Arc::clone(&input_terminal);
    let surface_visible_presentation = Arc::clone(&surface_visible);
    let (presentation_waiting, presentation_waiting_rx) = std::sync::mpsc::sync_channel(1);
    let presentation = std::thread::spawn(move || {
        presentation_waiting.send(()).unwrap();
        let _guards = lock_native_presentation_input_lanes(&leases).unwrap();
        assert!(input_terminal_presentation.load(Ordering::Acquire));
        surface_visible_presentation.store(false, Ordering::Release);
    });
    presentation_waiting_rx.recv().unwrap();

    assert!(surface_visible.load(Ordering::Acquire));
    release_input.send(()).unwrap();
    input.join().unwrap();
    presentation.join().unwrap();
    assert!(!surface_visible.load(Ordering::Acquire));

    let background_iteration = AtomicU64::new(0);
    let background_input = lane.sequence.lock().unwrap();
    background_iteration.fetch_add(1, Ordering::AcqRel);
    drop(background_input);
    assert!(input_terminal.load(Ordering::Acquire));
    assert_eq!(background_iteration.load(Ordering::Acquire), 1);
}

#[test]
fn input_failure_stage_keeps_the_first_exact_transaction_boundary() {
    let error = RuntimeError::new("BROWSER_DEBUGGER_FAILED", "dispatch failed")
        .with_input_transaction_stage(InputTransactionStage::Dispatch)
        .with_input_transaction_stage(InputTransactionStage::DomAcknowledgement);

    assert_eq!(
        error.input_transaction_stage,
        Some(InputTransactionStage::Dispatch)
    );
}

#[test]
fn held_key_continuity_classifies_only_obsolete_contexts_as_superseded() {
    for code in [
        "BROWSER_ACTION_STALE",
        "SYSTEM_RUNTIME_NOT_ACTIVE",
        "SYSTEM_RUNTIME_SHUTTING_DOWN",
        "SYSTEM_TRUSTED_INPUT_QUARANTINED",
        "TAURI_RUNTIME_ROLE_NOT_FOUND",
    ] {
        assert!(held_key_continuity_is_superseded(&RuntimeError::new(
            code,
            "obsolete"
        )));
    }
    assert!(!held_key_continuity_is_superseded(&RuntimeError::new(
        "BROWSER_DEBUGGER_FAILED",
        "dispatch failed"
    )));
}

#[test]
fn held_key_continuity_receipt_keeps_loss_and_presentation_revisions() {
    let receipt = held_key_continuity_receipt(
        "role-a",
        "hidden",
        7,
        19,
        Some((3, 5)),
        2,
        "reasserted",
    );
    let serialized = serde_json::to_value(receipt).unwrap();

    assert_eq!(serialized["roleId"], "role-a");
    assert_eq!(serialized["lossReason"], "hidden");
    assert_eq!(serialized["lossRevision"], 7);
    assert_eq!(serialized["presentationRevision"], 19);
    assert_eq!(serialized["inputEpoch"], 3);
    assert_eq!(serialized["surfaceGeneration"], 5);
    assert_eq!(serialized["reassertedKeyCount"], 2);
    assert_eq!(serialized["status"], "reasserted");
}

#[test]
fn blur_continuity_defers_to_a_native_tab_hide_but_not_workspace_focus_loss() {
    assert!(!held_key_continuity_should_reassert(
        "blur",
        Some(false),
        HeldKeyContinuitySource::NativeFocus,
    ));
    assert!(held_key_continuity_should_reassert(
        "blur",
        Some(true),
        HeldKeyContinuitySource::NativeFocus,
    ));
    assert!(held_key_continuity_should_reassert(
        "blur",
        None,
        HeldKeyContinuitySource::NativeFocus,
    ));
    assert!(!held_key_continuity_should_reassert(
        "blur",
        Some(true),
        HeldKeyContinuitySource::PageObservation,
    ));
    assert!(held_key_continuity_should_reassert(
        "hidden",
        Some(false),
        HeldKeyContinuitySource::PageObservation,
    ));
}
