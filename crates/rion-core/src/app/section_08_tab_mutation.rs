impl AppCore {
    fn apply_embedded_runtime_command(
        &self,
        commands: Vec<BrowserRuntimeCommand>,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: Vec<String>,
        focus_window_ids: Vec<String>,
        focus_tab_id: Option<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _window_sequence = self.embedded_window_sequence.acquire()?;
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        self.apply_embedded_runtime_command_inner(EmbeddedRuntimeTransition {
            commands,
            target,
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
            parent_operation_id: None,
        })
    }

    fn serialized_browser_runtime_snapshot(&self) -> CoreResult<Value> {
        let snapshot = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .snapshot();
        serde_json::to_value(snapshot).map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn stop_embedded_tab_mutation(
        &self,
        request: crate::model::RuntimeTabMutationRequestRecord,
        source_id: &str,
        tab_type: &str,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        if request.mutation_kind != "stop" || !matches!(tab_type, "role" | "workspace") {
            return Err(CoreError::Domain {
                code: "TAB_MUTATION_KIND_INVALID",
                message: "The typed tab stop request is invalid.".to_owned(),
            });
        }
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let Some(tab) = snapshot.tabs.iter().find(|tab| tab.id == request.tab_id) else {
            // A window close and an AppKit/HTML tab-close callback can race after
            // the live tab is already gone. Stop is idempotent: the absent Core
            // record proves there is no remaining owner command to issue.
            return Ok(snapshot);
        };
        // LiveWindowTabState owns window membership while the native gesture is
        // active. A close may therefore carry the new live window before an
        // older, best-effort Core drag projection has caught up. The stable tab
        // identity and its persisted source are sufficient to authorize stop;
        // treating a window mismatch as an identity change strands the tab in
        // `stopping` even though it is the exact instance the user closed.
        if tab.source_id != source_id || tab.tab_type != tab_type {
            return Err(CoreError::Domain {
                code: "TAB_MUTATION_RESULT_UNKNOWN",
                message: "The runtime tab identity changed before stop committed.".to_owned(),
            });
        }
        if tab_type == "workspace" {
            self.stop_embedded_workspace_with_operation_lease(
                source_id,
                true,
                false,
                Some(&request.operation_id),
            )?;
        } else {
            self.stop_embedded_role_with_operation_lease(
                source_id,
                true,
                true,
                false,
                Some(&request.operation_id),
            )?;
        }
        Ok(self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot)
    }
}
