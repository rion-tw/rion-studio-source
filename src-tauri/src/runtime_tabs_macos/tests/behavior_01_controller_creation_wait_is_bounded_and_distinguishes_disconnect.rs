use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

    use super::{
        AppKitTrackingDispatchError, AppKitTrackingTaskState, ControllerCreationWaitError,
        LayoutUpdateState, continue_layout_updates, execute_appkit_tracking_task,
        request_layout_update, wait_for_appkit_tracking_task, wait_for_controller,
    };

    #[test]
    fn controller_creation_wait_is_bounded_and_distinguishes_disconnect() {
        let (sender, receiver) = mpsc::sync_channel(1);

        assert_eq!(
            wait_for_controller(&receiver, Duration::ZERO),
            Err(ControllerCreationWaitError::TimedOut)
        );

        drop(sender);
        assert_eq!(
            wait_for_controller(&receiver, Duration::ZERO),
            Err(ControllerCreationWaitError::CallbackLost)
        );
    }

    #[test]
    fn queued_appkit_tracking_task_is_cancelled_before_a_late_main_queue_callback() {
        let state = Arc::new(AppKitTrackingTaskState::default());
        let (sender, receiver) = mpsc::sync_channel(1);
        assert_eq!(
            wait_for_appkit_tracking_task(&receiver, &state, Duration::ZERO),
            Err(AppKitTrackingDispatchError::TimedOutBeforeStart)
        );

        let mutation_count = AtomicUsize::new(0);
        execute_appkit_tracking_task(&state, sender, || {
            mutation_count.fetch_add(1, Ordering::AcqRel);
        });
        assert_eq!(mutation_count.load(Ordering::Acquire), 0);
    }

    #[test]
    fn started_appkit_tracking_task_reports_an_unknown_mutation_result() {
        let state = Arc::new(AppKitTrackingTaskState::default());
        let worker_state = Arc::clone(&state);
        let (sender, receiver) = mpsc::sync_channel(1);
        let (started_sender, started_receiver) = mpsc::sync_channel(1);
        let (finish_sender, finish_receiver) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            execute_appkit_tracking_task(&worker_state, sender, || {
                started_sender.send(()).unwrap();
                finish_receiver.recv().unwrap();
            });
        });
        started_receiver.recv().unwrap();

        let error = wait_for_appkit_tracking_task(&receiver, &state, Duration::ZERO).unwrap_err();
        assert_eq!(error, AppKitTrackingDispatchError::TimedOutAfterStart);
        assert!(error.mutation_may_have_started());

        finish_sender.send(()).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn retry_after_a_cancelled_queued_toggle_mutates_only_once() {
        let mutation_count = AtomicUsize::new(0);
        let cancelled_state = AppKitTrackingTaskState::default();
        let (cancelled_sender, cancelled_receiver) = mpsc::sync_channel(1);
        assert_eq!(
            wait_for_appkit_tracking_task(
                &cancelled_receiver,
                &cancelled_state,
                Duration::ZERO,
            ),
            Err(AppKitTrackingDispatchError::TimedOutBeforeStart)
        );
        execute_appkit_tracking_task(&cancelled_state, cancelled_sender, || {
            mutation_count.fetch_add(1, Ordering::AcqRel);
        });

        let retry_state = AppKitTrackingTaskState::default();
        let (retry_sender, retry_receiver) = mpsc::sync_channel(1);
        execute_appkit_tracking_task(&retry_state, retry_sender, || {
            mutation_count.fetch_add(1, Ordering::AcqRel);
        });
        wait_for_appkit_tracking_task(&retry_receiver, &retry_state, Duration::ZERO).unwrap();
        assert_eq!(mutation_count.load(Ordering::Acquire), 1);
    }

    #[test]
    fn layout_updates_coalesce_while_one_worker_is_running() {
        let state = LayoutUpdateState::default();

        assert!(request_layout_update(&state));
        assert!(!request_layout_update(&state));
        assert!(continue_layout_updates(&state));
        assert!(!continue_layout_updates(&state));
        assert!(request_layout_update(&state));
    }

    #[test]
    fn native_action_scope_preserves_window_identifiers() {
        assert!(unsafe { super::rion_runtime_tabs_action_scope_self_test() });
    }

    // The native scope key is a window ID.
    #[test]
    fn native_action_scope_preserves_nonzero_and_safe_negative_display_ids() {
        native_action_scope_preserves_window_identifiers();
    }

    #[test]
    fn native_tab_overflow_layout_clamps_and_reclaims_hidden_close_width() {
        assert!(unsafe { super::rion_runtime_tabs_overflow_layout_self_test() });
    }

    #[test]
    fn native_tab_drag_reorder_uses_spatial_hysteresis() {
        assert!(unsafe { super::rion_runtime_tabs_drag_hysteresis_self_test() });
    }

    #[test]
    fn native_fullscreen_toolbar_policy_restores_baseline_and_prioritizes_pinned_windows() {
        assert!(unsafe { super::rion_runtime_tabs_fullscreen_toolbar_policy_self_test() });
    }

    #[test]
    fn native_control_tab_shortcut_is_scoped_and_does_not_capture_command_tab() {
        assert!(unsafe { super::rion_runtime_tabs_shortcut_self_test() });
    }

    #[test]
    fn native_modifier_focus_handoff_preserves_sides_order_and_physical_truth() {
        assert!(unsafe { super::rion_runtime_tabs_modifier_focus_self_test() });
    }

    #[test]
    fn marked_macro_fallback_events_are_identified_before_native_chrome_dispatch() {
        assert!(unsafe { super::rion_runtime_tabs_macro_fallback_event_self_test() });
    }
