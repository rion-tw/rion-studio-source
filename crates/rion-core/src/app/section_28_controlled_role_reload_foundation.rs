struct ControlledRoleReloadInvocation {
    accepted_at: String,
    fingerprint: String,
    lifecycle_epoch: u64,
    operation_id: String,
    roles: Vec<crate::model::EmbeddedRoleReloadFenceRecord>,
    started: Instant,
    tab_id: String,
    topology_revision: u64,
    window_generation: u64,
    window_id: String,
}

struct ControlledRoleReloadTerminal {
    failure_code: Option<String>,
    roles: Vec<crate::model::BrowserRoleReloadReceiptRecord>,
    stage: &'static str,
    status: crate::model::SystemRuntimeOperationStatus,
}

struct ControlledRoleReloadEffectFailure {
    cleanup: Option<Box<crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord>>,
    error: CoreError,
}

fn controlled_role_reload_fingerprint(
    tab_id: &str,
    window_id: &str,
    window_generation: u64,
    topology_revision: u64,
    lifecycle_epoch: u64,
) -> String {
    format!(
        "{tab_id}\u{1f}{window_id}\u{1f}{window_generation}\u{1f}{topology_revision}\u{1f}{lifecycle_epoch}"
    )
}

fn controlled_role_reload_valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.trim() == value
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn controlled_role_reload_platform(platform: rion_platform::Platform) -> String {
    match platform {
        rion_platform::Platform::Macos => "macos",
        rion_platform::Platform::Windows => "windows",
    }
    .to_owned()
}

fn controlled_role_reload_summary(
    platform: rion_platform::Platform,
    invocation: &ControlledRoleReloadInvocation,
    terminal: &ControlledRoleReloadTerminal,
) -> crate::model::SystemRuntimeOperationSummaryRecord {
    crate::model::SystemRuntimeOperationSummaryRecord {
        accepted_at: invocation.accepted_at.clone(),
        captured_at: chrono::Utc::now().to_rfc3339(),
        completion_policy: crate::model::OperationCompletionPolicy::EventBound,
        deadline_at: None,
        platform: controlled_role_reload_platform(platform),
        subsystem: crate::model::SystemRuntimeOperationSubsystem::Navigation,
        status: terminal.status,
        stage: terminal.stage.to_owned(),
        completion_scope: crate::model::SystemRuntimeOperationCompletionScope::InputReady,
        operation_id: invocation.operation_id.clone(),
        trigger: "reloadGameWindowTab".to_owned(),
        elapsed_ms: invocation
            .started
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
        timeout_ms: None,
        revision: Some(invocation.topology_revision),
        topology_revision: Some(invocation.topology_revision),
        window_generation: Some(invocation.window_generation),
        lifecycle_epoch: Some(invocation.lifecycle_epoch),
        surface_generation: (terminal.roles.len() == 1)
            .then(|| terminal.roles[0].surface_generation),
        role_id: (terminal.roles.len() == 1).then(|| terminal.roles[0].role_id.clone()),
        tab_id: Some(invocation.tab_id.clone()),
        window_id: Some(invocation.window_id.clone()),
        parent_operation_id: None,
        session_id: None,
        failure_code: terminal.failure_code.clone(),
        rollback_error_count: None,
    }
}

fn controlled_role_reload_error_is_indeterminate(error: &CoreError) -> bool {
    let code = error.code();
    code.contains("UNKNOWN")
        || code.contains("INDETERMINATE")
        || code.contains("QUARANTINE")
        || code.contains("TIMEOUT")
        || code.contains("CLOSED")
        || code.contains("COMPENSATION")
        || code.contains("RECEIPT_INVALID")
        || code.contains("RECEIPT_MISSING")
}

fn controlled_role_reload_native_aggregate(
    roles: &[crate::model::BrowserRoleReloadReceiptRecord],
) -> crate::model::SystemRuntimeOperationStatus {
    use crate::model::SystemRuntimeOperationStatus as Status;
    if roles.is_empty() {
        return Status::Failed;
    }
    if roles
        .iter()
        .any(|role| role.status == Status::Indeterminate)
    {
        return Status::Indeterminate;
    }
    if roles.iter().all(|role| role.status == Status::Applied) {
        return Status::Applied;
    }
    if roles.iter().all(|role| role.status == Status::Superseded) {
        return Status::Superseded;
    }
    if roles.iter().all(|role| role.status == Status::Cancelled) {
        return Status::Cancelled;
    }
    if roles.iter().all(|role| role.status == Status::Failed) {
        return Status::Failed;
    }
    Status::Degraded
}

impl AppCore {
    fn controlled_role_reload_test_fault(&self, stage: &str) -> CoreResult<()> {
        #[cfg(test)]
        {
            let mut fault = self
                .controlled_role_reload_fault_stage
                .lock()
                .map_err(|_| {
                    CoreError::Internal(
                        "controlled reload fault injection lock poisoned".to_owned(),
                    )
                })?;
            if fault.as_deref() == Some(stage) {
                fault.take();
                if stage == "retireSecondTimeout" {
                    return Err(CoreError::Effect {
                        code: "MACRO_INPUT_TIMEOUT".to_owned(),
                        message: "controlled reload injected retirement timeout".to_owned(),
                    });
                }
                return Err(CoreError::Internal(format!(
                    "controlled reload injected {stage} failure"
                )));
            }
        }
        #[cfg(not(test))]
        let _ = stage;
        Ok(())
    }

    fn controlled_role_reload_after_final_admission_test_hook(&self) -> CoreResult<()> {
        #[cfg(test)]
        if let Some(hook) = self
            .controlled_role_reload_after_final_admission_hook
            .lock()
            .map_err(|_| {
                CoreError::Internal(
                    "controlled reload final-admission test hook poisoned".to_owned(),
                )
            })?
            .clone()
        {
            hook();
        }
        Ok(())
    }

    fn controlled_role_reload_before_final_admission_test_hook(&self) -> CoreResult<()> {
        #[cfg(test)]
        if let Some(hook) = self
            .controlled_role_reload_before_final_admission_hook
            .lock()
            .map_err(|_| {
                CoreError::Internal(
                    "controlled reload pre-final-admission test hook poisoned".to_owned(),
                )
            })?
            .clone()
        {
            hook();
        }
        Ok(())
    }

    fn resume_controlled_role_reload_input(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<crate::model::MacroInputEpochRecord> {
        self.controlled_role_reload_test_fault("resume")?;
        self.resume_macro_input(role_id, input_epoch)
    }

    fn resume_controlled_role_reload_after_provisional_restart(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<crate::model::MacroInputEpochRecord> {
        self.controlled_role_reload_test_fault("resume")?;
        let current = self
            .macro_runtime
            .resume_role_input_after_provisional_navigation_restart(role_id, input_epoch)?;
        Ok(crate::model::MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current,
        })
    }

    fn require_controlled_role_reload_restart(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<bool> {
        self.controlled_role_reload_test_fault("restart")?;
        self.require_macro_role_restart_after_navigation_failure(role_id, input_epoch)
    }

    fn finish_controlled_role_reload(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        terminal: ControlledRoleReloadTerminal,
    ) -> CoreResult<crate::model::BrowserTabReloadReceiptRecord> {
        let receipt = crate::model::BrowserTabReloadReceiptRecord {
            receipt: controlled_role_reload_summary(self.platform, invocation, &terminal),
            roles: terminal.roles,
        };
        self.controlled_role_reloads.finish(
            invocation.operation_id.clone(),
            invocation.fingerprint.clone(),
            receipt,
        )
    }

    fn controlled_role_reload_registration_available(&self) -> CoreResult<bool> {
        let registration = self.browser_runtime_registration()?;
        let expected_platform = controlled_role_reload_platform(self.platform);
        Ok(
            self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION
                && registration.available
                && registration.contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION
                && registration.platform == expected_platform
                && registration.engine == crate::model::ResolvedBrowserEngine::Chromium
                && system_capability_available(registration.capabilities.navigation),
        )
    }

    fn controlled_role_reload_owned_roles(
        &self,
        tab_id: &str,
    ) -> CoreResult<Vec<crate::model::EmbeddedRoleReloadFenceRecord>> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let mut roles = snapshot
            .roles
            .iter()
            .filter(|role| {
                role.runtime == "embedded" && role.state == "running" && role.owner.tab_id == tab_id
            })
            .map(|role| crate::model::EmbeddedRoleReloadFenceRecord {
                role_id: role.role_id.clone(),
                owner_generation: role.owner.generation,
                input_epoch: 0,
            })
            .collect::<Vec<_>>();
        roles.sort_by(|left, right| left.role_id.cmp(&right.role_id));
        Ok(roles)
    }

    fn controlled_role_reload_topology_is_exact(
        &self,
        tab_id: &str,
        window_id: &str,
        window_generation: u64,
        topology_revision: u64,
    ) -> CoreResult<bool> {
        let snapshot = self.browser_runtime.snapshot()?;
        Ok(snapshot.windows.get(window_id).is_some_and(|window| {
            window.window_generation == window_generation
                && window.revision == topology_revision
                && window.contains_tab(tab_id)
        }) && snapshot
            .browser_runtime
            .tabs
            .iter()
            .any(|tab| tab.id == tab_id && tab.window_id == window_id))
    }

    fn controlled_role_reload_is_exact(
        &self,
        invocation: &ControlledRoleReloadInvocation,
    ) -> CoreResult<bool> {
        if self.application_suspended.load(Ordering::Acquire)
            || self.application_lifecycle_epoch.load(Ordering::Acquire)
                != invocation.lifecycle_epoch
            || !self
                .controlled_role_reloads
                .is_current(&invocation.operation_id)?
            || !self.controlled_role_reload_topology_is_exact(
                &invocation.tab_id,
                &invocation.window_id,
                invocation.window_generation,
                invocation.topology_revision,
            )?
        {
            return Ok(false);
        }
        let current = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        Ok(invocation.roles.iter().all(|fence| {
            current.roles.iter().any(|role| {
                role.role_id == fence.role_id
                    && role.runtime == "embedded"
                    && role.state == "running"
                    && role.owner.tab_id == invocation.tab_id
                    && role.owner.generation == fence.owner_generation
            })
        }))
    }

    fn controlled_role_reload_supersede_action(
        invocation: &ControlledRoleReloadInvocation,
        reason: &str,
        managed_shortcut_retirements: &[crate::model::ManagedShortcutSurfaceRetirementReceiptRecord],
    ) -> CoreEffectAction {
        CoreEffectAction::EmbeddedSupersedeTabRoleReload {
            reload_operation_id: invocation.operation_id.clone(),
            tab_id: invocation.tab_id.clone(),
            role_ids: invocation
                .roles
                .iter()
                .map(|role| role.role_id.clone())
                .collect(),
            managed_shortcut_retirements: managed_shortcut_retirements.to_vec(),
            reason: reason.to_owned(),
        }
    }
}
