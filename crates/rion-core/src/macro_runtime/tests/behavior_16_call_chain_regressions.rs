    fn chain_definition(
        id: &str,
        steps: Vec<MacroStepDefinition>,
        repeat: MacroRepeat,
    ) -> MacroDefinition {
        MacroDefinition {
            execution_mode: None,
            id: id.to_owned(),
            enabled: true,
            activation_mode: Some(MacroActivationMode::Press),
            name: id.to_owned(),
            role_ids: vec!["r1".to_owned()],
            shortcut_source_scope: Default::default(),
            trigger: None,
            repeat,
            steps,
        }
    }

    fn chain_call(id: &str, macro_id: &str, call_mode: &str) -> MacroStepDefinition {
        MacroStepDefinition::Macro {
            id: id.to_owned(),
            macro_id: macro_id.to_owned(),
            call_mode: Some(call_mode.to_owned()),
        }
    }

    /// Acknowledges every emitted browser action until `done` holds or 3 s pass.
    fn acknowledge_until(
        runtime: &MacroRuntime,
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
        done: impl Fn(&MacroRuntime) -> bool,
    ) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if done(runtime) {
                return true;
            }
            if let Ok(batch) = receiver.recv_timeout(Duration::from_millis(20)) {
                for event in batch {
                    if let CoreEvent::BrowserActions { actions } = event {
                        runtime.dispatch_results(success_results(actions)).unwrap();
                    }
                }
            }
        }
        done(runtime)
    }

    #[test]
    fn a_second_synchronous_call_runs_while_the_first_child_waits_for_its_trigger() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let parent = chain_definition(
            "m1",
            vec![chain_call("call-1", "c", "wait"), chain_call("call-2", "c", "wait")],
            MacroRepeat::Once,
        );
        let child = chain_definition("c", vec![chain_call("trig", "g", "trigger")], MacroRepeat::Once);
        let grandchild = chain_definition(
            "g",
            vec![MacroStepDefinition::Delay { id: "d".to_owned(), ms: 60_000 }],
            MacroRepeat::Once,
        );
        let mut start = request(Vec::new());
        start.macros = vec![parent, child, grandchild];
        let starting = runtime.clone();
        let handle = thread::spawn(move || starting.start(start));
        // The root stays registered while the triggered grandchild runs, so its
        // completed iteration (or a failure) is the observable end of its steps.
        let parent_done = acknowledge_until(&runtime, &receiver, |runtime| {
            runtime.statuses().unwrap().iter().any(|status| {
                status.state == "failed" || (status.macro_id == "m1" && status.iteration == Some(1))
            })
        });
        handle.join().unwrap().unwrap();

        let statuses = runtime.statuses().unwrap();
        assert!(parent_done, "the parent did not finish its steps: {statuses:?}");
        assert!(
            statuses.iter().all(|status| status.state != "failed"),
            "a later synchronous call was rejected as a duplicate: {statuses:?}"
        );
        assert!(statuses.iter().any(|status| status.macro_id == "g" && status.state == "running"));
        runtime.stop_macro("m1").unwrap();
        runtime.shutdown();
    }

    #[test]
    fn disabling_a_called_macro_stops_the_parent_that_would_still_call_it() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let parent = chain_definition(
            "m1",
            vec![
                MacroStepDefinition::Delay { id: "d".to_owned(), ms: 100 },
                chain_call("call", "x", "wait"),
            ],
            MacroRepeat::Loop { interval_ms: 0 },
        );
        let child = chain_definition(
            "x",
            vec![MacroStepDefinition::Delay { id: "xd".to_owned(), ms: 1 }],
            MacroRepeat::Once,
        );
        let mut start = request(Vec::new());
        start.macros = vec![parent, child];
        let starting = runtime.clone();
        let handle = thread::spawn(move || starting.start(start));
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        handle.join().unwrap().unwrap();

        // Disabling x stops callers whose start snapshot would run it again.
        let lease = runtime.acquire_disable_mutation(vec!["x".to_owned()]).unwrap();
        runtime.release_mutation(&lease).unwrap();

        assert!(runtime.shared.inner.lock().unwrap().invocations.is_empty());
        assert!(runtime.statuses().unwrap().iter().all(|status| status.macro_id != "m1"));
        let x_started = acknowledge_until(&runtime, &receiver, |runtime| {
            runtime
                .shared
                .inner
                .lock()
                .unwrap()
                .recent_start_attempts
                .iter()
                .any(|attempt| attempt.macro_id == "x")
        });
        assert!(!x_started, "the stopped parent started the changed Macro again");
        runtime.shutdown();
    }

    #[test]
    fn a_refused_delete_or_an_edit_of_a_called_macro_keeps_its_caller_running() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let parent = chain_definition(
            "m1",
            vec![
                MacroStepDefinition::Delay { id: "d".to_owned(), ms: 60_000 },
                chain_call("call", "x", "wait"),
            ],
            MacroRepeat::Once,
        );
        let child = chain_definition(
            "x",
            vec![MacroStepDefinition::Delay { id: "xd".to_owned(), ms: 1 }],
            MacroRepeat::Once,
        );
        let mut start = request(Vec::new());
        start.macros = vec![parent, child];
        let starting = runtime.clone();
        let handle = thread::spawn(move || starting.start(start));
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        handle.join().unwrap().unwrap();

        // Delete takes a stop-active lease before the domain refuses to delete a
        // referenced Macro; that refusal must not cost the caller its run.
        let lease = runtime.acquire_mutation(vec!["x".to_owned()], true).unwrap();
        runtime.release_mutation(&lease).unwrap();

        assert_eq!(runtime.shared.inner.lock().unwrap().invocations.len(), 1);
        assert!(runtime.statuses().unwrap().iter().any(|status| status.macro_id == "m1"));
        runtime.stop_macro("m1").unwrap();
        runtime.shutdown();
    }

    #[test]
    fn a_failed_recovery_member_releases_siblings_that_already_resumed() {
        for cancel in [false, true] {
            let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
            // The unacknowledged holds only keep the root registered; a short
            // action deadline lets shutdown retire it quickly.
            let runtime = MacroRuntime::new_with_waiter_and_timeout(
                Arc::new(move |batch| {
                    let _ = events.send(batch);
                }),
                Arc::new(default_wait),
                Duration::from_millis(300),
            );
            let mut start = request(vec![MacroStepDefinition::Key {
                id: "k".to_owned(),
                code: "KeyA".to_owned(),
                modifiers: None,
                action: Some("tap".to_owned()),
                label: None,
                duration_ms: None,
            }]);
            start.macros[0].role_ids = vec!["r1".to_owned(), "r2".to_owned()];
            start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
            start.active_role_ids = vec!["r1".to_owned(), "r2".to_owned()];
            let starting = runtime.clone();
            let handle = thread::spawn(move || starting.start(start));
            let focus = next_browser_actions(&receiver);
            runtime.dispatch_results(success_results(focus)).unwrap();
            handle.join().unwrap().unwrap();
            let _unacknowledged_holds = next_browser_actions(&receiver);
            let first = runtime.ensure_input_recovery("rec-a", "r1").unwrap();
            runtime.ensure_input_recovery("rec-b", "r2").unwrap();
            assert!(runtime.resume_role_input("r1", first.input_epoch).unwrap());

            if cancel {
                runtime.cancel_input_recovery_for_role("r2").unwrap();
            } else {
                assert!(runtime.fail_input_recovery("rec-b", "r2", "neutralization failed").unwrap());
            }

            let inner = runtime.shared.inner.lock().unwrap();
            assert!(!inner.recovering_role_ids.contains("r1"), "cancel={cancel}");
            assert!(!inner.input_recovery_by_role.contains_key("r1"), "cancel={cancel}");
            assert!(!inner.input_recoveries.contains_key("rec-a"), "cancel={cancel}");
            assert!(
                !inner.statuses.keys().any(|key| key.starts_with(&recovery_status_prefix("rec-a"))),
                "cancel={cancel}"
            );
            drop(inner);
            let r1 = runtime
                .input_diagnostics()
                .unwrap()
                .roles
                .into_iter()
                .find(|role| role.role_id == "r1");
            assert!(r1.is_none_or(|role| !role.quiesced && !role.restart_required), "cancel={cancel}");
            runtime.shutdown();
        }
    }

    #[test]
    fn transient_input_that_times_out_is_indeterminate_not_applied() {
        let (events, _receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new_with_waiter_and_timeout(
            Arc::new(move |batch| {
                let _ = events.send(batch);
            }),
            Arc::new(default_wait),
            Duration::from_millis(50),
        );
        let shortcut = runtime.dispatch_managed_shortcut_phase(ManagedShortcutPhaseDispatch {
            operation_id: "op-1",
            role_id: "r1",
            surface_generation: 1,
            document_instance_id: "doc-1",
            shortcut_cycle_id: "cycle-1",
            code: "KeyA",
            phase: "keyDown",
            modifier_codes: &[],
        });
        assert_eq!(
            shortcut.map(|_| ()).map_err(|error| error.code().to_owned()),
            Err("SYSTEM_TRUSTED_INPUT_INDETERMINATE".to_owned())
        );

        let (events, _receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new_with_waiter_and_timeout(
            Arc::new(move |batch| {
                let _ = events.send(batch);
            }),
            Arc::new(default_wait),
            Duration::from_millis(50),
        );
        runtime.shared.inner.lock().unwrap().held_keys.insert(
            "owner-1".to_owned(),
            HeldKey {
                code: "KeyW".to_owned(),
                modifiers: Vec::new(),
                owner_id: "owner-1".to_owned(),
                role_id: "r1".to_owned(),
            },
        );
        let receipt = runtime
            .reassert_held_keys_after_context_loss(HeldKeyContinuityDispatch {
                operation_id: "op-2",
                role_id: "r1",
                surface_generation: 1,
                document_instance_id: "doc-1",
                loss_reason: "blur",
                loss_revision: 1,
            })
            .unwrap();
        assert_eq!(receipt.status, "indeterminate");
    }

    #[test]
    fn a_fresh_early_hold_release_survives_stale_releases_at_capacity() {
        let (events, _receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        let release = |cycle: &str| {
            runtime
                .hold_release(MacroHoldReleaseRequest {
                    macro_id: "m1".to_owned(),
                    source_role_id: "r1".to_owned(),
                    shortcut_cycle_id: cycle.to_owned(),
                })
                .unwrap();
        };
        for index in 0..300 {
            release(&format!("stale-{index}"));
        }
        release("fresh");

        let inner = runtime.shared.inner.lock().unwrap();
        assert!(inner.early_hold_releases.contains(&early_hold_release_key("r1", "m1", "fresh")));
        assert!(!inner.early_hold_releases.contains(&early_hold_release_key("r1", "m1", "stale-0")));
        assert_eq!(inner.early_hold_releases.keys.len(), EarlyHoldReleases::CAPACITY);
        drop(inner);
        runtime.shutdown();
    }
