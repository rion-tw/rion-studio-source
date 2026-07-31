use std::{sync::mpsc, time::Duration};

    use super::{
        ControllerCreationWaitError, LayoutUpdateState, continue_layout_updates,
        request_layout_update, wait_for_controller,
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

    // Keep the historical parity evidence name while the native scope key is now a window ID.
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
    fn native_control_tab_shortcut_is_scoped_and_does_not_capture_command_tab() {
        assert!(unsafe { super::rion_runtime_tabs_shortcut_self_test() });
    }
