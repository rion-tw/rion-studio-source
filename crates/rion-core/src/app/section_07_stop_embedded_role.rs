impl AppCore {
    fn stop_embedded_role(&self, role_id: &str) -> CoreResult<()> {
        self.stop_embedded_role_with_operation_lease(role_id, true, false, false, None)
    }

    fn stop_embedded_role_under_active_lease(&self, role_id: &str) -> CoreResult<()> {
        self.stop_embedded_role_with_operation_lease(role_id, false, false, false, None)
    }

    fn stop_embedded_role_with_operation_lease(
        &self,
        role_id: &str,
        acquire_operation_lease: bool,
        close_role_tab: bool,
        persist_closed_tab: bool,
        parent_operation_id: Option<&str>,
    ) -> CoreResult<()> {
        let initial_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let initial_tab_id = initial_snapshot
            .roles
            .iter()
            .find(|candidate| candidate.role_id == role_id && candidate.runtime == "embedded")
            .map(|role| role.owner.tab_id.clone());
        let initial_window_id = initial_tab_id.as_deref().and_then(|tab_id| {
            initial_snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .map(|tab| tab.window_id.clone())
        });
        let logical_close_operation_id = parent_operation_id.map_or_else(
            || format!("role-stop:{role_id}:{}", uuid::Uuid::new_v4()),
            str::to_owned,
        );
        let reload_admission =
            self.supersede_controlled_role_reloads(&[role_id.to_owned()], "tabStop")?;
        self.cancel_embedded_operations(&[role_id.to_owned()])?;
        let lease = acquire_operation_lease
            .then(|| {
                self.browser_operations.acquire(BrowserOperationRequest {
                    role_ids: vec![role_id.to_owned()],
                    kind: "normal".to_owned(),
                })
            })
            .transpose()?;
        let result = (|| {
            let logical_close = if close_role_tab {
                match (initial_tab_id.as_deref(), initial_window_id.as_deref()) {
                    (Some(tab_id), Some(window_id)) => self.prepare_runtime_logical_close(
                        &logical_close_operation_id,
                        window_id,
                        None,
                        None,
                        tab_id,
                        None,
                    )?,
                    _ => None,
                }
            } else {
                None
            };
            let prepared = {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let snapshot = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot;
                let role = snapshot
                    .roles
                    .iter()
                    .find(|candidate| {
                        candidate.role_id == role_id && candidate.runtime == "embedded"
                    })
                    .cloned();
                if let Some(role) = role {
                    let tab_id = role.owner.tab_id.clone();
                    // Cancellation is a fence, not a synchronous worker join. Native
                    // isolation must never wait for the macro cleanup timeout.
                    self.macro_runtime.request_stop_role(role_id)?;
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                        role_id: role_id.to_owned(),
                        runtime: "embedded".to_owned(),
                        tab_id: tab_id.clone(),
                        slot_id: Some(role.owner.slot_id.clone()),
                        state: "stopping".to_owned(),
                        launched_at: role.launched_at.clone(),
                    })?;
                    let action = if close_role_tab {
                        CoreEffectAction::EmbeddedDestroyTab {
                            tab_id: tab_id.clone(),
                            attempt_generation: None,
                            next_active_tab_id: None,
                        }
                    } else {
                        CoreEffectAction::EmbeddedDestroyRole {
                            role_id: role_id.to_owned(),
                        }
                    };
                    Some((tab_id, action))
                } else {
                    None
                }
            };
            drop(reload_admission);

            let Some((tab_id, action)) = prepared else {
                if let Some(tab_id) = initial_tab_id.as_deref() {
                    let action = if close_role_tab {
                        CoreEffectAction::EmbeddedDestroyTab {
                            tab_id: tab_id.to_owned(),
                            attempt_generation: None,
                            next_active_tab_id: None,
                        }
                    } else {
                        CoreEffectAction::EmbeddedDestroyRole {
                            role_id: role_id.to_owned(),
                        }
                    };
                    let native_close = self.run_embedded_runtime_effect(
                        role_id,
                        action,
                        None,
                        parent_operation_id,
                    );
                    match native_close {
                        Ok(_) => {
                            if let Some(close) = logical_close.as_ref() {
                                self.finish_runtime_logical_close(close, "closed")?;
                            }
                        }
                        Err(error) => {
                            if let Some(close) = logical_close.as_ref() {
                                let _ = self.finish_runtime_logical_close(close, "failed");
                            }
                            return Err(error);
                        }
                    }
                    if close_role_tab {
                        let _sequence = self.embedded_runtime_sequence.acquire()?;
                        let current = self
                            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                            .snapshot;
                        if current.tabs.iter().any(|tab| {
                            tab.id == tab_id && tab.tab_type == "role" && tab.source_id == role_id
                        }) {
                            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                                tab_id: tab_id.to_owned(),
                            })?;
                        }
                    }
                    self.macro_runtime.release_role(role_id)?;
                }
                return Ok(());
            };

            // Native isolation is the safety boundary. Persistence is committed
            // after the exact game surface is offline; a busy SQLite writer must
            // never leave a visually closed role running.
            self.emit_browser_statuses();
            let native_close =
                self.run_embedded_runtime_effect(role_id, action, None, parent_operation_id);
            match native_close {
                Ok(_) => {
                    if let Some(close) = logical_close.as_ref() {
                        self.finish_runtime_logical_close(close, "closed")?;
                    }
                }
                Err(error) => {
                    if let Some(close) = logical_close.as_ref() {
                        let _ = self.finish_runtime_logical_close(close, "failed");
                    }
                    return Err(error);
                }
            }

            {
                let _sequence = self.embedded_runtime_sequence.acquire()?;
                let current = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot;
                if current
                    .roles
                    .iter()
                    .find(|candidate| candidate.role_id == role_id)
                    .is_none_or(|candidate| {
                        candidate.owner.tab_id != tab_id || candidate.state != "stopping"
                    })
                {
                    return Err(CoreError::Domain {
                        code: "SYSTEM_SURFACE_CLOSE_STALE",
                        message: "The role changed before its close transaction committed."
                            .to_owned(),
                    });
                }
                self.invoke_browser_runtime(BrowserRuntimeCommand::ReleaseRole {
                    role_id: role_id.to_owned(),
                    expected_tab_id: Some(tab_id.clone()),
                })?;
                if close_role_tab {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                        tab_id: tab_id.clone(),
                    })?;
                }
            }
            self.macro_runtime.release_role(role_id)?;
            if close_role_tab {
                if persist_closed_tab {
                    self.commit_embedded_runtime_snapshot_without_native_effect(
                        &std::collections::HashSet::new(),
                    )?;
                } else {
                    self.browser_runtime_snapshot_without_persistence()?;
                }
            } else {
                self.project_embedded_runtime_snapshot_without_persistence(parent_operation_id)?;
            }
            Ok(())
        })();
        let result = result.and_then(|()| {
            if close_role_tab {
                self.project_surviving_chromium_window_after_close(
                    initial_window_id.as_deref(),
                    parent_operation_id,
                )?;
            }
            Ok(())
        });
        let Some(lease) = lease else {
            return result;
        };
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }
}
