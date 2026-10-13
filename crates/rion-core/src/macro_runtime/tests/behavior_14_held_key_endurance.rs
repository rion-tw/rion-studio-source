/// Opt-in wall-clock evidence for the real Core scheduler. Browser acknowledgements
/// are controlled here; Chromium consumer delivery has a separate native probe.
#[test]
#[ignore = "Long-running Core held-key endurance; set RION_CORE_HOLD_SOAK_MS and run explicitly"]
fn held_key_endurance_keeps_one_owner_until_acknowledged_stop() {
    let duration_ms = std::env::var("RION_CORE_HOLD_SOAK_MS")
        .map(|value| value.parse::<u64>().expect("integer soak duration"))
        .unwrap_or(3_600_000);
    assert!((1..=43_200_000).contains(&duration_ms));
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    start_and_ack_focus(&runtime, &receiver, request(vec![MacroStepDefinition::Key {
        id: "endurance-held".to_owned(), code: "Digit6".to_owned(), modifiers: None,
        action: Some("hold_until_stop".to_owned()), label: None, duration_ms: None,
    }]));
    let held = next_browser_actions(&receiver);
    assert_eq!(held.len(), 1);
    let owner_id = match &held[0].action {
        BrowserAction::Key { owner_id, phase, code, .. }
            if phase == "hold" && code.as_deref() == Some("Digit6") => owner_id.clone(),
        action => panic!("unexpected initial action: {action:?}"),
    };
    runtime.dispatch_results(success_results(held)).unwrap();
    // Observe the scheduler finishing the hold step before requesting continuity.
    'ready: loop {
        for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
            if let CoreEvent::MacroStatuses { statuses, .. } = event
                && statuses.iter().any(|status| status.iteration == Some(1)) {
                break 'ready;
            }
        }
    }
    let started = Instant::now();
    let duration = Duration::from_millis(duration_ms);
    let mut revision = 0_u64;
    let mut checkpoint = Instant::now();
    while started.elapsed() < duration {
        revision += 1;
        let operation_id = format!("endurance-continuity-{revision}");
        let reasserting = {
            let runtime = runtime.clone();
            thread::spawn(move || runtime.reassert_held_keys_after_context_loss(HeldKeyContinuityDispatch {
                operation_id: &operation_id, role_id: "r1", surface_generation: 1,
                document_instance_id: "endurance-document", loss_reason: "blur", loss_revision: revision,
            }))
        };
        let actions = next_browser_actions(&receiver);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].input_epoch, 0);
        assert_eq!(actions[0].surface_generation, Some(1));
        assert_eq!(actions[0].document_instance_id.as_deref(), Some("endurance-document"));
        assert!(matches!(actions[0].action, BrowserAction::ReassertHeldKeys));
        runtime.dispatch_results(success_results(actions)).unwrap();
        let receipt = reasserting.join().unwrap().unwrap();
        assert_eq!(receipt.status, "reasserted");
        assert_eq!(receipt.reasserted_key_count, 1);
        assert_eq!(runtime.statuses().unwrap().len(), 1);
        let inner = runtime.shared.inner.lock().unwrap();
        assert_eq!(inner.held_keys.len(), 1);
        assert_eq!(inner.held_keys.get(&owner_id).unwrap().code, "Digit6");
        drop(inner);
        if checkpoint.elapsed() >= Duration::from_secs(60) {
            eprintln!("Core hold soak: elapsed_ms={} continuity_events={revision}", started.elapsed().as_millis());
            checkpoint = Instant::now();
        }
        // Test-owned pacing simulates independent context-loss events, never a
        // production watchdog or retry. Each event has already been acknowledged.
        thread::sleep(Duration::from_secs(1).min(duration.saturating_sub(started.elapsed())));
    }
    let stopping = {
        let runtime = runtime.clone();
        thread::spawn(move || runtime.stop_macro("m1"))
    };
    let release = next_browser_actions(&receiver);
    assert_eq!(release.len(), 1);
    assert!(matches!(&release[0].action, BrowserAction::Key {
        phase, owner_id: releasing_owner, code, ..
    } if phase == "release" && releasing_owner == &owner_id && code.as_deref() == Some("Digit6")));
    runtime.dispatch_results(success_results(release)).unwrap();
    stopping.join().unwrap().unwrap();
    assert!(runtime.statuses().unwrap().is_empty());
    assert!(runtime.shared.inner.lock().unwrap().held_keys.is_empty());
    let late = runtime.reassert_held_keys_after_context_loss(HeldKeyContinuityDispatch {
        operation_id: "endurance-after-stop", role_id: "r1", surface_generation: 1,
        document_instance_id: "endurance-document", loss_reason: "blur", loss_revision: revision + 1,
    }).unwrap();
    assert_eq!(late.status, "noHeldKeys");
    assert!(late.request_ids.is_empty());
    eprintln!("Core hold soak completed: elapsed_ms={} continuity_events={revision} final_owners=0", started.elapsed().as_millis());
}
