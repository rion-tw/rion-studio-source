impl SystemRuntimeExecutor {
    fn apply_runtime(
        &self,
        snapshot: BrowserRuntimeSnapshot,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: &[String],
        focus_window_ids: &[String],
        focus_tab_id: Option<&str>,
        presentation_revision: u64,
    ) -> RuntimeResult<()> {
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Presentation,
            "applyRuntimeTopology",
            NAVIGATION_TIMEOUT,
        )
        .with_completion_scope("stateCommit")
        .with_revision(presentation_revision);
        if let Some(target) = target.as_ref() {
            operation = operation.with_window(&target.window_id);
        }
        if let Some(tab_id) = focus_tab_id {
            operation = operation.with_tab(tab_id);
        }
        let result = self.apply_runtime_inner(
            snapshot,
            target,
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
            presentation_revision,
        );
        self.record_native_operation_receipt(receipt_for_runtime_result(
            operation,
            "runtimeTopologyCommitted",
            &result,
        ));
        result
    }
}
