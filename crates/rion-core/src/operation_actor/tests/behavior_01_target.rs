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
    fn cancelled_queued_effect_is_no_longer_admitted_by_the_native_executor() {
        let (actor, effects) = actor();
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
        let request = effects
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .remove(0);
        assert!(
            actor
                .effect_is_pending(&request.effect_id, &request.operation_id)
                .unwrap()
        );
        assert!(actor.cancel(&request.operation_id).unwrap());
        assert!(
            !actor
                .effect_is_pending(&request.effect_id, &request.operation_id)
                .unwrap()
        );
        let outcome = handle.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("CORE_OPERATION_CANCELLED")
        );
    }

    #[test]
    fn classifies_duplicate_unknown_late_and_operation_mismatch_results() {
        let (actor, effects) = actor();
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
        thread::sleep(Duration::from_millis(30));
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
    fn cancellation_and_shutdown_release_pending_oneshots() {
        let (actor, effects) = actor();
        let cancelled = actor
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
        let _ = effects.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(actor.cancel(&cancelled.operation_id).unwrap());
        let outcome = cancelled.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("CORE_OPERATION_CANCELLED")
        );

        let shutting_down = actor
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
        let _ = effects.recv_timeout(Duration::from_secs(1)).unwrap();
        actor.shutdown();
        let outcome = shutting_down.outcome.blocking_recv().unwrap();
        assert_eq!(
            outcome.error.as_ref().map(|error| error.code.as_str()),
            Some("CORE_SHUTTING_DOWN")
        );
        assert!(matches!(
            actor.start(OperationPlan::default()),
            Err(CoreError::ShuttingDown)
        ));
    }

    #[test]
    fn bounds_pending_effects_and_active_operations() {
        let (sender, receiver) = mpsc::channel();
        let actor = OperationActor::with_capacity(
            Arc::new(move |effects| sender.send(effects).unwrap()),
            1,
            1,
        );
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
        let _ = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
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
        assert_eq!(shutdown_metrics.pending_effect_count, 0);
        assert_eq!(shutdown_metrics.active_operation_count, 0);
        let _ = handle.outcome.blocking_recv().unwrap();
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
