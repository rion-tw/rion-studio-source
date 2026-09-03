#[test]
fn windows_held_key_continuity_replays_core_owned_keys_on_exact_surface_once() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    {
        let mut inner = runtime.shared.inner.lock().unwrap();
        inner.input_epochs.insert("r1".to_owned(), 7);
        inner.held_keys.insert(
            "owner-1".to_owned(),
            HeldKey {
                code: "Digit2".to_owned(),
                modifiers: vec!["shift".to_owned()],
                owner_id: "owner-1".to_owned(),
                role_id: "r1".to_owned(),
            },
        );
    }
    let replay_runtime = runtime.clone();
    let replay = thread::spawn(move || {
        replay_runtime.reassert_held_keys_after_context_loss(
            HeldKeyContinuityDispatch {
                operation_id: "continuity-1",
                role_id: "r1",
                surface_generation: 3,
                document_instance_id: "document-1",
                loss_reason: "hidden",
                loss_revision: 1,
            },
        )
    });
    let actions = next_browser_actions(&receiver);
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].role_id, "r1");
    assert_eq!(actions[0].input_epoch, 7);
    assert_eq!(actions[0].surface_generation, Some(3));
    assert_eq!(
        actions[0].document_instance_id.as_deref(),
        Some("document-1")
    );
    assert!(matches!(
        actions[0].action,
        BrowserAction::Key {
            ref phase,
            ref code,
            ref modifiers,
            ref owner_id,
            ..
        } if phase == "hold"
            && code.as_deref() == Some("Digit2")
            && modifiers == &["shift"]
            && owner_id == "owner-1"
    ));
    runtime.dispatch_results(success_results(actions)).unwrap();
    let receipt = replay.join().unwrap().unwrap();
    assert_eq!(receipt.status, "reasserted");
    assert_eq!(receipt.input_epoch, 7);
    assert_eq!(receipt.reasserted_key_count, 1);
    assert_eq!(receipt.request_ids.len(), 1);

    let duplicate = runtime
        .reassert_held_keys_after_context_loss(HeldKeyContinuityDispatch {
            operation_id: "continuity-duplicate",
            role_id: "r1",
            surface_generation: 3,
            document_instance_id: "document-1",
            loss_reason: "hidden",
            loss_revision: 1,
        })
        .unwrap();
    assert_eq!(duplicate.status, "superseded");
    assert!(duplicate.request_ids.is_empty());

    let replacement_runtime = runtime.clone();
    let replacement = thread::spawn(move || {
        replacement_runtime.reassert_held_keys_after_context_loss(
            HeldKeyContinuityDispatch {
                operation_id: "continuity-replacement",
                role_id: "r1",
                surface_generation: 4,
                document_instance_id: "document-replacement",
                loss_reason: "hidden",
                loss_revision: 1,
            },
        )
    });
    let replacement_actions = next_browser_actions(&receiver);
    assert_eq!(replacement_actions[0].surface_generation, Some(4));
    assert_eq!(
        replacement_actions[0].document_instance_id.as_deref(),
        Some("document-replacement")
    );
    runtime
        .dispatch_results(success_results(replacement_actions))
        .unwrap();
    assert_eq!(replacement.join().unwrap().unwrap().status, "reasserted");

    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .held_keys
        .clear();
    let empty = runtime
        .reassert_held_keys_after_context_loss(HeldKeyContinuityDispatch {
            operation_id: "continuity-2",
            role_id: "r1",
            surface_generation: 3,
            document_instance_id: "document-1",
            loss_reason: "hidden",
            loss_revision: 2,
        })
        .unwrap();
    assert_eq!(empty.status, "noHeldKeys");
    assert_eq!(empty.input_epoch, 7);
}

#[test]
fn windows_held_key_continuity_preserves_indeterminate_terminality() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    runtime.shared.inner.lock().unwrap().held_keys.insert(
        "owner-2".to_owned(),
        HeldKey {
            code: "KeyW".to_owned(),
            modifiers: Vec::new(),
            owner_id: "owner-2".to_owned(),
            role_id: "r1".to_owned(),
        },
    );
    let replay_runtime = runtime.clone();
    let replay = thread::spawn(move || {
        replay_runtime.reassert_held_keys_after_context_loss(
            HeldKeyContinuityDispatch {
                operation_id: "continuity-indeterminate",
                role_id: "r1",
                surface_generation: 4,
                document_instance_id: "document-2",
                loss_reason: "blur",
                loss_revision: 1,
            },
        )
    });
    let actions = next_browser_actions(&receiver);
    runtime
        .dispatch_results(vec![BrowserActionResult {
            request_id: actions[0].request_id.clone(),
            ok: false,
            value_json: None,
            error_code: Some("SYSTEM_TRUSTED_INPUT_INDETERMINATE".to_owned()),
            error_message: Some("trusted receipt missing".to_owned()),
        }])
        .unwrap();
    let receipt = replay.join().unwrap().unwrap();
    assert_eq!(receipt.status, "indeterminate");
    assert_eq!(
        receipt.error_code.as_deref(),
        Some("SYSTEM_TRUSTED_INPUT_INDETERMINATE")
    );
    assert_eq!(receipt.error_message.as_deref(), Some("trusted receipt missing"));
}

#[test]
fn windows_held_key_continuity_does_not_reassert_an_owner_removed_by_stop() {
    let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
    let runtime = MacroRuntime::new(Arc::new(move |batch| {
        let _ = events.send(batch);
    }));
    runtime.shared.inner.lock().unwrap().held_keys.insert(
        "owner-stopped".to_owned(),
        HeldKey {
            code: "Digit2".to_owned(),
            modifiers: Vec::new(),
            owner_id: "owner-stopped".to_owned(),
            role_id: "r1".to_owned(),
        },
    );
    let input_sequence = input_sequence_role_lock(&runtime.shared, "r1").unwrap();
    let input_sequence_guard = input_sequence.lock().unwrap();
    let replay_runtime = runtime.clone();
    let replay = thread::spawn(move || {
        replay_runtime.reassert_held_keys_after_context_loss(
            HeldKeyContinuityDispatch {
                operation_id: "continuity-after-stop",
                role_id: "r1",
                surface_generation: 5,
                document_instance_id: "document-stopped",
                loss_reason: "hidden",
                loss_revision: 1,
            },
        )
    });
    runtime
        .shared
        .inner
        .lock()
        .unwrap()
        .held_keys
        .remove("owner-stopped");
    drop(input_sequence_guard);

    let receipt = replay.join().unwrap().unwrap();
    assert_eq!(receipt.status, "noHeldKeys");
    assert!(receipt.request_ids.is_empty());
    assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
}
