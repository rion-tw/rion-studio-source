struct ChromiumWorkspaceWebSurfaceFailureInput {
    operation_id: String,
    surface_id: String,
    surface_generation: u64,
    tab_id: String,
    window_id: String,
    expected_attempt_generation: String,
    expected_window_generation: u64,
}

struct ChromiumWorkspaceWebNavigationCommitInput {
    operation_id: String,
    surface_id: String,
    surface_generation: u64,
    slot_id: String,
    tab_id: String,
    window_id: String,
    expected_attempt_generation: String,
    expected_window_generation: u64,
    url: String,
}

impl AppCore {
    fn commit_chromium_workspace_web_navigation(
        &self,
        input: ChromiumWorkspaceWebNavigationCommitInput,
    ) -> CoreResult<crate::model::BrowserWorkspaceWebNavigationCommitReceiptRecord> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_WORKSPACE_WEB_NAVIGATION_UNAVAILABLE",
                "Workspace Web navigation continuation requires Chromium runtime contract v25.",
            ));
        }
        let operation_id = crate::OperationId::new(input.operation_id)
            .map_err(CoreError::InvalidInput)?
            .into_string();
        let last_url = if input.url == "rion-start://home/" {
            None
        } else {
            Some(crate::domain::normalize_workspace_web_last_url(&input.url)?)
        };
        if input.surface_id.trim().is_empty()
            || input.slot_id.trim().is_empty()
            || input.expected_attempt_generation.trim().is_empty()
            || input.surface_generation < 1
            || input.expected_window_generation < 1
        {
            return Err(CoreError::InvalidInput(
                "Chromium Workspace Web navigation identity is invalid.".to_owned(),
            ));
        }
        let superseded = || crate::model::BrowserWorkspaceWebNavigationCommitReceiptRecord {
            operation_id: operation_id.clone(),
            status: "superseded".to_owned(),
            durable: false,
            window_id: input.window_id.clone(),
            tab_id: input.tab_id.clone(),
            slot_id: input.slot_id.clone(),
            last_url: last_url.clone(),
        };
        let _lane = self.embedded_runtime_sequence.acquire()?;
        let before = self.browser_runtime.snapshot()?;
        let Some(window) = before.windows.get(&input.window_id) else {
            return Ok(superseded());
        };
        let Some(tab) = window.tabs.iter().find(|tab| tab.id == input.tab_id) else {
            return Ok(superseded());
        };
        let Some(browser_tab) = before
            .browser_runtime
            .tabs
            .iter()
            .find(|tab| tab.id == input.tab_id && tab.window_id == input.window_id)
        else {
            return Ok(superseded());
        };
        let exact_surface = browser_tab.web_surfaces.iter().any(|surface| {
            surface.surface_id == input.surface_id && surface.slot_id == input.slot_id
        });
        if window.window_generation != input.expected_window_generation
            || tab.tab_type != "workspace"
            || browser_tab.tab_type != "workspace"
            || browser_tab.attempt_generation.as_deref()
                != Some(input.expected_attempt_generation.as_str())
            || !exact_surface
        {
            return Ok(superseded());
        }
        let workspace_id = browser_tab.source_id.clone();
        let mut workspace_slots = tab.workspace_slots.clone();
        let Some(slot) = workspace_slots
            .iter_mut()
            .find(|slot| slot.id == input.slot_id && slot.web.is_some())
        else {
            return Ok(superseded());
        };
        slot.web.as_mut().expect("validated Web slot").last_url = last_url.clone();
        let runtime_commit =
            self.apply_runtime_intent(crate::RuntimeIntent::ReplaceTabWorkspaceSlots {
                expected_revision: Some(window.revision),
                operation_id: operation_id.clone(),
                tab_id: input.tab_id.clone(),
                window_id: input.window_id.clone(),
                workspace_slots,
            })?;
        if runtime_commit.status == crate::RuntimeCommitStatus::Superseded {
            return Ok(superseded());
        }
        let persisted = self.mutate_state(StateMutation::WorkspaceWebNavigationCommit {
            workspace_id,
            slot_id: input.slot_id.clone(),
            window_id: input.window_id.clone(),
            tab_id: input.tab_id.clone(),
            last_url: last_url.clone(),
        });
        let persisted = match persisted {
            Ok(value) => value,
            Err(CoreError::Domain {
                code: "WORKSPACE_WEB_NAVIGATION_STALE",
                ..
            }) => {
                return Ok(superseded());
            }
            Err(error) => return Err(error),
        };
        let status = persisted
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("applied")
            .to_owned();
        Ok(
            crate::model::BrowserWorkspaceWebNavigationCommitReceiptRecord {
                operation_id,
                status,
                durable: true,
                window_id: input.window_id,
                tab_id: input.tab_id,
                slot_id: input.slot_id,
                last_url,
            },
        )
    }

    fn ensure_chromium_launch_window_context(
        &self,
        tab: &EmbeddedTabEffectRecord,
        window: &crate::runtime_kernel::RuntimeLiveWindowRecord,
    ) -> CoreResult<crate::runtime_kernel::RuntimeLiveWindowRecord> {
        if window.window_generation < 1
            || window.window_id != tab.target.window_id
            || !window.contains_tab(&tab.tab_id)
        {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_LAUNCH_WINDOW_CONTEXT_STALE",
                "The Chromium launch window identity changed before native creation.",
            ));
        }

        let needs_context = window.placement.is_none()
            || window.target_display.is_none()
            || (window.persisted_name.is_none() && tab.target.persisted_name.is_some());
        if needs_context {
            let commit =
                self.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
                    crate::RuntimeWindowContextInitializeInput {
                        operation_id: format!(
                            "chromium-launch-window-context:{}:{}",
                            tab.target.window_id,
                            tab.attempt_generation.as_deref().unwrap_or(&tab.tab_id),
                        ),
                        persisted_name: tab.target.persisted_name.clone(),
                        placement: crate::model::GameWindowPlacementRecord {
                            normal_bounds: tab.target.bounds.clone(),
                            saved_work_area: tab.target.work_area.clone(),
                            presentation: tab.target.presentation.clone(),
                        },
                        target_display: crate::model::DisplayTargetRecord {
                            id: tab.target.display_id,
                            fingerprint: None,
                        },
                        window_generation: window.window_generation,
                        window_id: tab.target.window_id.clone(),
                    },
                ))?;
            if commit.status == crate::RuntimeCommitStatus::Superseded {
                return Err(chromium_launch_window_context_error(
                    "CHROMIUM_LAUNCH_WINDOW_CONTEXT_STALE",
                    "The Chromium launch window generation changed before native creation.",
                ));
            }
        }

        let snapshot = self.browser_runtime.snapshot()?;
        let current = snapshot.windows.get(&tab.target.window_id).ok_or_else(|| {
            chromium_launch_window_context_error(
                "CHROMIUM_LAUNCH_WINDOW_CONTEXT_STALE",
                "The Chromium launch window retired before native creation.",
            )
        })?;
        if current.window_generation != window.window_generation
            || !current.contains_tab(&tab.tab_id)
        {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_LAUNCH_WINDOW_CONTEXT_STALE",
                "The Chromium launch window or tab changed before native creation.",
            ));
        }
        if current.placement.is_none()
            || current.target_display.is_none()
            || (tab.target.persisted_name.is_some() && current.persisted_name.is_none())
        {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_LAUNCH_WINDOW_CONTEXT_MISSING",
                "The Chromium launch window has no complete target context for native creation.",
            ));
        }
        Ok(current.clone())
    }

    fn complete_chromium_runtime_launch(
        &self,
        tab_id: &str,
        loaded_role_ids: &[String],
    ) -> CoreResult<bool> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION {
            return Ok(false);
        }
        let topology_changed = {
            let _authority_guard = self.runtime_authority_barrier.write().map_err(|_| {
                CoreError::Internal("runtime authority barrier poisoned".to_owned())
            })?;
            let snapshot = self.browser_runtime.snapshot()?;
            let activation = snapshot.tab_activations.get(tab_id).ok_or_else(|| {
                chromium_launch_window_context_error(
                    "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                    "The Chromium tab activation retired before launch completion.",
                )
            })?;
            if loaded_role_ids.iter().any(|role_id| {
                !snapshot.browser_runtime.roles.iter().any(|role| {
                    role.role_id == *role_id
                        && role.runtime == "embedded"
                        && role.owner.tab_id == tab_id
                })
            }) {
                return Err(chromium_launch_window_context_error(
                    "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                    "A loaded Chromium Role lost its exact tab owner before launch completion.",
                ));
            }
            if matches!(
                activation.phase,
                crate::model::RuntimeTabActivationPhaseRecord::Dormant
                    | crate::model::RuntimeTabActivationPhaseRecord::Failed
            ) {
                return Err(CoreError::Domain {
                    code: "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                    message: "The Chromium tab activation changed before launch completion."
                        .to_owned(),
                });
            }
            let mut topology_changed = false;
            if matches!(
                activation.phase,
                crate::model::RuntimeTabActivationPhaseRecord::Activating
                    | crate::model::RuntimeTabActivationPhaseRecord::Attaching
                    | crate::model::RuntimeTabActivationPhaseRecord::Loading
            ) {
                let commit =
                    self.browser_runtime
                        .apply(crate::RuntimeIntent::SetTabActivationPhase {
                            activation_attempt_id: activation.attempt_id.clone(),
                            operation_id: format!(
                                "chromium-launch-ready:{}:{}",
                                tab_id,
                                activation.attempt_id.as_str()
                            ),
                            phase: crate::model::RuntimeTabActivationPhaseRecord::Ready,
                            tab_id: crate::RuntimeTabId::new(tab_id.to_owned())
                                .map_err(CoreError::InvalidInput)?,
                        })?;
                if commit.status == crate::RuntimeCommitStatus::Superseded {
                    return Err(CoreError::Domain {
                        code: "CHROMIUM_LAUNCH_ACTIVATION_STALE",
                        message: "The Chromium tab activation changed before launch completion."
                            .to_owned(),
                    });
                }
                topology_changed = commit.status == crate::RuntimeCommitStatus::Applied;
            }
            {
                let mut issues = self.browser_runtime_issues.write().map_err(|_| {
                    CoreError::Internal("browser runtime issue lock poisoned".to_owned())
                })?;
                for role_id in loaded_role_ids {
                    issues.remove(role_id);
                }
            }
            self.browser_runtime_ready_roles
                .write()
                .map_err(|_| {
                    CoreError::Internal("browser runtime readiness lock poisoned".to_owned())
                })?
                .extend(loaded_role_ids.iter().cloned());
            topology_changed
        };
        Ok(topology_changed)
    }

    fn degrade_chromium_runtime_role_failure_activation(
        &self,
        _authority_guard: &std::sync::RwLockWriteGuard<'_, ()>,
        role_id: &str,
        tab_id: &str,
        window_id: &str,
        owner_generation: u64,
    ) -> CoreResult<bool> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION {
            return Ok(false);
        }
        let snapshot = self.browser_runtime.snapshot()?;
        let window = snapshot.windows.get(window_id).ok_or_else(|| {
            chromium_launch_window_context_error(
                "RUNTIME_ROLE_OWNER_STALE",
                "The failed Chromium role window is no longer live.",
            )
        })?;
        let activation = snapshot.tab_activations.get(tab_id).ok_or_else(|| {
            chromium_launch_window_context_error(
                "RUNTIME_ROLE_OWNER_STALE",
                "The failed Chromium role tab has no current activation.",
            )
        })?;
        if !window.contains_tab(tab_id)
            || activation.owner_window_id != window_id
            || activation.window_generation.0 != window.window_generation
        {
            return Err(chromium_launch_window_context_error(
                "RUNTIME_ROLE_OWNER_STALE",
                "The failed Chromium role lost its exact tab activation owner.",
            ));
        }
        let commit = self
            .browser_runtime
            .apply(crate::RuntimeIntent::SetTabActivationPhase {
                activation_attempt_id: activation.attempt_id.clone(),
                operation_id: format!(
                    "chromium-role-surface-failed:{role_id}:{owner_generation}:{}",
                    activation.attempt_id.as_str()
                ),
                phase: crate::model::RuntimeTabActivationPhaseRecord::Degraded,
                tab_id: crate::RuntimeTabId::new(tab_id.to_owned())
                    .map_err(CoreError::InvalidInput)?,
            })?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Err(chromium_launch_window_context_error(
                "RUNTIME_ROLE_OWNER_STALE",
                "The Chromium role activation changed before failure commit.",
            ));
        }
        Ok(true)
    }

    fn report_chromium_workspace_web_surface_failed(
        &self,
        input: ChromiumWorkspaceWebSurfaceFailureInput,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_WORKSPACE_WEB_FAILURE_UNAVAILABLE",
                "Workspace Web failure authority requires Chromium runtime contract v23.",
            ));
        }
        let operation_id = crate::OperationId::new(input.operation_id)
            .map_err(CoreError::InvalidInput)?
            .into_string();
        let tab_id = crate::RuntimeTabId::new(input.tab_id).map_err(CoreError::InvalidInput)?;
        if input.surface_id.trim().is_empty()
            || input.expected_attempt_generation.trim().is_empty()
            || input.surface_generation < 1
            || input.expected_window_generation < 1
        {
            return Err(CoreError::InvalidInput(
                "Chromium Workspace Web failure identity is invalid.".to_owned(),
            ));
        }
        let before = self.browser_runtime.snapshot()?;
        let window = before.windows.get(&input.window_id).ok_or_else(|| {
            chromium_launch_window_context_error(
                "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
                "The failed Workspace Web window is no longer live.",
            )
        })?;
        let browser_tab = before
            .browser_runtime
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id.as_str() && tab.window_id == input.window_id)
            .ok_or_else(|| {
                chromium_launch_window_context_error(
                    "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
                    "The failed Workspace Web tab is no longer live.",
                )
            })?;
        let activation = before.tab_activations.get(tab_id.as_str()).ok_or_else(|| {
            chromium_launch_window_context_error(
                "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
                "The failed Workspace Web tab has no current activation.",
            )
        })?;
        if window.window_generation != input.expected_window_generation
            || activation.owner_window_id != input.window_id
            || activation.window_generation.0 != input.expected_window_generation
            || browser_tab.tab_type != "workspace"
            || browser_tab.attempt_generation.as_deref()
                != Some(input.expected_attempt_generation.as_str())
            || !browser_tab
                .web_surfaces
                .iter()
                .any(|surface| surface.surface_id == input.surface_id)
        {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
                "The failed Workspace Web surface lost its exact Core owner.",
            ));
        }
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::SetTabActivationPhase {
            activation_attempt_id: activation.attempt_id.clone(),
            operation_id,
            phase: crate::model::RuntimeTabActivationPhaseRecord::Degraded,
            tab_id,
        })?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Err(chromium_launch_window_context_error(
                "CHROMIUM_WORKSPACE_WEB_FAILURE_STALE",
                "The Workspace Web activation changed before failure commit.",
            ));
        }
        self.project_embedded_runtime_snapshot_without_persistence(None)
    }
}

fn chromium_launch_window_context_error(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}
