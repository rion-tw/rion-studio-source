impl SystemRuntimeExecutor {
    #[cfg(target_os = "macos")]
    pub(crate) fn release_tab_drag_pointer_passthrough(
        &self,
        window_id: &str,
    ) -> Result<(), String> {
        let Some(window) = self.window_for_id(window_id) else {
            return Ok(());
        };
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())
    }

    pub fn prepare_provisional_game_window(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        title: &str,
    ) -> Result<(), String> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Presentation,
            "prepareProvisionalWindow",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeSubmission)
        .with_window(&target.window_id);
        let result = self.prepare_provisional_game_window_inner(target, title);
        self.record_native_operation_receipt(receipt_for_string_result(
            operation,
            "provisionalWindowPrepared",
            "TAURI_RUNTIME_VISIBILITY_FAILED",
            &result,
        ));
        result
    }

    pub fn make_provisional_game_window_interactive(
        &self,
        window_id: &str,
    ) -> Result<(), String> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Presentation,
            "activateProvisionalWindow",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeSubmission)
        .with_window(window_id);
        let result = self.make_provisional_game_window_interactive_inner(window_id);
        self.record_native_operation_receipt(receipt_for_string_result(
            operation,
            "provisionalWindowActivated",
            "TAURI_RUNTIME_VISIBILITY_FAILED",
            &result,
        ));
        result
    }

    pub fn position_provisional_game_window(
        &self,
        target: &EmbeddedLaunchTargetRecord,
    ) -> Result<(), String> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Presentation,
            "positionProvisionalWindow",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeSubmission)
        .with_window(&target.window_id);
        let result = self.position_provisional_game_window_inner(target);
        self.record_native_operation_receipt(receipt_for_string_result(
            operation,
            "provisionalWindowPositioned",
            "TAURI_RUNTIME_POSITION_FAILED",
            &result,
        ));
        result
    }

    fn provisionally_move_tab_with_visibility(
        &self,
        tab_id: &str,
        target_window_id: &str,
        reveal_hidden_target: bool,
        live_drag: bool,
    ) -> Result<(), String> {
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Presentation,
            "moveProvisionalTab",
            NAVIGATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)
        .with_tab(tab_id)
        .with_window(target_window_id);
        let result = self.provisionally_move_tab_with_visibility_inner(
            tab_id,
            target_window_id,
            reveal_hidden_target,
            live_drag,
        );
        self.record_native_operation_receipt(receipt_for_string_result(
            operation,
            "provisionalTabMoveCommitted",
            "TAURI_RUNTIME_REPARENT_FAILED",
            &result,
        ));
        result
    }
}
