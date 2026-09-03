#[test]
fn runtime_restore_session_updates_serialize_read_modify_write() {
    let (_directory, core) = core();
    core.update_runtime_restore_session(|session| {
        session.restore_in_progress_window_ids = vec!["window-a".to_owned()];
    })
    .unwrap();

    let (first_entered_sender, first_entered_receiver) = std::sync::mpsc::channel();
    let (release_first_sender, release_first_receiver) = std::sync::mpsc::channel();
    let first_core = Arc::clone(&core);
    let first = thread::spawn(move || {
        first_core
            .update_runtime_restore_session(|session| {
                session.last_focused_window_id = Some("window-c".to_owned());
                first_entered_sender.send(()).unwrap();
                release_first_receiver.recv().unwrap();
            })
            .unwrap();
    });
    first_entered_receiver.recv().unwrap();

    let (second_started_sender, second_started_receiver) = std::sync::mpsc::channel();
    let second_core = Arc::clone(&core);
    let second = thread::spawn(move || {
        second_started_sender.send(()).unwrap();
        second_core
            .update_runtime_restore_session(|session| {
                session.restore_in_progress_window_ids.clear();
            })
            .unwrap();
    });
    second_started_receiver.recv().unwrap();
    release_first_sender.send(()).unwrap();

    first.join().unwrap();
    second.join().unwrap();
    let session = core.runtime_restore_session().unwrap();
    assert_eq!(
        session.last_focused_window_id.as_deref(),
        Some("window-c")
    );
    assert!(session.restore_in_progress_window_ids.is_empty());
    core.shutdown();
}

#[test]
fn fatal_cleanup_lane_orders_after_clean_replace_and_is_idempotent() {
    let (_directory, core) = core();
    let clean = crate::model::RuntimeRestoreSessionRecord {
        schema_version: 2,
        session_generation: 41,
        updated_at: "2026-09-01T00:00:00Z".to_owned(),
        clean_exit: true,
        last_focused_window_id: Some("window-b".to_owned()),
        restore_in_progress_window_ids: vec!["window-a".to_owned()],
        live_window_ids: Some(vec!["window-a".to_owned(), "window-b".to_owned()]),
        windows: Vec::new(),
    };
    core.replace_runtime_restore_session(clean).unwrap();

    core.invalidate_runtime_restore_session_clean_exit_internal()
        .unwrap();
    let invalidated = core
        .read_optional_scalar_state::<crate::model::RuntimeRestoreSessionRecord>(
            "runtimeRestoreSession",
        )
        .unwrap()
        .unwrap();
    assert!(!invalidated.clean_exit);
    assert_eq!(invalidated.session_generation, 42);
    assert_eq!(
        invalidated.last_focused_window_id.as_deref(),
        Some("window-b")
    );
    assert_eq!(
        invalidated.restore_in_progress_window_ids,
        vec!["window-a"]
    );
    assert_eq!(
        invalidated.live_window_ids,
        Some(vec!["window-a".to_owned(), "window-b".to_owned()])
    );
    let exact_invalidated = serde_json::to_value(&invalidated).unwrap();

    core.invalidate_runtime_restore_session_clean_exit_internal()
        .unwrap();
    let repeated = core
        .read_optional_scalar_state::<crate::model::RuntimeRestoreSessionRecord>(
            "runtimeRestoreSession",
        )
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_value(repeated).unwrap(), exact_invalidated);
    core.shutdown();
}

#[test]
fn fatal_cleanup_submission_cannot_overtake_a_prior_clean_replace_waiting_for_state_authority() {
    let (_directory, core) = core();
    let clean = crate::model::RuntimeRestoreSessionRecord {
        schema_version: 2,
        session_generation: 70,
        updated_at: "2026-09-01T00:00:00Z".to_owned(),
        clean_exit: true,
        last_focused_window_id: Some("window-b".to_owned()),
        restore_in_progress_window_ids: vec!["window-a".to_owned()],
        live_window_ids: Some(vec!["window-a".to_owned(), "window-b".to_owned()]),
        windows: Vec::new(),
    };
    let state_authority = core.state_mutation_guard().unwrap();
    let (submitted_sender, submitted_receiver) = std::sync::mpsc::channel();
    core.runtime_restore_session_mutations
        .set_submission_hook(Some(Arc::new(move |ticket| {
            submitted_sender.send(ticket).unwrap();
        })));

    let clean_core = Arc::clone(&core);
    let clean_replace = thread::spawn(move || {
        clean_core.replace_runtime_restore_session(clean).unwrap();
    });
    assert_eq!(submitted_receiver.recv().unwrap(), 0);

    let fatal_core = Arc::clone(&core);
    let fatal_invalidation = thread::spawn(move || {
        fatal_core
            .invalidate_runtime_restore_session_clean_exit_internal()
            .unwrap();
    });
    assert_eq!(submitted_receiver.recv().unwrap(), 1);
    drop(state_authority);

    clean_replace.join().unwrap();
    fatal_invalidation.join().unwrap();
    core.runtime_restore_session_mutations
        .set_submission_hook(None);
    let session = core.runtime_restore_session().unwrap();
    assert!(!session.clean_exit);
    assert_eq!(session.session_generation, 71);
    assert_eq!(
        session.live_window_ids,
        Some(vec!["window-a".to_owned(), "window-b".to_owned()])
    );
    core.shutdown();
}
