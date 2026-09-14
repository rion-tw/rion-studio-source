#[derive(Clone, Copy, PartialEq, Eq)]
enum EmbeddedCloseProjection {
    FollowRoleOwnership,
    // The admitted AppKit event publishes full membership and owns the exact
    // native terminal receipt after destruction completes.
    AppKitEvent,
}

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
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        serde_json::to_value(snapshot).map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn stop_embedded_tab_mutation(
        &self,
        request: crate::model::RuntimeTabMutationRequestRecord,
        source_id: &str,
        tab_type: &str,
        close_projection: EmbeddedCloseProjection,
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
        let close = if self.platform == rion_platform::Platform::Windows {
            self.prepare_runtime_logical_close(&request.operation_id, &request.source_window_id,
                Some(request.source_window_generation), None, &request.tab_id, None)?
        } else { None };
        let presentation = (|| -> CoreResult<()> {
        if let Some(close) = close.as_ref() {
            // Topology commits before potentially blocked surface/storage release.
            let windows: Vec<_> = self.embedded_runtime_window_projections()?.into_iter()
                .filter(|window| window.window_id == request.source_window_id).collect();
            let revision = windows.first().map_or(0, |window| window.topology_revision);
            self.run_effect_plan_with_parent(vec![effect_step(&request.source_window_id,
                CoreEffectAction::EmbeddedFollowRoleOwnership {
                    lifecycle_epoch: self.application_lifecycle_epoch.load(Ordering::Acquire),
                    roles: snapshot.roles.clone(), windows, target: None,
                    reveal_window_ids: Vec::new(), focus_window_ids: Vec::new(), focus_tab_id: None,
                }, Duration::from_secs(15), None)], &request.operation_id)?;
            self.emit(vec![CoreEvent::RuntimeTabTopologyCommitted {
                operation_id: close.operation_id.as_str().to_owned(), tab_id: request.tab_id.clone(),
                window_id: request.source_window_id.clone(), window_generation: request.source_window_generation,
                topology_revision: revision,
            }]);
        }
            Ok(())
        })();
        let result = (|| -> CoreResult<()> {
        if tab_type == "role"
            && let Some(_snapshot) =
                self.remove_unowned_role_tab_mutation(&request, source_id, tab_type)?
        {
            return Ok(());
        }
        if tab_type == "workspace" {
            self.stop_embedded_workspace_with_operation_lease(
                source_id,
                true,
                false,
                close_projection,
                Some(&request.operation_id),
            )?;
        } else {
            self.stop_embedded_role_with_operation_lease(
                source_id,
                true,
                true,
                close_projection,
                Some(&request.operation_id),
            )?;
        }
            Ok(())
        })();
        if let Some(close) = close.as_ref() {
            self.finish_runtime_logical_close(close, if result.is_ok() { "closed" } else { "failed" })?;
        }
        result?;
        presentation?;
        Ok(self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot)
    }

    fn remove_unowned_role_tab_mutation(
        &self,
        request: &crate::model::RuntimeTabMutationRequestRecord,
        source_id: &str,
        tab_type: &str,
    ) -> CoreResult<Option<crate::model::BrowserRuntimeSnapshot>> {
        let sequence = self.embedded_runtime_sequence.acquire()?;
        let current = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let Some(tab) = current.tabs.iter().find(|tab| tab.id == request.tab_id) else {
            return Ok(Some(current));
        };
        if tab.source_id != source_id || tab.tab_type != tab_type {
            return Err(CoreError::Domain {
                code: "TAB_MUTATION_RESULT_UNKNOWN",
                message: "The runtime tab identity changed before stop committed.".to_owned(),
            });
        }
        if current
            .roles
            .iter()
            .any(|role| role.owner.tab_id == request.tab_id)
        {
            return Ok(None);
        }
        let attempt_generation = tab.attempt_generation.clone();
        drop(sequence);
        self.run_embedded_runtime_effect(&request.tab_id,
            CoreEffectAction::EmbeddedDestroyTab { tab_id: request.tab_id.clone(), attempt_generation, next_active_tab_id: None },
            None, Some(&request.operation_id))?;
        let sequence = self.embedded_runtime_sequence.acquire()?;
        let next = self
            .invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: request.tab_id.clone(),
            })?
            .snapshot;
        drop(sequence);
        self.emit_browser_statuses();
        Ok(Some(next))
    }
}
