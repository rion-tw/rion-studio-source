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
    fn changing_a_called_macro_stops_the_parent_that_would_run_its_old_steps() {
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

        // Disabling or editing x takes the same stop-active mutation lease.
        let lease = runtime.acquire_mutation(vec!["x".to_owned()], true).unwrap();
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

