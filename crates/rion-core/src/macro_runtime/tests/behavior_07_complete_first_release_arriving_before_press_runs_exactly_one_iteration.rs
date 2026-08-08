#[test]
    fn complete_first_release_arriving_before_press_runs_exactly_one_iteration() {
        let (events, receiver) = mpsc::channel::<Vec<CoreEvent>>();
        let runtime = MacroRuntime::new(Arc::new(move |batch| {
            let _ = events.send(batch);
        }));
        runtime
            .release(MacroReleaseRequest {
                macro_id: "m1".to_owned(),
                source_role_id: "r1".to_owned(),
                press_id: "release-first".to_owned(),
                mode: "complete_first_iteration".to_owned(),
            })
            .unwrap();
        let mut start = request(vec![MacroStepDefinition::Key {
            id: "key".to_owned(),
            code: "Digit1".to_owned(),
            modifiers: None,
            action: Some("tap".to_owned()),
            label: None,
            duration_ms: None,
        }]);
        start.macros[0].activation_mode = Some("while_held".to_owned());
        start.macros[0].repeat = MacroRepeat::Loop { interval_ms: 0 };
        start.source_role_id = Some("r1".to_owned());
        let pressing_runtime = runtime.clone();
        let press = thread::spawn(move || {
            pressing_runtime.press(MacroPressRequest {
                start,
                press_id: "release-first".to_owned(),
            })
        });
        let focus = next_browser_actions(&receiver);
        runtime.dispatch_results(success_results(focus)).unwrap();
        assert_eq!(press.join().unwrap().unwrap().len(), 1);
        let mut phases = Vec::new();
        for expected_phase in ["hold", "release"] {
            let action = next_browser_actions(&receiver);
            assert!(matches!(
                action[0].action,
                BrowserAction::Key {
                    ref phase,
                    ..
                } if phase == expected_phase
            ));
            phases.push(expected_phase);
            runtime.dispatch_results(success_results(action)).unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        {
            assert_eq!(phases, ["hold", "release"]);
            while let Ok(events) = receiver.try_recv() {
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                    "the early release allowed a second iteration"
                );
            }
        };
    }

    fn drive_timed_tap(
        runtime: &MacroRuntime,
        events: &mpsc::Receiver<Vec<CoreEvent>>,
        waits: &mpsc::Receiver<ManualWait>,
        request: MacroStartRequest,
    ) -> Vec<u32> {
        let _ = start_and_ack_focus(runtime, events, request);
        let mut durations = Vec::new();

        let startup = next_wait(waits);
        durations.push(startup.duration_ms);
        startup.release.send(()).unwrap();

        let hold = next_browser_actions(events);
        assert!(matches!(
            hold[0].action,
            BrowserAction::Key { ref phase, .. } if phase == "hold"
        ));
        runtime.dispatch_results(success_results(hold)).unwrap();

        let key_hold = next_wait(waits);
        durations.push(key_hold.duration_ms);
        key_hold.release.send(()).unwrap();

        let release = next_browser_actions(events);
        assert!(matches!(
            release[0].action,
            BrowserAction::Key { ref phase, .. } if phase == "release"
        ));
        runtime.dispatch_results(success_results(release)).unwrap();

        let post_input = next_wait(waits);
        durations.push(post_input.duration_ms);
        post_input.release.send(()).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !runtime.statuses().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        durations
    }

    fn success_results(actions: Vec<BrowserActionRequest>) -> Vec<BrowserActionResult> {
        actions
            .into_iter()
            .map(|action| BrowserActionResult {
                request_id: action.request_id,
                ok: true,
                value_json: None,
                error_code: None,
                error_message: None,
            })
            .collect()
    }

    fn start_and_ack_focus(
        runtime: &MacroRuntime,
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
        request: MacroStartRequest,
    ) -> (Vec<MacroRunStatus>, Vec<BrowserActionRequest>) {
        let starting_runtime = runtime.clone();
        let start = thread::spawn(move || starting_runtime.start(request).unwrap());
        let focus = next_browser_actions(receiver);
        runtime
            .dispatch_results(success_results(focus.clone()))
            .unwrap();
        (start.join().unwrap(), focus)
    }

    fn next_browser_actions(
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
    ) -> Vec<BrowserActionRequest> {
        loop {
            for event in receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                if let CoreEvent::BrowserActions { actions } = event {
                    return actions;
                }
            }
        }
    }

    fn next_browser_action_count(
        receiver: &mpsc::Receiver<Vec<CoreEvent>>,
        count: usize,
    ) -> Vec<BrowserActionRequest> {
        let mut actions = Vec::new();
        while actions.len() < count {
            actions.extend(next_browser_actions(receiver));
        }
        assert_eq!(actions.len(), count);
        actions
    }

    fn assert_no_browser_actions(receiver: &mpsc::Receiver<Vec<CoreEvent>>, duration: Duration) {
        let started = std::time::Instant::now();
        while started.elapsed() < duration {
            let remaining = duration.saturating_sub(started.elapsed());
            let Ok(events) = receiver.recv_timeout(remaining) else {
                break;
            };
            assert!(
                events
                    .iter()
                    .all(|event| !matches!(event, CoreEvent::BrowserActions { .. })),
                "an input action escaped its per-role sequence"
            );
        }
    }

    fn wait_for_last_click(
        runtime: &MacroRuntime,
        role_id: &str,
        sequence: u32,
        step_id: &str,
    ) -> MacroLastClick {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(click) = runtime
                .statuses()
                .unwrap()
                .iter()
                .find(|status| status.role_id == role_id)
                .and_then(|status| status.last_click.as_ref())
                .filter(|click| click.sequence == sequence && click.step_id == step_id)
                .cloned()
            {
                return click;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }
