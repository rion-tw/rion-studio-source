const RETAINED_RUNTIME_UI_ACTION_RECEIPTS: usize = 512;

#[derive(Clone)]
struct RuntimeWindowProvisionReceiptEntry {
    fingerprint: String,
    tab_id: String,
    receipt: crate::model::RuntimeWindowProvisionReceiptRecord,
}

#[derive(Default)]
struct RuntimeWindowProvisionReceiptLedger {
    entries: std::collections::HashMap<String, RuntimeWindowProvisionReceiptEntry>,
    order: std::collections::VecDeque<String>,
}

#[derive(Clone)]
struct RuntimeUiActionReceiptEntry {
    fingerprint: String,
    receipt: crate::model::SystemRuntimeOperationSummaryRecord,
}

#[derive(Default)]
struct RuntimeUiActionReceiptLedger {
    active: std::collections::HashMap<String, String>,
    entries: std::collections::HashMap<String, RuntimeUiActionReceiptEntry>,
    order: std::collections::VecDeque<String>,
}

enum RuntimeUiTabAction {
    Activate,
    Hide { hidden: bool },
    Reorder { before_tab_id: Option<String> },
}

struct RuntimeUiSummaryInput {
    accepted_at: String,
    started: Instant,
    operation_id: String,
    trigger: &'static str,
    subsystem: crate::model::SystemRuntimeOperationSubsystem,
    completion_scope: crate::model::SystemRuntimeOperationCompletionScope,
    status: crate::model::SystemRuntimeOperationStatus,
    stage: &'static str,
    window_id: String,
    tab_id: Option<String>,
    window_generation: u64,
    topology_revision: u64,
    failure_code: Option<String>,
}

struct RuntimeUiSupersededSummaryInput {
    accepted_at: String,
    started: Instant,
    operation_id: String,
    trigger: &'static str,
    subsystem: crate::model::SystemRuntimeOperationSubsystem,
    window_id: String,
    tab_id: Option<String>,
    window_generation: u64,
    topology_revision: u64,
}

fn runtime_ui_action_summary(
    platform: rion_platform::Platform,
    input: RuntimeUiSummaryInput,
) -> crate::model::SystemRuntimeOperationSummaryRecord {
    crate::model::SystemRuntimeOperationSummaryRecord {
        accepted_at: input.accepted_at,
        captured_at: chrono::Utc::now().to_rfc3339(),
        completion_policy: crate::model::OperationCompletionPolicy::EventBound,
        deadline_at: None,
        platform: match platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        }
        .to_owned(),
        subsystem: input.subsystem,
        status: input.status,
        stage: input.stage.to_owned(),
        completion_scope: input.completion_scope,
        operation_id: input.operation_id,
        trigger: input.trigger.to_owned(),
        elapsed_ms: input
            .started
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
        timeout_ms: None,
        revision: Some(input.topology_revision),
        topology_revision: Some(input.topology_revision),
        window_generation: Some(input.window_generation),
        lifecycle_epoch: None,
        surface_generation: None,
        role_id: None,
        tab_id: input.tab_id,
        window_id: Some(input.window_id),
        parent_operation_id: None,
        session_id: None,
        failure_code: input.failure_code,
        rollback_error_count: None,
    }
}

fn valid_runtime_ui_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.contains(['/', '\\', '\0'])
        && !value.chars().any(char::is_control)
}

fn runtime_ui_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

impl AppCore {
    fn apply_runtime_window_provision_for_tab_move(
        &self,
        operation_id: String,
        tab_id: String,
        source_window_id: String,
        source_window_generation: u64,
        source_topology_revision: u64,
        proposed: crate::model::RuntimeWindowProvisionTargetRecord,
    ) -> CoreResult<crate::model::RuntimeWindowProvisionReceiptRecord> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&tab_id, &source_window_id])?;
        if proposed.display_id <= 0
            || !proposed.scale_factor.is_finite()
            || proposed.scale_factor <= 0.0
            || !matches!(
                proposed.presentation.as_str(),
                "normal" | "maximized" | "fullscreen"
            )
            || proposed.bounds.width <= 0
            || proposed.bounds.height <= 0
            || proposed.work_area.width <= 0
            || proposed.work_area.height <= 0
        {
            return Err(CoreError::InvalidInput(
                "runtime provision target is invalid".to_owned(),
            ));
        }
        let fingerprint = serde_json::to_string(&(
            &tab_id,
            &source_window_id,
            source_window_generation,
            source_topology_revision,
            &proposed,
        ))
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let _lane = self.embedded_runtime_sequence.acquire()?;
        {
            let ledger = self.runtime_window_provision_receipts.lock().map_err(|_| {
                CoreError::Internal("runtime window provision receipt ledger poisoned".to_owned())
            })?;
            if let Some(entry) = ledger.entries.get(&operation_id) {
                if entry.fingerprint != fingerprint {
                    return Err(runtime_ui_error(
                        "RUNTIME_UI_OPERATION_ID_REUSED",
                        "A runtime provision identity was reused for a different action.",
                    ));
                }
                return Ok(entry.receipt.clone());
            }
        }
        let before = self.browser_runtime.snapshot()?;
        let source = before.windows.get(&source_window_id).ok_or_else(|| {
            runtime_ui_error(
                "RUNTIME_UI_ACTION_STALE",
                "The runtime move source window is no longer live.",
            )
        })?;
        if source.window_generation != source_window_generation
            || source.revision != source_topology_revision
            || !source.contains_tab(&tab_id)
        {
            return Err(runtime_ui_error(
                "RUNTIME_UI_ACTION_STALE",
                "The runtime move source fence is stale.",
            ));
        }
        let window_id = uuid::Uuid::new_v4().to_string();
        let window_generation = before.revision.saturating_add(1).max(1);
        let target = EmbeddedLaunchTargetRecord {
            window_id: window_id.clone(),
            persisted_name: proposed.persisted_name.clone(),
            display_id: proposed.display_id,
            scale_factor: proposed.scale_factor,
            work_area: proposed.work_area.clone(),
            bounds: proposed.bounds.clone(),
            presentation: proposed.presentation.clone(),
        };
        self.apply_runtime_intent(crate::RuntimeIntent::InitializeWindowContext(
            crate::RuntimeWindowContextInitializeInput {
                operation_id: format!("{operation_id}:context"),
                persisted_name: proposed.persisted_name,
                placement: crate::model::GameWindowPlacementRecord {
                    normal_bounds: proposed.bounds,
                    saved_work_area: proposed.work_area,
                    presentation: proposed.presentation,
                },
                target_display: crate::model::DisplayTargetRecord {
                    id: target.display_id,
                    fingerprint: None,
                },
                window_generation,
                window_id: window_id.clone(),
            },
        ))?;
        let reserved = self.browser_runtime.snapshot()?;
        let target_window = reserved.windows.get(&window_id).ok_or_else(|| {
            CoreError::Internal("Core omitted its reserved runtime window".to_owned())
        })?;
        let receipt = crate::model::RuntimeWindowProvisionReceiptRecord {
            operation_id: operation_id.clone(),
            source_window_id: source_window_id.clone(),
            target: target.clone(),
            window_generation: target_window.window_generation,
            topology_revision: target_window.revision,
        };
        let native = self.run_embedded_runtime_effect(
            &tab_id,
            CoreEffectAction::EmbeddedProvisionWindowForTabMove {
                tab_id: tab_id.clone(),
                source_window_id,
                source_window_generation,
                source_topology_revision,
                target,
                target_window_generation: receipt.window_generation,
                target_topology_revision: receipt.topology_revision,
            },
            None,
            Some(&operation_id),
        );
        if let Err(error) = native {
            let _ = self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
                operation_id: format!("{operation_id}:remove-failed-provision"),
                window_id,
            });
            return Err(error);
        }
        let mut ledger = self.runtime_window_provision_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime window provision receipt ledger poisoned".to_owned())
        })?;
        ledger.order.push_back(operation_id.clone());
        ledger.entries.insert(
            operation_id,
            RuntimeWindowProvisionReceiptEntry {
                fingerprint,
                tab_id,
                receipt: receipt.clone(),
            },
        );
        while ledger.order.len() > RETAINED_RUNTIME_UI_ACTION_RECEIPTS {
            if let Some(expired) = ledger.order.pop_front() {
                ledger.entries.remove(&expired);
            }
        }
        Ok(receipt)
    }

    fn resume_runtime_window_provision(
        &self,
        operation_id: String,
        tab_id: String,
    ) -> CoreResult<Option<crate::model::RuntimeWindowProvisionReceiptRecord>> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&tab_id])?;
        let ledger = self.runtime_window_provision_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime window provision receipt ledger poisoned".to_owned())
        })?;
        let Some(entry) = ledger.entries.get(&operation_id) else {
            return Ok(None);
        };
        if entry.tab_id != tab_id {
            return Err(runtime_ui_error(
                "RUNTIME_UI_OPERATION_ID_REUSED",
                "A runtime provision identity was reused for another tab.",
            ));
        }
        Ok(Some(entry.receipt.clone()))
    }

    fn retire_runtime_window_provision(
        &self,
        operation_id: String,
        window_id: String,
        window_generation: u64,
        topology_revision: u64,
    ) -> CoreResult<()> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&window_id])?;
        let _lane = self.embedded_runtime_sequence.acquire()?;
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(window) = snapshot.windows.get(&window_id) else {
            return Ok(());
        };
        if window.window_generation != window_generation
            || window.revision != topology_revision
            || !window.tabs.is_empty()
        {
            return Err(runtime_ui_error(
                "RUNTIME_WINDOW_PROVISION_RETIRE_STALE",
                "The provisional runtime window is no longer empty or exact.",
            ));
        }
        self.run_embedded_runtime_effect(
            &window_id,
            CoreEffectAction::EmbeddedRetireProvisionedWindow {
                window_id: window_id.clone(),
                window_generation,
                topology_revision,
            },
            None,
            Some(&operation_id),
        )?;
        self.apply_runtime_intent(crate::RuntimeIntent::RemoveWindow {
            operation_id,
            window_id,
        })?;
        Ok(())
    }

    fn cached_runtime_ui_action(
        &self,
        operation_id: &str,
        fingerprint: &str,
    ) -> CoreResult<Option<crate::model::SystemRuntimeOperationSummaryRecord>> {
        let ledger = self.runtime_ui_action_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime UI action receipt ledger poisoned".to_owned())
        })?;
        if let Some(entry) = ledger.entries.get(operation_id) {
            if entry.fingerprint != fingerprint {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_OPERATION_ID_REUSED",
                    "A runtime UI operation identity was reused for a different action.",
                ));
            }
            return Ok(Some(entry.receipt.clone()));
        }
        if let Some(active_fingerprint) = ledger.active.get(operation_id)
            && active_fingerprint != fingerprint
        {
            return Err(runtime_ui_error(
                "RUNTIME_UI_OPERATION_ID_REUSED",
                "A runtime UI operation identity was reused for a different action.",
            ));
        }
        Ok(None)
    }

    fn reserve_runtime_ui_action(
        &self,
        operation_id: &str,
        fingerprint: &str,
    ) -> CoreResult<()> {
        let mut ledger = self.runtime_ui_action_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime UI action receipt ledger poisoned".to_owned())
        })?;
        if let Some(entry) = ledger.entries.get(operation_id) {
            let (code, message) = if entry.fingerprint == fingerprint {
                (
                    "RUNTIME_UI_OPERATION_ALREADY_TERMINAL",
                    "A terminal runtime UI operation cannot be admitted again.",
                )
            } else {
                (
                    "RUNTIME_UI_OPERATION_ID_REUSED",
                    "A runtime UI operation identity was reused for a different action.",
                )
            };
            return Err(runtime_ui_error(code, message));
        }
        if let Some(active_fingerprint) = ledger.active.get(operation_id) {
            if active_fingerprint != fingerprint {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_OPERATION_ID_REUSED",
                    "A runtime UI operation identity was reused for a different action.",
                ));
            }
            return Ok(());
        }
        ledger
            .active
            .insert(operation_id.to_owned(), fingerprint.to_owned());
        Ok(())
    }

    fn release_runtime_ui_action(&self, operation_id: &str, fingerprint: &str) -> CoreResult<()> {
        let mut ledger = self.runtime_ui_action_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime UI action receipt ledger poisoned".to_owned())
        })?;
        if ledger
            .active
            .get(operation_id)
            .is_some_and(|active_fingerprint| active_fingerprint == fingerprint)
        {
            ledger.active.remove(operation_id);
        }
        Ok(())
    }

    fn retain_runtime_ui_action(
        &self,
        operation_id: String,
        fingerprint: String,
        receipt: crate::model::SystemRuntimeOperationSummaryRecord,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        let mut ledger = self.runtime_ui_action_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime UI action receipt ledger poisoned".to_owned())
        })?;
        if let Some(entry) = ledger.entries.get(&operation_id) {
            if entry.fingerprint != fingerprint {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_OPERATION_ID_REUSED",
                    "A runtime UI operation identity was reused for a different action.",
                ));
            }
            return Ok(entry.receipt.clone());
        }
        if let Some(active_fingerprint) = ledger.active.get(&operation_id)
            && active_fingerprint != &fingerprint
        {
            return Err(runtime_ui_error(
                "RUNTIME_UI_OPERATION_ID_REUSED",
                "A runtime UI operation identity was reused for a different action.",
            ));
        }
        ledger.active.remove(&operation_id);
        ledger.order.push_back(operation_id.clone());
        ledger.entries.insert(
            operation_id,
            RuntimeUiActionReceiptEntry {
                fingerprint,
                receipt: receipt.clone(),
            },
        );
        while ledger.order.len() > RETAINED_RUNTIME_UI_ACTION_RECEIPTS {
            if let Some(expired) = ledger.order.pop_front() {
                ledger.entries.remove(&expired);
            }
        }
        Ok(receipt)
    }

    fn validate_runtime_ui_action_identity(
        &self,
        operation_id: &str,
        identifiers: &[&str],
    ) -> CoreResult<()> {
        if !valid_runtime_ui_identifier(operation_id)
            || identifiers
                .iter()
                .any(|identifier| !valid_runtime_ui_identifier(identifier))
        {
            return Err(CoreError::InvalidInput(
                "runtime UI action identity is invalid".to_owned(),
            ));
        }
        Ok(())
    }

    fn runtime_ui_superseded_summary(
        &self,
        input: RuntimeUiSupersededSummaryInput,
    ) -> crate::model::SystemRuntimeOperationSummaryRecord {
        runtime_ui_action_summary(
            self.platform,
            RuntimeUiSummaryInput {
                accepted_at: input.accepted_at,
                started: input.started,
                operation_id: input.operation_id,
                trigger: input.trigger,
                subsystem: input.subsystem,
                completion_scope: input.subsystem.default_completion_scope(),
                status: crate::model::SystemRuntimeOperationStatus::Superseded,
                stage: "runtimeUiActionSuperseded",
                window_id: input.window_id,
                tab_id: input.tab_id,
                window_generation: input.window_generation,
                topology_revision: input.topology_revision,
                failure_code: Some("RUNTIME_UI_ACTION_STALE".to_owned()),
            },
        )
    }

    fn persist_runtime_ui_windows(&self, window_ids: &[String]) -> CoreResult<()> {
        let app = self.app_snapshot()?;
        let saved_by_id = app
            .state
            .game_windows
            .iter()
            .map(|window| (window.id.as_str(), window))
            .collect::<std::collections::HashMap<_, _>>();
        let logical_by_id = app
            .logical_windows
            .iter()
            .map(|window| (window.window_id.as_str(), window))
            .collect::<std::collections::HashMap<_, _>>();
        let inputs = window_ids
            .iter()
            .map(|window_id| {
                let Some(saved) = saved_by_id.get(window_id.as_str()) else {
                    return Ok(None);
                };
                let Some(logical) = logical_by_id.get(window_id.as_str()) else {
                    return Ok(None);
                };
                Ok(Some(GameWindowRuntimeSnapshotCommitInputRecord {
                    snapshot: (*logical).clone(),
                    name: saved.name.clone(),
                    target_display: saved.target_display.clone(),
                    placement: saved.placement.clone(),
                }))
            })
            .collect::<CoreResult<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if !inputs.is_empty() {
            // These snapshots were read from RuntimeKernel, the logical authority. A stale shell
            // persistence fence cannot supersede them; the public shell snapshot command retains
            // its strict latest-revision-wins contract.
            self.commit_authoritative_runtime_window_snapshot_batch_inner(inputs)?;
        }
        // Persisted dormant window definitions are seeded into RuntimeKernel so that an
        // explicit restore can reconstruct them. They are not members of the current crash
        // recovery cohort. Retain the shell-authored live set and add only the windows that
        // this visible UI action actually touched.
        let mut live_window_ids = self
            .runtime_restore_session()?
            .live_window_ids
            .unwrap_or_default();
        live_window_ids.extend(
            window_ids
                .iter()
                .filter(|window_id| logical_by_id.contains_key(window_id.as_str()))
                .cloned(),
        );
        live_window_ids.sort();
        live_window_ids.dedup();
        let focused_window_id = window_ids
            .iter()
            .rev()
            .find(|window_id| live_window_ids.contains(window_id))
            .cloned();
        self.update_runtime_restore_session(|session| {
            session.schema_version = 2;
            session.session_generation = session.session_generation.saturating_add(1);
            session.clean_exit = false;
            session.updated_at = chrono::Utc::now().to_rfc3339();
            session.live_window_ids = Some(live_window_ids);
            session.windows.clear();
            if focused_window_id.is_some() {
                session.last_focused_window_id = focused_window_id;
            } else if session
                .last_focused_window_id
                .as_ref()
                .is_some_and(|window_id| {
                    !session
                        .live_window_ids
                        .as_ref()
                        .is_some_and(|live| live.contains(window_id))
                })
            {
                session.last_focused_window_id = None;
            }
        })?;
        Ok(())
    }

    fn compensate_runtime_ui_topology(
        &self,
        operation_id: &str,
        mut prior_windows: Vec<crate::RuntimeLiveWindowRecord>,
    ) -> CoreResult<()> {
        let current = self.browser_runtime.snapshot()?;
        for prior in &mut prior_windows {
            let Some(current_window) = current.windows.get(&prior.window_id) else {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_CORE_COMPENSATION_STALE",
                    "Core lost a runtime window before UI-action compensation.",
                ));
            };
            if current_window.window_generation != prior.window_generation {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_CORE_COMPENSATION_STALE",
                    "Core advanced a runtime-window generation before compensation.",
                ));
            }
            // runtime_ui_window_commit increments this once. Advancing from the
            // current value makes the compensating topology exact and prevents
            // an old callback from rolling back a later renderer intent.
            prior.ui_sequence = current_window.ui_sequence;
        }
        let primary_window_id = prior_windows
            .first()
            .map(|window| window.window_id.clone())
            .ok_or_else(|| {
                runtime_ui_error(
                    "RUNTIME_UI_CORE_COMPENSATION_EMPTY",
                    "A runtime UI compensation had no affected window.",
                )
            })?;
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: format!("{operation_id}:core-compensation"),
                source: "rendererAdapter".to_owned(),
                primary_window_id,
                windows: prior_windows
                    .into_iter()
                    .map(runtime_ui_window_commit)
                    .collect(),
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            return Err(runtime_ui_error(
                "RUNTIME_UI_CORE_COMPENSATION_STALE",
                "A later runtime UI action superseded Core compensation.",
            ));
        }
        // The first native transaction either restored its prior handles or
        // quarantined them. Re-project the compensated Core revision so a
        // restored host advances to the same exact fence; a quarantined or
        // otherwise unknown host keeps this operation indeterminate.
        self.project_embedded_runtime_snapshot_without_persistence(Some(operation_id))?;
        Ok(())
    }

    fn apply_runtime_tab_action(
        &self,
        action: RuntimeUiTabAction,
        operation_id: String,
        tab_id: String,
        window_id: String,
        window_generation: u64,
        topology_revision: u64,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&tab_id, &window_id])?;
        let (trigger, subsystem, fingerprint) = match &action {
            RuntimeUiTabAction::Activate => (
                "showGameWindowTab",
                crate::model::SystemRuntimeOperationSubsystem::TabActivation,
                format!("activate:{window_id}:{window_generation}:{topology_revision}:{tab_id}"),
            ),
            RuntimeUiTabAction::Hide { hidden } => (
                "setGameWindowTabHidden",
                crate::model::SystemRuntimeOperationSubsystem::TabMutation,
                format!(
                    "hide:{window_id}:{window_generation}:{topology_revision}:{tab_id}:{hidden}"
                ),
            ),
            RuntimeUiTabAction::Reorder { before_tab_id } => (
                "reorderGameWindowTab",
                crate::model::SystemRuntimeOperationSubsystem::Drag,
                format!(
                    "reorder:{window_id}:{window_generation}:{topology_revision}:{tab_id}:{}",
                    before_tab_id.as_deref().unwrap_or_default()
                ),
            ),
        };
        if let RuntimeUiTabAction::Reorder {
            before_tab_id: Some(before_tab_id),
        } = &action
        {
            self.validate_runtime_ui_action_identity(&operation_id, &[before_tab_id])?;
            if before_tab_id == &tab_id {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_REORDER_TARGET_INVALID",
                    "A runtime tab cannot be reordered before itself.",
                ));
            }
        }
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) = self.cached_runtime_ui_action(&operation_id, &fingerprint)? {
            return Ok(receipt);
        }
        let accepted_at = chrono::Utc::now().to_rfc3339();
        let started = Instant::now();
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(mut window) = snapshot.windows.get(&window_id).cloned() else {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger,
                subsystem,
                window_id,
                tab_id: Some(tab_id),
                window_generation,
                topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        };
        if window.window_generation != window_generation
            || window.revision != topology_revision
            || !window.contains_tab(&tab_id)
        {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger,
                subsystem,
                window_id,
                tab_id: Some(tab_id),
                window_generation,
                topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        }
        let reload_supersede_reason = match &action {
            RuntimeUiTabAction::Hide { .. } => Some("tabHide"),
            RuntimeUiTabAction::Reorder { .. } => Some("tabMove"),
            RuntimeUiTabAction::Activate => None,
        };
        let reload_admission = if let Some(reason) = reload_supersede_reason {
            let role_ids = self
                .controlled_role_reload_owned_roles(&tab_id)?
                .into_iter()
                .map(|role| role.role_id)
                .collect::<Vec<_>>();
            Some(self.supersede_controlled_role_reloads(&role_ids, reason)?)
        } else {
            None
        };
        let prior_window = window.clone();
        match action {
            RuntimeUiTabAction::Activate => window.selected_tab_id = Some(tab_id.clone()),
            RuntimeUiTabAction::Hide { hidden } => {
                if hidden {
                    window.hidden_tab_ids.insert(tab_id.clone());
                    if window.selected_tab_id.as_deref() == Some(tab_id.as_str()) {
                        window.selected_tab_id = window
                            .tabs
                            .iter()
                            .find(|tab| !window.hidden_tab_ids.contains(&tab.id))
                            .map(|tab| tab.id.clone());
                    }
                } else {
                    window.hidden_tab_ids.remove(&tab_id);
                    window.selected_tab_id = Some(tab_id.clone());
                }
            }
            RuntimeUiTabAction::Reorder { before_tab_id } => {
                let ordered =
                    runtime_ui_reordered_tab_ids(&window, &tab_id, before_tab_id.as_deref())?;
                window.reorder_known_tabs(&ordered);
            }
        }
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: operation_id.clone(),
                source: "rendererAdapter".to_owned(),
                primary_window_id: window_id.clone(),
                windows: vec![runtime_ui_window_commit(window)],
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger,
                subsystem,
                window_id,
                tab_id: Some(tab_id),
                window_generation,
                topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        }
        drop(reload_admission);
        let native =
            self.project_embedded_runtime_snapshot_without_persistence(Some(&operation_id));
        let (status, stage, failure_code) = match native {
            Ok(_) => match self.persist_runtime_ui_windows(std::slice::from_ref(&window_id)) {
                Ok(()) => (
                    crate::model::SystemRuntimeOperationStatus::Applied,
                    "runtimeUiActionApplied",
                    None,
                ),
                Err(error) => (
                    crate::model::SystemRuntimeOperationStatus::Degraded,
                    "runtimeUiPersistenceDegraded",
                    Some(error.code().to_owned()),
                ),
            },
            Err(error) => {
                match self.compensate_runtime_ui_topology(&operation_id, vec![prior_window]) {
                    Ok(()) => (
                        crate::model::SystemRuntimeOperationStatus::Failed,
                        "runtimeUiNativeProjectionCompensated",
                        Some(error.code().to_owned()),
                    ),
                    Err(_) => (
                        crate::model::SystemRuntimeOperationStatus::Indeterminate,
                        "runtimeUiCoreCompensationFailed",
                        Some("RUNTIME_UI_CORE_COMPENSATION_FAILED".to_owned()),
                    ),
                }
            }
        };
        let current = self.browser_runtime.snapshot()?;
        let current_window = current.windows.get(&window_id);
        let receipt = runtime_ui_action_summary(
            self.platform,
            RuntimeUiSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger,
                subsystem,
                completion_scope: subsystem.default_completion_scope(),
                status,
                stage,
                window_id,
                tab_id: Some(tab_id),
                window_generation: current_window
                    .map_or(window_generation, |window| window.window_generation),
                topology_revision: current_window
                    .map_or(topology_revision, |window| window.revision),
                failure_code,
            },
        );
        self.retain_runtime_ui_action(operation_id, fingerprint, receipt)
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_runtime_tab_move_action(
        &self,
        operation_id: String,
        tab_id: String,
        source_window_id: String,
        source_window_generation: u64,
        source_topology_revision: u64,
        target_window_id: String,
        target_window_generation: u64,
        target_topology_revision: u64,
        before_tab_id: Option<String>,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        self.validate_runtime_ui_action_identity(
            &operation_id,
            &[&tab_id, &source_window_id, &target_window_id],
        )?;
        if let Some(before_tab_id) = before_tab_id.as_deref() {
            self.validate_runtime_ui_action_identity(&operation_id, &[before_tab_id])?;
            if before_tab_id == tab_id {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_MOVE_TARGET_INVALID",
                    "A runtime tab cannot be moved before itself.",
                ));
            }
        }
        if source_window_id == target_window_id {
            if source_window_generation != target_window_generation
                || source_topology_revision != target_topology_revision
            {
                return Err(runtime_ui_error(
                    "RUNTIME_UI_MOVE_FENCE_INVALID",
                    "A same-window move carried conflicting window fences.",
                ));
            }
            return self.apply_runtime_tab_action(
                RuntimeUiTabAction::Reorder { before_tab_id },
                operation_id,
                tab_id,
                source_window_id,
                source_window_generation,
                source_topology_revision,
            );
        }
        let fingerprint = format!(
            "move:{source_window_id}:{source_window_generation}:{source_topology_revision}:\
             {target_window_id}:{target_window_generation}:{target_topology_revision}:{tab_id}:{}",
            before_tab_id.as_deref().unwrap_or_default()
        );
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) = self.cached_runtime_ui_action(&operation_id, &fingerprint)? {
            return Ok(receipt);
        }
        let accepted_at = chrono::Utc::now().to_rfc3339();
        let started = Instant::now();
        let snapshot = self.browser_runtime.snapshot()?;
        let source = snapshot.windows.get(&source_window_id).cloned();
        let target = snapshot.windows.get(&target_window_id).cloned();
        let exact = source.as_ref().is_some_and(|source| {
            source.window_generation == source_window_generation
                && source.revision == source_topology_revision
                && source.contains_tab(&tab_id)
        }) && target.as_ref().is_some_and(|target| {
            target.window_generation == target_window_generation
                && target.revision == target_topology_revision
                && !target.contains_tab(&tab_id)
        });
        if !exact {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger: "moveGameWindowTab",
                subsystem: crate::model::SystemRuntimeOperationSubsystem::Drag,
                window_id: target_window_id,
                tab_id: Some(tab_id),
                window_generation: target_window_generation,
                topology_revision: target_topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        }
        let role_ids = self
            .controlled_role_reload_owned_roles(&tab_id)?
            .into_iter()
            .map(|role| role.role_id)
            .collect::<Vec<_>>();
        let reload_admission = self.supersede_controlled_role_reloads(&role_ids, "tabMove")?;
        let mut source = source.expect("validated runtime move source");
        let mut target = target.expect("validated runtime move target");
        let prior_source = source.clone();
        let prior_target = target.clone();
        let tab = source
            .tabs
            .iter()
            .find(|candidate| candidate.id == tab_id)
            .cloned()
            .expect("validated runtime move tab");
        let source_selected = source.selected_tab_id.as_deref() == Some(tab_id.as_str());
        source.tabs.retain(|candidate| candidate.id != tab_id);
        source.hidden_tab_ids.remove(&tab_id);
        if source_selected {
            source.selected_tab_id = source.tab_ids().first().cloned();
        }
        target.tabs.push(tab);
        target.hidden_tab_ids.remove(&tab_id);
        target.selected_tab_id = Some(tab_id.clone());
        let target_order =
            runtime_ui_reordered_tab_ids(&target, &tab_id, before_tab_id.as_deref())?;
        target.reorder_known_tabs(&target_order);
        let commit = self.apply_runtime_intent(crate::RuntimeIntent::CommitTopology(
            crate::RuntimeTopologyCommitInput {
                commit_id: operation_id.clone(),
                source: "rendererAdapter".to_owned(),
                primary_window_id: target_window_id.clone(),
                windows: vec![
                    runtime_ui_window_commit(source),
                    runtime_ui_window_commit(target),
                ],
            },
        ))?;
        if commit.status == crate::RuntimeCommitStatus::Superseded {
            let receipt = self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger: "moveGameWindowTab",
                subsystem: crate::model::SystemRuntimeOperationSubsystem::Drag,
                window_id: target_window_id,
                tab_id: Some(tab_id),
                window_generation: target_window_generation,
                topology_revision: target_topology_revision,
            });
            return self.retain_runtime_ui_action(operation_id, fingerprint, receipt);
        }
        drop(reload_admission);
        let window_ids = vec![source_window_id.clone(), target_window_id.clone()];
        let native =
            self.project_embedded_runtime_snapshot_without_persistence(Some(&operation_id));
        let (status, stage, failure_code) = match native {
            Ok(_) => match self.persist_runtime_ui_windows(&window_ids) {
                Ok(()) => (
                    crate::model::SystemRuntimeOperationStatus::Applied,
                    "runtimeTabMoveApplied",
                    None,
                ),
                Err(error) => (
                    crate::model::SystemRuntimeOperationStatus::Degraded,
                    "runtimeTabMovePersistenceDegraded",
                    Some(error.code().to_owned()),
                ),
            },
            Err(error) => match self
                .compensate_runtime_ui_topology(&operation_id, vec![prior_source, prior_target])
            {
                Ok(()) => (
                    crate::model::SystemRuntimeOperationStatus::Failed,
                    "runtimeTabMoveNativeProjectionCompensated",
                    Some(error.code().to_owned()),
                ),
                Err(_) => (
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    "runtimeTabMoveCoreCompensationFailed",
                    Some("RUNTIME_UI_CORE_COMPENSATION_FAILED".to_owned()),
                ),
            },
        };
        let current = self.browser_runtime.snapshot()?;
        let target = current.windows.get(&target_window_id);
        let receipt = runtime_ui_action_summary(
            self.platform,
            RuntimeUiSummaryInput {
                accepted_at,
                started,
                operation_id: operation_id.clone(),
                trigger: "moveGameWindowTab",
                subsystem: crate::model::SystemRuntimeOperationSubsystem::Drag,
                completion_scope:
                    crate::model::SystemRuntimeOperationCompletionScope::DragCommitted,
                status,
                stage,
                window_id: target_window_id,
                tab_id: Some(tab_id),
                window_generation: target
                    .map_or(target_window_generation, |window| window.window_generation),
                topology_revision: target
                    .map_or(target_topology_revision, |window| window.revision),
                failure_code,
            },
        );
        self.retain_runtime_ui_action(operation_id, fingerprint, receipt)
    }

    fn apply_runtime_window_visibility_action(
        &self,
        operation_id: String,
        window_id: String,
        window_generation: u64,
        topology_revision: u64,
        visible: bool,
    ) -> CoreResult<crate::model::SystemRuntimeOperationSummaryRecord> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&window_id])?;
        let fingerprint =
            format!("visibility:{window_id}:{window_generation}:{topology_revision}:{visible}");
        let lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) = self.cached_runtime_ui_action(&operation_id, &fingerprint)? {
            drop(lane);
            return Ok(receipt);
        }
        let owner = match self
            .runtime_ui_window_visibility_replay
            .admit(&operation_id, &fingerprint)?
        {
            crate::runtime_window_visibility_replay::VisibilityReplayAdmission::Terminal(
                result,
            ) => {
                drop(lane);
                return crate::runtime_window_visibility_replay::visibility_replay_result(result);
            }
            crate::runtime_window_visibility_replay::VisibilityReplayAdmission::Join => {
                drop(lane);
                return self
                    .runtime_ui_window_visibility_replay
                    .wait_terminal(&operation_id, &fingerprint);
            }
            crate::runtime_window_visibility_replay::VisibilityReplayAdmission::Owner(owner) => {
                self.reserve_runtime_ui_action(&operation_id, &fingerprint)?;
                owner
            }
        };
        let result = (|| {
            let accepted_at = chrono::Utc::now().to_rfc3339();
            let started = Instant::now();
            let lifecycle_epoch = self.application_lifecycle_epoch.load(Ordering::Acquire);
            let snapshot = self.browser_runtime.snapshot()?;
            if snapshot.windows.get(&window_id).is_none_or(|window| {
                window.window_generation != window_generation
                    || window.revision != topology_revision
            }) {
                let mut receipt =
                    self.runtime_ui_superseded_summary(RuntimeUiSupersededSummaryInput {
                        accepted_at,
                        started,
                        operation_id: operation_id.clone(),
                        trigger: if visible {
                            "showGameWindow"
                        } else {
                            "hideGameWindow"
                        },
                        subsystem: crate::model::SystemRuntimeOperationSubsystem::Presentation,
                        window_id: window_id.clone(),
                        tab_id: None,
                        window_generation,
                        topology_revision,
                    });
                receipt.lifecycle_epoch = Some(lifecycle_epoch);
                return self.retain_runtime_ui_action(
                    operation_id.clone(),
                    fingerprint.clone(),
                    receipt,
                );
            }
            let mut pending = self.start_runtime_window_visibility_native(
                &operation_id,
                &window_id,
                window_generation,
                topology_revision,
                lifecycle_epoch,
                None,
                visible,
            )?;
            let dispatch = pending.wait_for_dispatch();
            drop(lane);
            let native = self.finish_dispatched_runtime_window_visibility_native(pending, dispatch);
            let (status, stage, failure_code) = match native {
                Ok(receipt) if receipt.status == "applied" => (
                    crate::model::SystemRuntimeOperationStatus::Applied,
                    "runtimeWindowVisibilityApplied",
                    None,
                ),
                Ok(_) => (
                    crate::model::SystemRuntimeOperationStatus::Superseded,
                    "runtimeWindowVisibilitySuperseded",
                    None,
                ),
                Err(error) if runtime_window_visibility_host_was_quarantined(&error) => {
                    match self.reconcile_runtime_window_visibility_quarantine(
                        &operation_id,
                        &window_id,
                        window_generation,
                        topology_revision,
                    ) {
                        Ok(()) => (
                            crate::model::SystemRuntimeOperationStatus::Failed,
                            "runtimeWindowVisibilityFailed",
                            Some(error.code().to_owned()),
                        ),
                        Err(reconciliation_error) => (
                            crate::model::SystemRuntimeOperationStatus::Indeterminate,
                            "runtimeWindowVisibilityFailed",
                            Some(reconciliation_error.code().to_owned()),
                        ),
                    }
                }
                Err(error) => (
                    if runtime_window_visibility_native_failure_is_indeterminate(&error) {
                        crate::model::SystemRuntimeOperationStatus::Indeterminate
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    },
                    "runtimeWindowVisibilityFailed",
                    Some(error.code().to_owned()),
                ),
            };
            let mut receipt = runtime_ui_action_summary(
                self.platform,
                RuntimeUiSummaryInput {
                    accepted_at,
                    started,
                    operation_id: operation_id.clone(),
                    trigger: if visible {
                        "showGameWindow"
                    } else {
                        "hideGameWindow"
                    },
                    subsystem: crate::model::SystemRuntimeOperationSubsystem::Presentation,
                    completion_scope:
                        crate::model::SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
                    status,
                    stage,
                    window_id: window_id.clone(),
                    tab_id: None,
                    window_generation,
                    topology_revision,
                    failure_code,
                },
            );
            receipt.lifecycle_epoch = Some(lifecycle_epoch);
            self.retain_runtime_ui_action(operation_id.clone(), fingerprint.clone(), receipt)
        })();
        let replay_result = finish_runtime_window_visibility_replay(owner, result);
        self.release_runtime_ui_action(&operation_id, &fingerprint)?;
        replay_result
    }
}

fn runtime_ui_window_commit(
    window: crate::RuntimeLiveWindowRecord,
) -> crate::RuntimeWindowTopologyCommit {
    crate::RuntimeWindowTopologyCommit {
        active_tab_id: window.selected_tab_id,
        hidden_tab_ids: window.hidden_tab_ids,
        tabs: window.tabs,
        ui_sequence: window.ui_sequence.saturating_add(1).max(1),
        window_generation: window.window_generation,
        window_id: window.window_id,
    }
}

fn runtime_ui_reordered_tab_ids(
    window: &crate::RuntimeLiveWindowRecord,
    tab_id: &str,
    before_tab_id: Option<&str>,
) -> CoreResult<Vec<String>> {
    let mut ordered = window.all_tab_ids();
    let Some(current_index) = ordered.iter().position(|candidate| candidate == tab_id) else {
        return Err(runtime_ui_error(
            "RUNTIME_UI_TAB_STALE",
            "The runtime tab is no longer attached to the expected window.",
        ));
    };
    ordered.remove(current_index);
    let insertion_index = match before_tab_id {
        Some(before_tab_id) => ordered
            .iter()
            .position(|candidate| candidate == before_tab_id)
            .ok_or_else(|| {
                runtime_ui_error(
                    "RUNTIME_UI_REORDER_TARGET_INVALID",
                    "The runtime reorder target is not an exact sibling tab.",
                )
            })?,
        None => ordered.len(),
    };
    ordered.insert(insertion_index, tab_id.to_owned());
    Ok(ordered)
}
