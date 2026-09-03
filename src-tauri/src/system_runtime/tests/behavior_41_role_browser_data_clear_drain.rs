use rion_core::CoreEffectCancellationRecord;

#[test]
fn destructive_native_work_validates_cancellation_identity_before_cancelling_queued_clear() {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-clear", "operation-clear", "content-clear"),
        DestructiveNativeWorkQueue::Accepted
    );
    assert_eq!(
        registry.cancel(&CoreEffectCancellationRecord {
            effect_id: "effect-clear".to_owned(),
            operation_id: "wrong-operation".to_owned(),
            reason: rion_core::CoreEffectCancellationReason::DeadlineElapsed,
        }),
        destructive_native_work::DestructiveNativeWorkCancellation::OperationMismatch
    );
    assert!(matches!(
        registry.begin("effect-clear", "operation-clear", "content-clear"),
        DestructiveNativeWorkBegin::Started(_)
    ));

    let cancelled = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        cancelled.queue(
            "effect-cancelled",
            "operation-cancelled",
            "content-cancelled",
        ),
        DestructiveNativeWorkQueue::Accepted
    );
    assert_eq!(
        cancelled.cancel(&CoreEffectCancellationRecord {
            effect_id: "effect-cancelled".to_owned(),
            operation_id: "operation-cancelled".to_owned(),
            reason: rion_core::CoreEffectCancellationReason::DeadlineElapsed,
        }),
        destructive_native_work::DestructiveNativeWorkCancellation::Queued
    );
    assert!(matches!(
        cancelled.begin(
            "effect-cancelled",
            "operation-cancelled",
            "content-cancelled",
        ),
        DestructiveNativeWorkBegin::Cancelled
    ));
    assert_eq!(
        cancelled.queue(
            "effect-cancelled",
            "operation-cancelled",
            "content-cancelled",
        ),
        DestructiveNativeWorkQueue::Duplicate
    );
    assert_eq!(
        cancelled.queue(
            "effect-cancelled",
            "operation-cancelled",
            "different-content",
        ),
        DestructiveNativeWorkQueue::IdentityConflict
    );

    let cancelled_after_begin = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        cancelled_after_begin.queue(
            "effect-preparing",
            "operation-preparing",
            "content-preparing",
        ),
        DestructiveNativeWorkQueue::Accepted
    );
    let permit = match cancelled_after_begin.begin(
        "effect-preparing",
        "operation-preparing",
        "content-preparing",
    ) {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected preparing destructive work, got {outcome:?}"),
    };
    assert_eq!(
        cancelled_after_begin.cancel(&CoreEffectCancellationRecord {
            effect_id: "effect-preparing".to_owned(),
            operation_id: "operation-preparing".to_owned(),
            reason: rion_core::CoreEffectCancellationReason::DeadlineElapsed,
        }),
        destructive_native_work::DestructiveNativeWorkCancellation::Active
    );
    assert_eq!(
        cancelled_after_begin
            .admit_native_submission("effect-preparing", "operation-preparing"),
        DestructiveNativeSubmission::Cancelled
    );
    drop(permit);
    assert_eq!(
        cancelled_after_begin.queue(
            "effect-preparing",
            "operation-preparing",
            "content-preparing",
        ),
        DestructiveNativeWorkQueue::Duplicate
    );

    let cancelled_after_owner = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        cancelled_after_owner.queue(
            "effect-owner",
            "operation-owner",
            "content-owner",
        ),
        DestructiveNativeWorkQueue::Accepted
    );
    let mut permit = match cancelled_after_owner.begin(
        "effect-owner",
        "operation-owner",
        "content-owner",
    ) {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected native owner permit, got {outcome:?}"),
    };
    assert_eq!(
        cancelled_after_owner.admit_native_submission("effect-owner", "operation-owner"),
        DestructiveNativeSubmission::Admitted
    );
    assert_eq!(
        cancelled_after_owner.cancel(&CoreEffectCancellationRecord {
            effect_id: "effect-owner".to_owned(),
            operation_id: "operation-owner".to_owned(),
            reason: rion_core::CoreEffectCancellationReason::DeadlineElapsed,
        }),
        destructive_native_work::DestructiveNativeWorkCancellation::Active
    );
    assert_eq!(
        cancelled_after_owner
            .admit_destructive_mutation("effect-owner", "operation-owner"),
        DestructiveNativeSubmission::Cancelled
    );
    permit.complete_from_effect_result(&rion_core::CoreEffectResult {
        effect_id: "effect-owner".to_owned(),
        operation_id: "operation-owner".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: "SYSTEM_BROWSER_DATA_CLEAR_CANCELLED".to_owned(),
            message: "cancelled before destructive mutation".to_owned(),
        }),
    });
    drop(permit);
    assert!(
        cancelled_after_owner
            .begin_shutdown_and_wait(Instant::now(), || true)
            .native_work_drained
    );
}

#[test]
fn destructive_native_work_rejects_reused_identity_with_different_clear_content() {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-clear", "operation-clear", "content-a"),
        DestructiveNativeWorkQueue::Accepted
    );
    assert_eq!(
        registry.queue("effect-clear", "operation-clear", "content-b"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
    assert!(matches!(
        registry.begin("effect-clear", "operation-clear", "content-b"),
        DestructiveNativeWorkBegin::IdentityMismatch
    ));
    registry.tombstone_core_terminal("effect-clear", "operation-clear");
    assert_eq!(
        registry.queue("effect-clear", "operation-clear", "content-a"),
        DestructiveNativeWorkQueue::Duplicate
    );
    assert_eq!(
        registry.queue("effect-clear", "operation-clear", "content-b"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
}

#[test]
fn exact_destructive_terminal_replays_original_receipt_without_requeueing_native_work() {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-replay", "operation-replay", "content-replay"),
        DestructiveNativeWorkQueue::Accepted
    );
    let mut permit = match registry.begin(
        "effect-replay",
        "operation-replay",
        "content-replay",
    ) {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected destructive work permit, got {outcome:?}"),
    };
    assert_eq!(
        registry.admit_native_submission("effect-replay", "operation-replay"),
        DestructiveNativeSubmission::Admitted
    );
    assert_eq!(
        registry.admit_destructive_mutation("effect-replay", "operation-replay"),
        DestructiveNativeSubmission::Admitted
    );
    let terminal = rion_core::CoreEffectResult {
        effect_id: "effect-replay".to_owned(),
        operation_id: "operation-replay".to_owned(),
        ok: true,
        value_json: Some("{\"cleared\":true}".to_owned()),
        error: None,
    };
    permit.complete_from_effect_result(&terminal);
    drop(permit);

    assert_eq!(
        registry.queue("effect-replay", "operation-replay", "content-replay"),
        DestructiveNativeWorkQueue::Replay(terminal)
    );
    assert!(matches!(
        registry.begin(
            "effect-replay",
            "operation-replay",
            "content-replay"
        ),
        DestructiveNativeWorkBegin::Unknown
    ));
    assert_eq!(
        registry.queue("effect-replay", "operation-conflict", "content-replay"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
    assert_eq!(
        registry.queue("effect-replay", "operation-replay", "content-conflict"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
    assert!(
        registry
            .begin_shutdown_and_wait(Instant::now(), || true)
            .native_work_drained
    );
}

#[test]
fn queued_destructive_failure_is_retained_but_success_requires_native_submission() {
    let queued_failure = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        queued_failure.queue("effect-failed", "operation-failed", "content-failed"),
        DestructiveNativeWorkQueue::Accepted
    );
    let terminal_failure = rion_core::CoreEffectResult {
        effect_id: "effect-failed".to_owned(),
        operation_id: "operation-failed".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: "SYSTEM_RUNTIME_EFFECT_QUEUE_UNAVAILABLE".to_owned(),
            message: "the native queue rejected the clear before submission".to_owned(),
        }),
    };
    assert!(queued_failure.complete_queued_from_effect_result(&terminal_failure));
    assert_eq!(
        queued_failure.queue("effect-failed", "operation-failed", "content-failed"),
        DestructiveNativeWorkQueue::Replay(terminal_failure)
    );

    let phase_fence = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        phase_fence.queue("effect-phase", "operation-phase", "content-phase"),
        DestructiveNativeWorkQueue::Accepted
    );
    let success = rion_core::CoreEffectResult {
        effect_id: "effect-phase".to_owned(),
        operation_id: "operation-phase".to_owned(),
        ok: true,
        value_json: Some("{\"cleared\":true}".to_owned()),
        error: None,
    };
    assert!(!phase_fence.complete_queued_from_effect_result(&success));
    let mut permit = match phase_fence.begin(
        "effect-phase",
        "operation-phase",
        "content-phase",
    ) {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected phase-fenced destructive work, got {outcome:?}"),
    };
    permit.complete_from_effect_result(&success);
    assert!(matches!(
        phase_fence.begin("effect-phase", "operation-phase", "content-phase"),
        DestructiveNativeWorkBegin::AlreadyStarted
    ));
    assert_eq!(
        phase_fence.admit_native_submission("effect-phase", "operation-phase"),
        DestructiveNativeSubmission::Admitted
    );
    permit.complete_from_effect_result(&success);
    assert!(matches!(
        phase_fence.begin("effect-phase", "operation-phase", "content-phase"),
        DestructiveNativeWorkBegin::AlreadyStarted
    ));
    assert_eq!(
        phase_fence.admit_destructive_mutation("effect-phase", "operation-phase"),
        DestructiveNativeSubmission::Admitted
    );
    assert_eq!(
        phase_fence.cancel(&CoreEffectCancellationRecord {
            effect_id: "effect-phase".to_owned(),
            operation_id: "operation-phase".to_owned(),
            reason: rion_core::CoreEffectCancellationReason::DeadlineElapsed,
        }),
        destructive_native_work::DestructiveNativeWorkCancellation::Active
    );
    assert!(matches!(
        phase_fence.begin("effect-phase", "operation-phase", "content-phase"),
        DestructiveNativeWorkBegin::AlreadyStarted
    ));
    assert!(
        !phase_fence
            .begin_shutdown_and_wait(Instant::now(), || true)
            .native_work_drained
    );
    assert!(matches!(
        phase_fence.begin("effect-phase", "operation-phase", "content-phase"),
        DestructiveNativeWorkBegin::AlreadyStarted
    ));
    permit.complete_from_effect_result(&success);
    drop(permit);
    assert_eq!(
        phase_fence.queue("effect-phase", "operation-phase", "content-phase"),
        DestructiveNativeWorkQueue::Replay(success)
    );
}

#[test]
fn destructive_terminal_replay_ledger_is_bounded() {
    let registry = DestructiveNativeWorkRegistry::default();
    for index in 0..destructive_native_work::MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS {
        let effect_id = format!("effect-{index}");
        let operation_id = format!("operation-{index}");
        let content_fingerprint = format!("content-{index}");
        assert_eq!(
            registry.queue(&effect_id, &operation_id, &content_fingerprint),
            DestructiveNativeWorkQueue::Accepted
        );
        if index + 1 == destructive_native_work::MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS {
            continue;
        }
        let mut permit = match registry.begin(&effect_id, &operation_id, &content_fingerprint) {
            DestructiveNativeWorkBegin::Started(permit) => permit,
            outcome => panic!("expected destructive work permit, got {outcome:?}"),
        };
        assert_eq!(
            registry.admit_native_submission(&effect_id, &operation_id),
            DestructiveNativeSubmission::Admitted
        );
        assert_eq!(
            registry.admit_destructive_mutation(&effect_id, &operation_id),
            DestructiveNativeSubmission::Admitted
        );
        permit.complete_from_effect_result(&rion_core::CoreEffectResult {
            effect_id,
            operation_id,
            ok: true,
            value_json: None,
            error: None,
        });
    }

    assert_eq!(
        registry.retained_terminal_count(),
        destructive_native_work::MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS - 1
    );
    assert_eq!(
        registry.retained_identity_count(),
        destructive_native_work::MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS
    );
    assert!(matches!(
        registry.queue(
            "effect-4096",
            "operation-4096",
            "content-4096"
        ),
        DestructiveNativeWorkQueue::CapacityExceeded
    ));
    let last_retained_index =
        destructive_native_work::MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS - 1;
    let last_effect_id = format!("effect-{last_retained_index}");
    let last_operation_id = format!("operation-{last_retained_index}");
    let last_content_fingerprint = format!("content-{last_retained_index}");
    registry.tombstone_core_terminal(&last_effect_id, &last_operation_id);
    assert_eq!(
        registry.retained_identity_count(),
        destructive_native_work::MAX_RETAINED_DESTRUCTIVE_NATIVE_EFFECT_RECEIPTS
    );
    assert_eq!(
        registry.queue(
            &last_effect_id,
            &last_operation_id,
            &last_content_fingerprint,
        ),
        DestructiveNativeWorkQueue::Duplicate
    );
    assert_eq!(
        registry.queue(&last_effect_id, &last_operation_id, "content-conflict"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
    assert_eq!(
        registry.queue("effect-4096", "operation-4096", "content-4096"),
        DestructiveNativeWorkQueue::CapacityExceeded
    );
    assert_eq!(
        registry.queue("effect-unknown", "operation-unknown", "content-unknown"),
        DestructiveNativeWorkQueue::CapacityExceeded
    );
    assert_eq!(
        registry.queue("effect-0", "operation-0", "content-0"),
        DestructiveNativeWorkQueue::Replay(rion_core::CoreEffectResult {
            effect_id: "effect-0".to_owned(),
            operation_id: "operation-0".to_owned(),
            ok: true,
            value_json: None,
            error: None,
        })
    );
    assert_eq!(
        registry.queue("effect-0", "operation-0", "content-conflict"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
    assert!(matches!(
        registry.begin("effect-0", "operation-0", "content-0"),
        DestructiveNativeWorkBegin::Unknown
    ));
    assert!(matches!(
        registry.begin("effect-4096", "operation-4096", "content-4096"),
        DestructiveNativeWorkBegin::Unknown
    ));
}

#[test]
fn native_clear_submission_does_not_terminalize_before_its_authoritative_callback() {
    let (callback_capture_sender, callback_capture_receiver) = mpsc::sync_channel(1);
    let (result_sender, result_receiver) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let result = await_event_bound_native_terminal(|terminal_sender| {
            callback_capture_sender
                .send(terminal_sender)
                .expect("capture native completion callback");
            Ok(())
        });
        result_sender.send(result).expect("record native result");
    });

    let native_callback = callback_capture_receiver
        .recv()
        .expect("observe native submission");
    assert!(matches!(
        result_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    native_callback
        .send(Ok(()))
        .expect("deliver authoritative native completion");
    assert!(result_receiver.recv().expect("observe native terminal").is_ok());
    worker.join().expect("join native completion worker");
}

#[test]
fn utility_surface_release_waits_for_destroyed_then_post_event_loop_barrier() {
    let (destroyed_sender, destroyed_receiver) = mpsc::sync_channel(1);
    let (destroy_requested_sender, destroy_requested_receiver) = mpsc::sync_channel(1);
    let (barrier_capture_sender, barrier_capture_receiver) = mpsc::sync_channel(1);
    let (result_sender, result_receiver) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let result = await_utility_surface_release(
            destroyed_receiver,
            || {
                destroy_requested_sender
                    .send(())
                    .expect("record destroy request");
                Ok(())
            },
            |barrier_sender| {
                barrier_capture_sender
                    .send(barrier_sender)
                    .expect("capture post-destroy barrier");
                Ok(())
            },
        );
        result_sender.send(result).expect("record release result");
    });

    destroy_requested_receiver
        .recv()
        .expect("observe destroy submission");
    assert!(matches!(
        result_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    destroyed_sender
        .send(())
        .expect("deliver authoritative destroyed event");
    let release_barrier = barrier_capture_receiver
        .recv()
        .expect("observe post-destroy barrier submission");
    assert!(matches!(
        result_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_barrier
        .send(())
        .expect("deliver post-event-loop release barrier");
    assert!(result_receiver.recv().expect("observe exact release").is_ok());
    worker.join().expect("join utility release worker");
}

fn assert_unverified_native_terminal_retains_shutdown_fence(
    observe_unverified_terminal: impl FnOnce() -> RuntimeResult<()>,
) {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-unverified", "operation-unverified", "content-unverified"),
        DestructiveNativeWorkQueue::Accepted
    );
    let mut permit = match registry.begin(
        "effect-unverified",
        "operation-unverified",
        "content-unverified",
    ) {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected destructive work permit, got {outcome:?}"),
    };
    assert_eq!(
        registry.admit_native_submission("effect-unverified", "operation-unverified"),
        DestructiveNativeSubmission::Admitted
    );
    assert_eq!(
        registry.admit_destructive_mutation("effect-unverified", "operation-unverified"),
        DestructiveNativeSubmission::Admitted
    );

    let error = observe_unverified_terminal().unwrap_err();
    assert_eq!(
        error.code,
        destructive_native_work::BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED
    );
    permit.complete_from_effect_result(&rion_core::CoreEffectResult {
        effect_id: "effect-unverified".to_owned(),
        operation_id: "operation-unverified".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: error.code.to_owned(),
            message: error.message,
        }),
    });
    drop(permit);

    let drain = registry.begin_shutdown_and_wait(
        Instant::now() + Duration::from_millis(20),
        || true,
    );
    assert!(drain.starts_shutdown);
    assert!(!drain.native_work_drained);
}

#[test]
fn dropped_native_callback_sender_keeps_destructive_work_unverified() {
    assert_unverified_native_terminal_retains_shutdown_fence(|| {
        await_event_bound_native_terminal(|_terminal_sender| Ok(()))
    });
}

#[test]
fn lost_utility_destroyed_event_keeps_destructive_work_unverified() {
    assert_unverified_native_terminal_retains_shutdown_fence(|| {
        let (destroyed_sender, destroyed_receiver) = mpsc::sync_channel(1);
        drop(destroyed_sender);
        await_utility_surface_release(destroyed_receiver, || Ok(()), |_barrier_sender| Ok(()))
    });
}

#[test]
fn lost_utility_release_barrier_keeps_destructive_work_unverified() {
    assert_unverified_native_terminal_retains_shutdown_fence(|| {
        let (destroyed_sender, destroyed_receiver) = mpsc::sync_channel(1);
        destroyed_sender.send(()).unwrap();
        await_utility_surface_release(destroyed_receiver, || Ok(()), |_barrier_sender| Ok(()))
    });
}

#[test]
fn utility_window_build_without_release_evidence_keeps_native_owner_unverified() {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-owner", "operation-owner", "content-owner"),
        DestructiveNativeWorkQueue::Accepted
    );
    let mut permit = match registry.begin("effect-owner", "operation-owner", "content-owner") {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected destructive owner permit, got {outcome:?}"),
    };
    assert_eq!(
        registry.admit_native_submission("effect-owner", "operation-owner"),
        DestructiveNativeSubmission::Admitted
    );
    permit.complete_from_effect_result(&rion_core::CoreEffectResult {
        effect_id: "effect-owner".to_owned(),
        operation_id: "operation-owner".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: destructive_native_work::BROWSER_DATA_CLEAR_NATIVE_TERMINAL_UNVERIFIED
                .to_owned(),
            message: "utility build returned without an owner release event".to_owned(),
        }),
    });
    drop(permit);

    assert!(matches!(
        registry.begin("effect-owner", "operation-owner", "content-owner"),
        DestructiveNativeWorkBegin::AlreadyStarted
    ));
    assert!(matches!(
        registry.queue("effect-owner", "operation-owner", "content-owner"),
        DestructiveNativeWorkQueue::Duplicate
    ));
    assert!(
        !registry
            .begin_shutdown_and_wait(Instant::now(), || true)
            .native_work_drained
    );
}

#[test]
fn exact_native_failure_and_utility_release_terminalize_destructive_work() {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-exact", "operation-exact", "content-exact"),
        DestructiveNativeWorkQueue::Accepted
    );
    let mut permit = match registry.begin("effect-exact", "operation-exact", "content-exact") {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected destructive work permit, got {outcome:?}"),
    };
    assert_eq!(
        registry.admit_native_submission("effect-exact", "operation-exact"),
        DestructiveNativeSubmission::Admitted
    );
    assert_eq!(
        registry.admit_destructive_mutation("effect-exact", "operation-exact"),
        DestructiveNativeSubmission::Admitted
    );
    let clear_error = await_event_bound_native_terminal(|terminal_sender| {
        terminal_sender
            .send(Err(RuntimeError::new(
                "SYSTEM_BROWSER_DATA_CLEAR_NATIVE_FAILED",
                "native clear returned an exact failure",
            )))
            .unwrap();
        Ok(())
    })
    .unwrap_err();
    let (destroyed_sender, destroyed_receiver) = mpsc::sync_channel(1);
    destroyed_sender.send(()).unwrap();
    await_utility_surface_release(
        destroyed_receiver,
        || Ok(()),
        |barrier_sender| barrier_sender.send(()).map_err(|error| {
            RuntimeError::new("TEST_BARRIER_SEND_FAILED", error.to_string())
        }),
    )
    .unwrap();
    permit.complete_from_effect_result(&rion_core::CoreEffectResult {
        effect_id: "effect-exact".to_owned(),
        operation_id: "operation-exact".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: clear_error.code.to_owned(),
            message: clear_error.message,
        }),
    });
    drop(permit);

    let drain = registry.begin_shutdown_and_wait(Instant::now(), || true);
    assert!(drain.starts_shutdown);
    assert!(drain.native_work_drained);
}

#[test]
fn utility_child_created_before_parent_restore_failure_is_dropped_for_window_barrier_cleanup() {
    struct DropProbe(Arc<AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    let dropped = Arc::new(AtomicBool::new(false));
    let outcome = browser_data_utility_surface_creation_outcome(
        Ok(DropProbe(Arc::clone(&dropped))),
        Err(RuntimeError::new(
            "TEST_PARENT_RESTORE_FAILED",
            "test parent restore failed",
        )),
    );

    assert!(outcome.is_err());
    assert!(dropped.load(Ordering::Acquire));
}

#[test]
fn shutdown_admission_waits_for_active_destructive_native_cleanup_terminal() {
    let registry = Arc::new(DestructiveNativeWorkRegistry::default());
    assert_eq!(
        registry.queue("effect-active", "operation-active", "content-active"),
        DestructiveNativeWorkQueue::Accepted
    );
    let permit = match registry.begin("effect-active", "operation-active", "content-active") {
        DestructiveNativeWorkBegin::Started(permit) => permit,
        outcome => panic!("expected active destructive work, got {outcome:?}"),
    };
    assert_eq!(
        registry.cancel(&CoreEffectCancellationRecord {
            effect_id: "effect-active".to_owned(),
            operation_id: "operation-active".to_owned(),
            reason: rion_core::CoreEffectCancellationReason::DeadlineElapsed,
        }),
        destructive_native_work::DestructiveNativeWorkCancellation::Active
    );
    let (drain_started_sender, drain_started_receiver) = mpsc::channel();
    let (drain_complete_sender, drain_complete_receiver) = mpsc::channel();
    let drain_registry = Arc::clone(&registry);
    let drain = thread::spawn(move || {
        let outcome = drain_registry.begin_shutdown_and_wait(
            Instant::now() + Duration::from_secs(5),
            || {
            drain_started_sender.send(()).expect("record drain admission");
            true
            },
        );
        drain_complete_sender
            .send(outcome)
            .expect("record drain completion");
    });

    drain_started_receiver.recv().expect("observe drain admission");
    assert!(matches!(
        drain_complete_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert_eq!(
        registry.admit_native_submission("effect-active", "operation-active"),
        DestructiveNativeSubmission::Cancelled
    );
    drop(permit);
    let outcome = drain_complete_receiver.recv().expect("observe exact drain");
    assert!(outcome.starts_shutdown);
    assert!(outcome.native_work_drained);
    drain.join().expect("join destructive drain");
}

#[test]
fn shutdown_wins_the_begin_race_and_drains_queued_destructive_native_work() {
    let registry = Arc::new(DestructiveNativeWorkRegistry::default());
    assert_eq!(
        registry.queue("effect-queued", "operation-queued", "content-queued"),
        DestructiveNativeWorkQueue::Accepted
    );
    let drain_registry = Arc::clone(&registry);
    let (outcome_sender, outcome_receiver) = mpsc::sync_channel(1);
    let (drain_started_sender, drain_started_receiver) = mpsc::sync_channel(1);
    let drain = thread::spawn(move || {
        outcome_sender
            .send(drain_registry.begin_shutdown_and_wait(
                Instant::now() + Duration::from_secs(5),
                || {
                    drain_started_sender
                        .send(())
                        .expect("record queued drain admission");
                    true
                },
            ))
            .expect("record queued drain");
    });
    drain_started_receiver
        .recv()
        .expect("observe queued drain admission");
    assert_eq!(
        registry.queue("effect-late", "operation-late", "content-late"),
        DestructiveNativeWorkQueue::Draining
    );
    assert!(matches!(
        registry.begin("effect-queued", "operation-queued", "content-queued"),
        DestructiveNativeWorkBegin::Draining
    ));
    let shutdown_result = rion_core::CoreEffectResult {
        effect_id: "effect-queued".to_owned(),
        operation_id: "operation-queued".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: "SYSTEM_RUNTIME_SHUTTING_DOWN".to_owned(),
            message: "shutdown rejected queued browser-data clear work".to_owned(),
        }),
    };
    assert!(registry.complete_queued_from_effect_result(&shutdown_result));
    assert_eq!(
        registry.queue("effect-queued", "operation-queued", "content-queued"),
        DestructiveNativeWorkQueue::Replay(shutdown_result)
    );
    assert_eq!(
        registry.queue("effect-queued", "operation-queued", "different-content"),
        DestructiveNativeWorkQueue::IdentityConflict
    );
    let outcome = outcome_receiver.recv().expect("observe queued drain terminal");
    assert!(outcome.starts_shutdown);
    assert!(outcome.native_work_drained);
    drain.join().expect("join queued drain");
}

#[test]
fn destructive_native_drain_deadline_reports_unknown_without_terminalizing_work() {
    let registry = DestructiveNativeWorkRegistry::default();
    assert_eq!(
        registry.queue("effect-queued", "operation-queued", "content-queued"),
        DestructiveNativeWorkQueue::Accepted
    );
    let outcome = registry.begin_shutdown_and_wait(Instant::now(), || true);
    assert!(outcome.starts_shutdown);
    assert!(!outcome.native_work_drained);
    assert!(matches!(
        registry.begin("effect-queued", "operation-queued", "content-queued"),
        DestructiveNativeWorkBegin::Draining
    ));
    let shutdown_result = rion_core::CoreEffectResult {
        effect_id: "effect-queued".to_owned(),
        operation_id: "operation-queued".to_owned(),
        ok: false,
        value_json: None,
        error: Some(rion_core::CoreErrorPayload {
            code: "SYSTEM_RUNTIME_SHUTTING_DOWN".to_owned(),
            message: "shutdown rejected queued browser-data clear work".to_owned(),
        }),
    };
    assert!(registry.complete_queued_from_effect_result(&shutdown_result));
    assert_eq!(
        registry.queue("effect-queued", "operation-queued", "content-queued"),
        DestructiveNativeWorkQueue::Replay(shutdown_result)
    );
}
