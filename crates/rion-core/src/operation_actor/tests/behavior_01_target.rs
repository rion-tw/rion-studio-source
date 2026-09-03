use std::sync::mpsc;

use serde_json::json;

use super::*;

fn target() -> CoreEffectTarget {
    CoreEffectTarget {
        kind: crate::model::CoreEffectTargetKind::WebContents,
        handle_id: "role-1".to_owned(),
    }
}

fn effect(action: CoreEffectAction) -> OperationEffect {
    OperationEffect {
        target: target(),
        action,
        timeout: Duration::from_secs(1),
        compensate_on_rejected_result: true,
    }
}

fn actor() -> (OperationActor, mpsc::Receiver<Vec<CoreEffectRequest>>) {
    let (sender, receiver) = mpsc::channel();
    (
        OperationActor::new(Arc::new(move |effects| {
            sender.send(effects).expect("effect receiver");
        })),
        receiver,
    )
}

fn actor_with_cancellations() -> (
    OperationActor,
    mpsc::Receiver<Vec<CoreEffectRequest>>,
    mpsc::Receiver<Vec<CoreEffectCancellationRecord>>,
) {
    let (effect_sender, effect_receiver) = mpsc::channel();
    let (cancellation_sender, cancellation_receiver) = mpsc::channel();
    (
        OperationActor::new_with_cancellation_emitter(
            Arc::new(move |effects| {
                effect_sender.send(effects).expect("effect receiver");
            }),
            Arc::new(move |cancellations| {
                cancellation_sender
                    .send(cancellations)
                    .expect("cancellation receiver");
            }),
        ),
        effect_receiver,
        cancellation_receiver,
    )
}

fn success(request: &CoreEffectRequest) -> CoreEffectResult {
    CoreEffectResult {
        effect_id: request.effect_id.clone(),
        operation_id: request.operation_id.clone(),
        ok: true,
        value_json: Some(json!({ "loaded": true }).to_string()),
        error: None,
    }
}

#[test]
fn waits_for_effect_results_without_blocking_event_delivery() {
    let (actor, effects) = actor();
    let handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::OverlayOpenMacroPage {
                    role_id: "role-1".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let batch = effects.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(batch.len(), 1);
    let report = actor.dispatch_results(vec![success(&batch[0])]).unwrap();
    assert_eq!(report.accepted, vec![batch[0].effect_id.clone()]);
    let outcome = handle.outcome.blocking_recv().unwrap();
    assert!(outcome.error.is_none());
    assert_eq!(outcome.results.len(), 1);
}

#[test]
fn first_effect_dispatch_fence_resolves_only_after_the_emitter_returns() {
    let (emitted_sender, emitted_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let release_receiver = Arc::new(Mutex::new(release_receiver));
    let actor = OperationActor::new(Arc::new(move |effects| {
        emitted_sender
            .send(effects)
            .expect("emitted effect receiver");
        release_receiver
            .lock()
            .expect("emitter release lock")
            .recv()
            .expect("emitter release");
    }));
    let mut handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-1".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let request = emitted_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    let (waited_sender, waited_receiver) = mpsc::channel();
    let waiter = thread::spawn(move || {
        let result = handle.wait_for_first_effect_dispatch();
        waited_sender.send(()).expect("dispatch waiter receiver");
        (result, handle)
    });

    assert!(matches!(
        waited_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_sender.send(()).unwrap();
    waited_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    let (dispatch, handle) = waiter.join().unwrap();
    dispatch.unwrap();
    actor.dispatch_results(vec![success(&request)]).unwrap();
    assert!(handle.outcome.blocking_recv().unwrap().error.is_none());
}

#[test]
fn first_effect_dispatch_fence_preserves_caller_admission_order() {
    let (actor, effects) = actor();
    let mut first = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-1".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    first.wait_for_first_effect_dispatch().unwrap();
    let mut second = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-2".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    second.wait_for_first_effect_dispatch().unwrap();

    let first_request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    let second_request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    assert_eq!(first_request.operation_id, first.operation_id);
    assert_eq!(second_request.operation_id, second.operation_id);
    actor
        .dispatch_results(vec![success(&first_request), success(&second_request)])
        .unwrap();
    assert!(first.outcome.blocking_recv().unwrap().error.is_none());
    assert!(second.outcome.blocking_recv().unwrap().error.is_none());
}

#[test]
fn first_effect_dispatch_fence_reports_no_effect_and_pre_dispatch_failure() {
    let (sender, effects) = mpsc::channel();
    let actor = OperationActor::with_capacity(
        Arc::new(move |batch| sender.send(batch).expect("effect receiver")),
        1,
        2,
    );
    let mut first = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-1".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    first.wait_for_first_effect_dispatch().unwrap();
    let first_request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);

    let mut backpressured = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-2".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    assert_eq!(
        backpressured
            .wait_for_first_effect_dispatch()
            .unwrap_err()
            .code(),
        "CORE_EFFECT_BACKPRESSURE"
    );
    assert_eq!(
        backpressured
            .outcome
            .blocking_recv()
            .unwrap()
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("CORE_EFFECT_BACKPRESSURE")
    );
    assert!(matches!(effects.try_recv(), Err(mpsc::TryRecvError::Empty)));

    actor
        .dispatch_results(vec![success(&first_request)])
        .unwrap();
    assert!(first.outcome.blocking_recv().unwrap().error.is_none());

    let mut empty = actor.start(OperationPlan::default()).unwrap();
    assert_eq!(
        empty.wait_for_first_effect_dispatch().unwrap_err().code(),
        "CORE_OPERATION_NO_EFFECT_DISPATCHED"
    );
    assert!(empty.outcome.blocking_recv().unwrap().error.is_none());
}

#[test]
fn first_effect_dispatch_fence_never_strands_on_early_cancel_or_shutdown() {
    for (shutdown, expected_code) in [
        (false, "CORE_OPERATION_CANCELLED"),
        (true, "CORE_SHUTTING_DOWN"),
    ] {
        let (actor, effects) = actor();
        let operation_id = format!("pre-dispatch-{shutdown}");
        let cancelled = Arc::new(AtomicBool::new(!shutdown));
        if shutdown {
            actor.inner.state.lock().unwrap().shutting_down = true;
        }
        let (dispatch_sender, dispatch_receiver) = oneshot::channel();
        let outcome = run_operation(
            Arc::clone(&actor.inner),
            operation_id,
            None,
            cancelled,
            OperationPlan {
                steps: vec![OperationStep {
                    effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                        role_id: "role-1".to_owned(),
                    }),
                    compensation: None,
                }],
            },
            FirstEffectDispatchSignal {
                sender: Some(dispatch_sender),
            },
        );
        let dispatch_error = dispatch_receiver.blocking_recv().unwrap().unwrap_err();
        assert_eq!(dispatch_error.code, expected_code);
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some(expected_code)
        );
        assert!(matches!(effects.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }
}

#[test]
fn destroy_effects_are_event_bound_and_have_no_wire_deadline() {
    let (actor, effects) = actor();
    let handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: OperationEffect {
                    timeout: Duration::from_millis(1),
                    ..effect(CoreEffectAction::EmbeddedDestroyRole {
                        role_id: "role-1".to_owned(),
                    })
                },
                compensation: None,
            }],
        })
        .unwrap();
    let request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    assert_eq!(
        request.completion_policy,
        OperationCompletionPolicy::EventBound
    );
    assert_eq!(request.deadline_ms, None);
    thread::sleep(Duration::from_millis(10));
    assert!(
        actor
            .effect_is_pending(&request.effect_id, &request.operation_id)
            .unwrap()
    );
    actor.dispatch_results(vec![success(&request)]).unwrap();
    assert!(handle.outcome.blocking_recv().unwrap().error.is_none());
}

#[test]
fn cancelled_dispatched_effect_stays_pending_for_the_exact_continuation_result() {
    let (actor, effects, cancellations) = actor_with_cancellations();
    let mut handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedFocusRole {
                    role_id: "role-1".to_owned(),
                    zoom_factor: None,
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    handle.wait_for_first_effect_dispatch().unwrap();
    assert!(
        actor
            .effect_is_pending(&request.effect_id, &request.operation_id)
            .unwrap()
    );
    assert!(actor.cancel(&request.operation_id).unwrap());
    assert_eq!(
        cancellations.recv_timeout(Duration::from_secs(1)).unwrap(),
        vec![CoreEffectCancellationRecord {
            effect_id: request.effect_id.clone(),
            operation_id: request.operation_id.clone(),
            reason: CoreEffectCancellationReason::OperationCancelled,
        }]
    );
    assert!(
        actor
            .effect_is_pending(&request.effect_id, &request.operation_id)
            .unwrap()
    );
    let report = actor
        .dispatch_results(vec![failed_result(
            request.effect_id,
            request.operation_id,
            "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
            "native submission may have completed",
        )])
        .unwrap();
    assert_eq!(report.accepted.len(), 1);
    let outcome = handle.outcome.blocking_recv().unwrap();
    assert_eq!(
        outcome.error.as_ref().map(|error| error.code.as_str()),
        Some("CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE")
    );
}

#[test]
fn classifies_duplicate_unknown_late_and_operation_mismatch_results() {
    let (actor, effects, cancellations) = actor_with_cancellations();
    let handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: OperationEffect {
                    timeout: Duration::from_millis(20),
                    ..effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: None,
                    })
                },
                compensation: None,
            }],
        })
        .unwrap();
    let request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    let mismatch = CoreEffectResult {
        operation_id: "another-operation".to_owned(),
        ..success(&request)
    };
    let report = actor.dispatch_results(vec![mismatch]).unwrap();
    assert_eq!(report.operation_mismatch, vec![request.effect_id.clone()]);
    assert_eq!(
        cancellations.recv_timeout(Duration::from_secs(1)).unwrap(),
        vec![CoreEffectCancellationRecord {
            effect_id: request.effect_id.clone(),
            operation_id: request.operation_id.clone(),
            reason: CoreEffectCancellationReason::DeadlineElapsed,
        }]
    );
    let report = actor.dispatch_results(vec![success(&request)]).unwrap();
    assert_eq!(report.late, vec![request.effect_id.clone()]);
    let outcome = handle.outcome.blocking_recv().unwrap();
    assert_eq!(
        outcome.error.as_ref().map(|error| error.code.as_str()),
        Some("CORE_EFFECT_TIMEOUT")
    );
    let report = actor
        .dispatch_results(vec![
            success(&request),
            CoreEffectResult {
                effect_id: "missing-effect".to_owned(),
                operation_id: request.operation_id,
                ok: true,
                value_json: None,
                error: None,
            },
        ])
        .unwrap();
    assert_eq!(report.late, vec![request.effect_id]);
    assert_eq!(report.unknown, vec!["missing-effect"]);
}

#[test]
fn runs_compensations_in_reverse_after_a_failed_effect() {
    let (actor, effects) = actor();
    let handle = actor
        .start(OperationPlan {
            steps: vec![
                OperationStep {
                    effect: effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.2),
                    }),
                    compensation: Some(effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.0),
                    })),
                },
                OperationStep {
                    effect: effect(CoreEffectAction::OverlayOpenMacroPage {
                        role_id: "role-1".to_owned(),
                    }),
                    compensation: None,
                },
            ],
        })
        .unwrap();
    let first = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor.dispatch_results(vec![success(&first)]).unwrap();
    let second = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor
        .dispatch_results(vec![CoreEffectResult {
            effect_id: second.effect_id,
            operation_id: second.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "TEST_EFFECT_FAILED".to_owned(),
                message: "load failed".to_owned(),
            }),
        }])
        .unwrap();
    let compensation = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    assert!(matches!(
        compensation.action,
        CoreEffectAction::EmbeddedFocusRole {
            zoom_factor: Some(1.0),
            ..
        }
    ));
    actor
        .dispatch_results(vec![success(&compensation)])
        .unwrap();
    let outcome = handle.outcome.blocking_recv().unwrap();
    assert_eq!(
        outcome.error.as_ref().map(|error| error.code.as_str()),
        Some("TEST_EFFECT_FAILED")
    );
    assert_eq!(outcome.compensation_results.len(), 1);
    assert!(outcome.compensation_failures.is_empty());
}

#[test]
fn does_not_compensate_an_effect_that_never_committed() {
    let (actor, effects) = actor();
    let handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: OperationEffect {
                    compensate_on_rejected_result: false,
                    ..effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.2),
                    })
                },
                compensation: Some(effect(CoreEffectAction::EmbeddedFocusRole {
                    role_id: "role-1".to_owned(),
                    zoom_factor: Some(1.0),
                })),
            }],
        })
        .unwrap();
    let failed = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor
        .dispatch_results(vec![failed_result(
            failed.effect_id,
            failed.operation_id,
            "SYSTEM_ROLE_SETUP_TIMEOUT",
            "setup timed out",
        )])
        .unwrap();

    assert!(effects.recv_timeout(Duration::from_millis(25)).is_err());
    let outcome = handle.outcome.blocking_recv().unwrap();
    assert_eq!(
        outcome.error.as_ref().map(|error| error.code.as_str()),
        Some("SYSTEM_ROLE_SETUP_TIMEOUT")
    );
    assert!(outcome.compensation_results.is_empty());
    assert!(outcome.compensation_failures.is_empty());
}

#[test]
fn compensates_an_indeterminate_timeout_even_when_rejection_is_self_cleaning() {
    let (actor, effects) = actor();
    let handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: OperationEffect {
                    timeout: Duration::from_millis(10),
                    compensate_on_rejected_result: false,
                    ..effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.2),
                    })
                },
                compensation: Some(effect(CoreEffectAction::EmbeddedFocusRole {
                    role_id: "role-1".to_owned(),
                    zoom_factor: Some(1.0),
                })),
            }],
        })
        .unwrap();
    let _timed_out = effects.recv_timeout(Duration::from_secs(1)).unwrap();
    let compensation = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor
        .dispatch_results(vec![success(&compensation)])
        .unwrap();

    let outcome = handle.outcome.blocking_recv().unwrap();
    assert_eq!(
        outcome.error.as_ref().map(|error| error.code.as_str()),
        Some("CORE_EFFECT_TIMEOUT")
    );
    assert_eq!(outcome.compensation_results.len(), 1);
    assert!(outcome.compensation_failures.is_empty());
}

#[test]
fn reports_negative_compensation_acknowledgements() {
    let (actor, effects) = actor();
    let handle = actor
        .start(OperationPlan {
            steps: vec![
                OperationStep {
                    effect: effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.2),
                    }),
                    compensation: Some(effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.0),
                    })),
                },
                OperationStep {
                    effect: effect(CoreEffectAction::OverlayOpenMacroPage {
                        role_id: "role-1".to_owned(),
                    }),
                    compensation: None,
                },
            ],
        })
        .unwrap();
    let first = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor.dispatch_results(vec![success(&first)]).unwrap();
    let second = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor
        .dispatch_results(vec![failed_result(
            second.effect_id,
            second.operation_id,
            "TEST_EFFECT_FAILED",
            "load failed",
        )])
        .unwrap();
    let compensation = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor
        .dispatch_results(vec![failed_result(
            compensation.effect_id,
            compensation.operation_id,
            "TEST_COMPENSATION_FAILED",
            "rollback failed",
        )])
        .unwrap();

    let outcome = handle.outcome.blocking_recv().unwrap();
    assert_eq!(outcome.compensation_results.len(), 1);
    assert_eq!(outcome.compensation_failures.len(), 1);
    assert_eq!(
        outcome.compensation_failures[0].error.code,
        "TEST_COMPENSATION_FAILED"
    );
}

#[test]
fn reports_compensation_transport_timeouts() {
    let (actor, effects) = actor();
    let mut compensation = effect(CoreEffectAction::EmbeddedFocusRole {
        role_id: "role-1".to_owned(),
        zoom_factor: Some(1.0),
    });
    compensation.timeout = Duration::from_millis(10);
    let handle = actor
        .start(OperationPlan {
            steps: vec![
                OperationStep {
                    effect: effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: Some(1.2),
                    }),
                    compensation: Some(compensation),
                },
                OperationStep {
                    effect: effect(CoreEffectAction::OverlayOpenMacroPage {
                        role_id: "role-1".to_owned(),
                    }),
                    compensation: None,
                },
            ],
        })
        .unwrap();
    let first = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor.dispatch_results(vec![success(&first)]).unwrap();
    let second = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor
        .dispatch_results(vec![failed_result(
            second.effect_id,
            second.operation_id,
            "TEST_EFFECT_FAILED",
            "load failed",
        )])
        .unwrap();
    let _compensation = effects.recv_timeout(Duration::from_secs(1)).unwrap();

    let outcome = handle.outcome.blocking_recv().unwrap();
    assert!(outcome.compensation_results.is_empty());
    assert_eq!(outcome.compensation_failures.len(), 1);
    assert_eq!(
        outcome.compensation_failures[0].error.code,
        "CORE_EFFECT_TIMEOUT"
    );
}

#[test]
fn cancellation_notifies_each_dispatched_effect_once_and_exact_result_wins() {
    let (actor, effects, cancellations) = actor_with_cancellations();
    let mut handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-1".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    handle.wait_for_first_effect_dispatch().unwrap();

    assert!(actor.cancel(&request.operation_id).unwrap());
    assert_eq!(
        cancellations.recv_timeout(Duration::from_secs(1)).unwrap(),
        vec![CoreEffectCancellationRecord {
            effect_id: request.effect_id.clone(),
            operation_id: request.operation_id.clone(),
            reason: CoreEffectCancellationReason::OperationCancelled,
        }]
    );
    let _ = actor.cancel(&request.operation_id);
    assert!(matches!(
        cancellations.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    let exact = failed_result(
        request.effect_id.clone(),
        request.operation_id.clone(),
        "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
        "native submission may have completed",
    );
    let report = actor.dispatch_results(vec![exact.clone()]).unwrap();
    assert_eq!(report.accepted, vec![request.effect_id.clone()]);
    assert_eq!(
        handle
            .outcome
            .blocking_recv()
            .unwrap()
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE")
    );
    assert_eq!(
        actor.dispatch_results(vec![exact]).unwrap().duplicate,
        vec![request.effect_id]
    );
    assert!(matches!(
        cancellations.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn deadline_does_not_repeat_an_existing_exact_cancellation() {
    let (actor, effects, cancellations) = actor_with_cancellations();
    let mut handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: OperationEffect {
                    timeout: Duration::from_millis(20),
                    ..effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: None,
                    })
                },
                compensation: None,
            }],
        })
        .unwrap();
    let request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    handle.wait_for_first_effect_dispatch().unwrap();
    assert!(actor.cancel(&request.operation_id).unwrap());
    assert_eq!(
        cancellations.recv_timeout(Duration::from_secs(1)).unwrap(),
        vec![CoreEffectCancellationRecord {
            effect_id: request.effect_id,
            operation_id: request.operation_id,
            reason: CoreEffectCancellationReason::OperationCancelled,
        }]
    );
    assert_eq!(
        handle
            .outcome
            .blocking_recv()
            .unwrap()
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("CORE_EFFECT_TIMEOUT")
    );
    assert!(matches!(
        cancellations.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn shutdown_notifies_each_dispatched_effect_once_and_exact_results_win() {
    let (actor, effects, cancellations) = actor_with_cancellations();
    let mut first_handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-1".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let first = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    first_handle.wait_for_first_effect_dispatch().unwrap();
    let mut second_handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedDestroyRole {
                    role_id: "role-2".to_owned(),
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let second = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    second_handle.wait_for_first_effect_dispatch().unwrap();

    actor.shutdown();
    let mut emitted = cancellations.recv_timeout(Duration::from_secs(1)).unwrap();
    emitted.sort_by(|left, right| left.effect_id.cmp(&right.effect_id));
    let mut expected = vec![
        CoreEffectCancellationRecord {
            effect_id: first.effect_id.clone(),
            operation_id: first.operation_id.clone(),
            reason: CoreEffectCancellationReason::ActorStopped,
        },
        CoreEffectCancellationRecord {
            effect_id: second.effect_id.clone(),
            operation_id: second.operation_id.clone(),
            reason: CoreEffectCancellationReason::ActorStopped,
        },
    ];
    expected.sort_by(|left, right| left.effect_id.cmp(&right.effect_id));
    assert_eq!(emitted, expected);
    actor.shutdown();
    assert!(matches!(
        cancellations.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));

    let first_result = failed_result(
        first.effect_id.clone(),
        first.operation_id.clone(),
        "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
        "native submission may have completed",
    );
    let second_result = failed_result(
        second.effect_id.clone(),
        second.operation_id.clone(),
        "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
        "native submission may have completed",
    );
    let mut report = actor
        .dispatch_results(vec![first_result.clone(), second_result.clone()])
        .unwrap();
    report.accepted.sort();
    let mut expected_accepted = vec![first.effect_id.clone(), second.effect_id.clone()];
    expected_accepted.sort();
    assert_eq!(report.accepted, expected_accepted);
    for handle in [first_handle, second_handle] {
        assert_eq!(
            handle
                .outcome
                .blocking_recv()
                .unwrap()
                .error
                .as_ref()
                .map(|error| error.code.as_str()),
            Some("CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE")
        );
    }
    let mut duplicate = actor
        .dispatch_results(vec![first_result, second_result])
        .unwrap()
        .duplicate;
    duplicate.sort();
    assert_eq!(duplicate, expected_accepted);
}

#[test]
fn cancellation_emitter_is_silent_when_no_pending_effect_is_removed() {
    let (actor, _effects, cancellations) = actor_with_cancellations();
    let completed = actor.start(OperationPlan::default()).unwrap();
    let operation_id = completed.operation_id.clone();
    assert!(completed.outcome.blocking_recv().unwrap().error.is_none());

    assert!(!actor.cancel(&operation_id).unwrap());
    actor.shutdown();
    assert!(matches!(
        cancellations.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn bounds_pending_effects_and_active_operations() {
    let (sender, receiver) = mpsc::channel();
    let actor =
        OperationActor::with_capacity(Arc::new(move |effects| sender.send(effects).unwrap()), 1, 1);
    let handle = actor
        .start(OperationPlan {
            steps: vec![OperationStep {
                effect: effect(CoreEffectAction::EmbeddedFocusRole {
                    role_id: "role-1".to_owned(),
                    zoom_factor: None,
                }),
                compensation: None,
            }],
        })
        .unwrap();
    let request = receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    assert!(matches!(
        actor.start(OperationPlan::default()),
        Err(CoreError::Domain {
            code: "CORE_OPERATION_BACKPRESSURE",
            ..
        })
    ));
    let metrics = actor.metrics();
    assert_eq!(metrics.pending_effect_count, 1);
    assert_eq!(metrics.peak_pending_effect_count, 1);
    assert_eq!(metrics.emitted_effect_count, 1);
    assert_eq!(metrics.active_operation_count, 1);
    actor.shutdown();
    let shutdown_metrics = actor.metrics();
    assert_eq!(shutdown_metrics.pending_effect_count, 1);
    assert_eq!(shutdown_metrics.active_operation_count, 0);
    actor
        .dispatch_results(vec![failed_result(
            request.effect_id,
            request.operation_id,
            "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
            "native submission may have completed",
        )])
        .unwrap();
    assert_eq!(
        handle
            .outcome
            .blocking_recv()
            .unwrap()
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE")
    );
    assert_eq!(actor.metrics().pending_effect_count, 0);
}

#[test]
fn records_ack_latency_and_effects_per_launch() {
    let (actor, effects) = actor();
    let handle = actor
        .start_launch(OperationPlan {
            steps: vec![
                OperationStep {
                    effect: effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: None,
                    }),
                    compensation: None,
                },
                OperationStep {
                    effect: effect(CoreEffectAction::OverlayOpenMacroPage {
                        role_id: "role-1".to_owned(),
                    }),
                    compensation: None,
                },
            ],
        })
        .unwrap();

    let first = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor.dispatch_results(vec![success(&first)]).unwrap();
    let second = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    actor.dispatch_results(vec![success(&second)]).unwrap();
    let outcome = handle.outcome.blocking_recv().unwrap();
    assert!(outcome.error.is_none());

    let metrics = actor.metrics();
    assert_eq!(metrics.pending_effect_count, 0);
    assert_eq!(metrics.peak_pending_effect_count, 1);
    assert_eq!(metrics.emitted_effect_count, 2);
    assert_eq!(metrics.acknowledged_effect_count, 2);
    assert_eq!(metrics.effect_ack_latency.sample_count, 2);
    assert!(metrics.effect_ack_latency.p95_ms >= 0.0);
    assert_eq!(metrics.launch_operation_count, 1);
    assert_eq!(metrics.launch_effect_count, 2);
}

#[test]
fn child_effect_keeps_its_operation_id_and_carries_the_tab_mutation_parent() {
    let (actor, effects) = actor();
    let handle = actor
        .start_with_parent(
            OperationPlan {
                steps: vec![OperationStep {
                    effect: effect(CoreEffectAction::EmbeddedFocusRole {
                        role_id: "role-1".to_owned(),
                        zoom_factor: None,
                    }),
                    compensation: None,
                }],
            },
            "native-tabMutation-7".to_owned(),
        )
        .unwrap();
    let request = effects
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .remove(0);
    assert_eq!(
        request.parent_operation_id.as_deref(),
        Some("native-tabMutation-7")
    );
    assert_eq!(request.operation_id, handle.operation_id);
    assert_ne!(request.operation_id, "native-tabMutation-7");
    actor.dispatch_results(vec![success(&request)]).unwrap();
    assert!(handle.outcome.blocking_recv().unwrap().error.is_none());
}
