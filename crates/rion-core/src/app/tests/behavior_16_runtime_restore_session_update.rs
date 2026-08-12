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
