impl AppCore {
    fn apply_embedded_runtime_command(
        &self,
        commands: Vec<BrowserRuntimeCommand>,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: Vec<String>,
        focus_window_ids: Vec<String>,
        focus_tab_id: Option<String>,
        focus_active_window_id: Option<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _window_sequence = self.embedded_window_sequence.acquire()?;
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        self.apply_embedded_runtime_command_inner(EmbeddedRuntimeTransition {
            commands,
            target,
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
            focus_active_window_id,
            parent_operation_id: None,
            persist_runtime_topology: true,
        })
    }

    fn apply_embedded_tab_mutation(
        &self,
        request: crate::model::RuntimeTabMutationRequestRecord,
        target: Option<EmbeddedLaunchTargetRecord>,
        before_tab_id: Option<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _window_sequence = self.embedded_window_sequence.acquire()?;
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let commands = match request.mutation_kind.as_str() {
            "hide" => vec![BrowserRuntimeCommand::HideTab {
                tab_id: request.tab_id.clone(),
            }],
            "reorder" => vec![BrowserRuntimeCommand::ReorderTab {
                tab_id: request.tab_id.clone(),
                before_tab_id,
            }],
            "move" | "moveToNewWindow" => {
                let target = target.as_ref().ok_or_else(|| CoreError::Domain {
                    code: "TAB_MUTATION_TARGET_REQUIRED",
                    message: "A move mutation requires a target Game Window.".to_owned(),
                })?;
                let mut commands = vec![BrowserRuntimeCommand::MoveTab {
                    tab_id: request.tab_id.clone(),
                    window_id: target.window_id.clone(),
                }];
                if before_tab_id.is_some() {
                    commands.push(BrowserRuntimeCommand::ReorderTab {
                        tab_id: request.tab_id.clone(),
                        before_tab_id,
                    });
                }
                commands
            }
            _ => {
                return Err(CoreError::Domain {
                    code: "TAB_MUTATION_KIND_INVALID",
                    message: "The tab mutation kind is unsupported by this transaction.".to_owned(),
                });
            }
        };
        let (mut next_runtime, mut next) = {
            let runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            let mut next_runtime = runtime.clone();
            let mut next = next_runtime.snapshot();
            for command in commands {
                next = next_runtime.invoke(command)?.snapshot;
            }
            (next_runtime, next)
        };
        if request.mutation_kind.starts_with("move")
            && next
                .windows
                .iter()
                .find(|window| window.window_id == request.source_window_id)
                .is_some_and(|window| window.tab_ids.is_empty())
        {
            next = next_runtime
                .invoke(BrowserRuntimeCommand::RemoveWindow {
                    window_id: request.source_window_id,
                })?
                .snapshot;
        }
        let mut runtime = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        *runtime = next_runtime;
        drop(runtime);
        // The live adapter has already committed AppKit/HTML and native surface
        // intent. This command is a one-way metadata sink and never emits an
        // ApplyRuntime effect that could compensate the user's topology.
        self.emit_browser_statuses();
        Ok(next)
    }

    fn serialized_embedded_tab_mutation(
        &self,
        request: crate::model::RuntimeTabMutationRequestRecord,
        target: Option<EmbeddedLaunchTargetRecord>,
        before_tab_id: Option<String>,
    ) -> CoreResult<Value> {
        serde_json::to_value(self.apply_embedded_tab_mutation(request, target, before_tab_id)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_embedded_tab_drag_topology_commit(
        &self,
        request: crate::model::RuntimeTabMutationRequestRecord,
        _target: Option<EmbeddedLaunchTargetRecord>,
        source_before_tab_ids: Vec<String>,
        source_after_tab_ids: Vec<String>,
        target_before_tab_ids: Vec<String>,
        target_after_tab_ids: Vec<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _window_sequence = self.embedded_window_sequence.acquire()?;
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let target_window_id = request
            .target_window_id
            .clone()
            .unwrap_or_else(|| request.source_window_id.clone());
        let moved = target_window_id != request.source_window_id;
        let (mut next_runtime, mut next) = {
            let runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            let mut next_runtime = runtime.clone();
            let next = next_runtime
                .invoke(BrowserRuntimeCommand::CommitTabDragTopology {
                tab_id: request.tab_id.clone(),
                source_window_id: request.source_window_id.clone(),
                target_window_id: moved.then_some(target_window_id.clone()),
                source_before_tab_ids,
                source_after_tab_ids,
                target_before_tab_ids,
                target_after_tab_ids,
                })?
                .snapshot;
            (next_runtime, next)
        };
        let source_became_empty = next
            .windows
            .iter()
            .find(|window| window.window_id == request.source_window_id)
            .is_some_and(|window| window.tab_ids.is_empty());
        if source_became_empty {
            next_runtime.invoke(BrowserRuntimeCommand::RemoveWindow {
                window_id: request.source_window_id,
            })?;
            next = next_runtime
                .invoke(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
        }
        let mut runtime = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        *runtime = next_runtime;
        drop(runtime);
        // LiveWindowTabState and the native tab adapter already committed the
        // visible gesture. Replaying the native runtime effect here would create a
        // second topology authority and can compensate a UI state that must not
        // roll back. This command only advances Core's projection; the retained
        // live-window snapshot persists it independently.
        self.emit_browser_statuses();
        Ok(next)
    }

    #[allow(clippy::too_many_arguments)]
    fn serialized_embedded_tab_drag_topology_commit(
        &self,
        request: crate::model::RuntimeTabMutationRequestRecord,
        target: Option<EmbeddedLaunchTargetRecord>,
        source_before_tab_ids: Vec<String>,
        source_after_tab_ids: Vec<String>,
        target_before_tab_ids: Vec<String>,
        target_after_tab_ids: Vec<String>,
    ) -> CoreResult<Value> {
        serde_json::to_value(self.apply_embedded_tab_drag_topology_commit(
            request,
            target,
            source_before_tab_ids,
            source_after_tab_ids,
            target_before_tab_ids,
            target_after_tab_ids,
        )?)
        .map_err(|error| CoreError::Internal(error.to_string()))
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
        let tab = snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == request.tab_id)
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
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
