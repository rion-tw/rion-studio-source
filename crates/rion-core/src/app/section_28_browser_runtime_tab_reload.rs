impl AppCore {
    fn controlled_role_reload_cleanup_released(
        receipt: &crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord,
    ) -> bool {
        receipt.status == crate::model::SystemRuntimeOperationStatus::Applied
            && receipt.roles.iter().all(|role| {
                role.status == crate::model::SystemRuntimeOperationStatus::Applied
                    && role.submission_state == "notSubmitted"
                    && role.native_input_resumed
                    && !role.restart_required
            })
    }

    fn controlled_role_reload_role_owner_is_exact(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        fence: &crate::model::EmbeddedRoleReloadFenceRecord,
    ) -> CoreResult<bool> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        Ok(snapshot.roles.iter().any(|role| {
            role.role_id == fence.role_id
                && role.runtime == "embedded"
                && role.state == "running"
                && role.owner.tab_id == invocation.tab_id
                && role.owner.generation == fence.owner_generation
        }))
    }

    fn controlled_role_reload_resume_allowed(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        fence: &crate::model::EmbeddedRoleReloadFenceRecord,
        superseded_reason: Option<&str>,
    ) -> CoreResult<bool> {
        match superseded_reason {
            None => self.controlled_role_reload_is_exact(invocation),
            Some("tabMove" | "tabHide") => Ok(!self.application_suspended.load(Ordering::Acquire)
                && self.application_lifecycle_epoch.load(Ordering::Acquire)
                    == invocation.lifecycle_epoch
                && self.controlled_role_reload_role_owner_is_exact(invocation, fence)?),
            Some(
                "replacementReload"
                | "tabStop"
                | "windowClose"
                | "applicationLifecycle"
                | "surfaceRecovery",
            ) => Ok(false),
            Some(_) => Ok(false),
        }
    }

    fn controlled_role_reload_preadmit_terminal(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        error: &CoreError,
        stage: &'static str,
    ) -> ControlledRoleReloadTerminal {
        let mut roles = Vec::with_capacity(invocation.roles.len());
        for fence in &invocation.roles {
            let mut status = crate::model::SystemRuntimeOperationStatus::Failed;
            let mut core_input_resumed = false;
            let mut restart_required = false;
            let mut failure_code = Some(error.code().to_owned());
            if fence.input_epoch > 0 {
                match self.controlled_role_reload_role_owner_is_exact(invocation, fence) {
                    Ok(true) => match self
                        .resume_controlled_role_reload_input(&fence.role_id, fence.input_epoch)
                    {
                        Ok(resumed) if resumed.current => core_input_resumed = true,
                        Ok(_) => {
                            status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                            restart_required = true;
                            failure_code = Some("RUNTIME_TAB_RELOAD_CORE_INPUT_STALE".to_owned());
                        }
                        Err(resume_error) => {
                            status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                            restart_required = true;
                            failure_code = Some(resume_error.code().to_owned());
                        }
                    },
                    Ok(false) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        failure_code = Some("RUNTIME_TAB_RELOAD_ROLE_OWNER_CHANGED".to_owned());
                    }
                    Err(snapshot_error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        failure_code = Some(snapshot_error.code().to_owned());
                    }
                }
            }
            if restart_required {
                match self.require_controlled_role_reload_restart(&fence.role_id, fence.input_epoch)
                {
                    Ok(true) => {}
                    Ok(false) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        failure_code = Some("RUNTIME_TAB_RELOAD_RESTART_MARK_STALE".to_owned());
                    }
                    Err(restart_error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        failure_code = Some(restart_error.code().to_owned());
                    }
                }
            }
            roles.push(crate::model::BrowserRoleReloadReceiptRecord {
                role_id: fence.role_id.clone(),
                owner_generation: fence.owner_generation,
                input_epoch: fence.input_epoch,
                surface_generation: 0,
                before_document_instance_id: String::new(),
                after_document_instance_id: None,
                navigation_sequence: None,
                submission_state: "notSubmitted".to_owned(),
                status,
                native_input_resumed: false,
                core_input_resumed,
                restart_required,
                failure_code,
            });
        }
        let status = controlled_role_reload_native_aggregate(&roles);
        ControlledRoleReloadTerminal {
            failure_code: roles
                .iter()
                .find_map(|role| role.failure_code.clone())
                .or_else(|| Some(error.code().to_owned())),
            roles,
            stage,
            status,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn controlled_role_reload_precommit_terminal(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        preparations: Option<&[crate::model::EmbeddedRoleReloadPreparationRecord]>,
        requested_status: crate::model::SystemRuntimeOperationStatus,
        requested_stage: &'static str,
        requested_failure_code: &str,
        prior_cleanup: Option<crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord>,
        require_native_cleanup: bool,
    ) -> ControlledRoleReloadTerminal {
        self.controlled_role_reload_precommit_terminal_with_retirements(
            invocation,
            preparations,
            requested_status,
            requested_stage,
            requested_failure_code,
            prior_cleanup,
            require_native_cleanup,
            &[],
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn controlled_role_reload_precommit_terminal_with_retirements(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        preparations: Option<&[crate::model::EmbeddedRoleReloadPreparationRecord]>,
        requested_status: crate::model::SystemRuntimeOperationStatus,
        requested_stage: &'static str,
        requested_failure_code: &str,
        prior_cleanup: Option<crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord>,
        require_native_cleanup: bool,
        managed_shortcut_retirements: &[crate::model::ManagedShortcutSurfaceRetirementReceiptRecord],
    ) -> ControlledRoleReloadTerminal {
        let cleanup = if require_native_cleanup {
            match prior_cleanup {
                Some(receipt) => Ok(receipt),
                None => self.run_controlled_role_reload_cleanup(
                    invocation,
                    "coreCleanup",
                    managed_shortcut_retirements,
                ),
            }
        } else {
            Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_NATIVE_CLEANUP_NOT_REQUIRED",
                "The controlled reload had not reached its native preparation fence.",
            ))
        };
        let cleanup_released = !require_native_cleanup
            || cleanup
                .as_ref()
                .is_ok_and(Self::controlled_role_reload_cleanup_released);
        let superseded = requested_status == crate::model::SystemRuntimeOperationStatus::Superseded;
        let mut terminal_status = if cleanup_released {
            requested_status
        } else {
            crate::model::SystemRuntimeOperationStatus::Indeterminate
        };
        let mut terminal_stage = if cleanup_released {
            requested_stage
        } else {
            "navigationReloadCleanupIndeterminate"
        };
        let cleanup_error_code = require_native_cleanup
            .then(|| cleanup.as_ref().err().map(CoreError::code))
            .flatten();
        let mut terminal_failure_code = cleanup_error_code
            .unwrap_or(requested_failure_code)
            .to_owned();
        let cleanup_roles = cleanup.as_ref().ok().map(|receipt| &receipt.roles);
        let admission = self.controlled_role_reload_admission.lock().map_err(|_| {
            CoreError::Internal("controlled reload admission lock poisoned".to_owned())
        });
        let superseded_reason = admission.as_ref().ok().and_then(|_| {
            self.controlled_role_reloads
                .superseded_reason(&invocation.operation_id)
                .ok()
                .flatten()
        });
        let resume_authority_available = admission.is_ok();
        let uncertain_retirement_role_id = (requested_stage
            == "navigationReloadShortcutRetireFailed")
            .then(|| {
                preparations.and_then(|roles| {
                    roles
                        .get(managed_shortcut_retirements.len())
                        .map(|role| role.role_id.as_str())
                })
            })
            .flatten();
        let mut roles = Vec::with_capacity(invocation.roles.len());
        for fence in &invocation.roles {
            let prepared = preparations
                .and_then(|roles| roles.iter().find(|role| role.role_id == fence.role_id));
            let native = cleanup_roles
                .and_then(|roles| roles.iter().find(|role| role.role_id == fence.role_id));
            let mut status = terminal_status;
            let mut restart_required = require_native_cleanup && !cleanup_released;
            let mut role_failure_code = Some(terminal_failure_code.clone());
            let mut core_input_resumed = false;
            if uncertain_retirement_role_id == Some(fence.role_id.as_str()) {
                status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                restart_required = true;
            } else if cleanup_released {
                let resume_decision = if !resume_authority_available {
                    Err(controlled_role_reload_error(
                        "RUNTIME_TAB_RELOAD_RESUME_AUTHORITY_UNAVAILABLE",
                        "The controlled reload resume authority was unavailable.",
                    ))
                } else if !require_native_cleanup && superseded && superseded_reason.is_none() {
                    self.controlled_role_reload_role_owner_is_exact(invocation, fence)
                } else {
                    self.controlled_role_reload_resume_allowed(
                        invocation,
                        fence,
                        superseded_reason.as_deref(),
                    )
                };
                match resume_decision {
                    Ok(true) => {
                        let provisional_restart = self
                            .controlled_role_reloads
                            .owns_provisional_restart(&invocation.operation_id, &fence.role_id);
                        let resumed = match provisional_restart {
                            Ok(true) => self
                                .resume_controlled_role_reload_after_provisional_restart(
                                    &fence.role_id,
                                    fence.input_epoch,
                                ),
                            Ok(false) => self.resume_controlled_role_reload_input(
                                &fence.role_id,
                                fence.input_epoch,
                            ),
                            Err(error) => Err(error),
                        };
                        match resumed {
                            Ok(resumed) => {
                                core_input_resumed = resumed.current;
                                if !resumed.current && !superseded {
                                    status =
                                        crate::model::SystemRuntimeOperationStatus::Indeterminate;
                                    restart_required = true;
                                    role_failure_code =
                                        Some("RUNTIME_TAB_RELOAD_CORE_INPUT_STALE".to_owned());
                                }
                            }
                            Err(error) => {
                                status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                                restart_required = true;
                                role_failure_code = Some(error.code().to_owned());
                            }
                        }
                    }
                    Ok(false) if !superseded && require_native_cleanup => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        role_failure_code =
                            Some("RUNTIME_TAB_RELOAD_CORE_INPUT_RESUME_UNSAFE".to_owned());
                    }
                    Ok(false)
                        if matches!(superseded_reason.as_deref(), Some("tabMove" | "tabHide")) =>
                    {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        role_failure_code =
                            Some("RUNTIME_TAB_RELOAD_ROLE_OWNER_CHANGED".to_owned());
                    }
                    Ok(false) => {}
                    Err(error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        role_failure_code = Some(error.code().to_owned());
                    }
                }
            }
            if let Some(native) = native {
                restart_required |= native.restart_required;
                if role_failure_code.as_deref() == Some(requested_failure_code) {
                    role_failure_code = native
                        .failure_code
                        .clone()
                        .or_else(|| role_failure_code.clone());
                }
            }
            if restart_required {
                match self.require_controlled_role_reload_restart(&fence.role_id, fence.input_epoch)
                {
                    Ok(true) => {}
                    Ok(false) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        role_failure_code =
                            Some("RUNTIME_TAB_RELOAD_RESTART_MARK_STALE".to_owned());
                    }
                    Err(error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        role_failure_code = Some(error.code().to_owned());
                    }
                }
            }
            roles.push(crate::model::BrowserRoleReloadReceiptRecord {
                role_id: fence.role_id.clone(),
                owner_generation: fence.owner_generation,
                input_epoch: fence.input_epoch,
                surface_generation: prepared.map_or(0, |role| role.surface_generation),
                before_document_instance_id: prepared
                    .map(|role| role.document_instance_id.clone())
                    .unwrap_or_default(),
                after_document_instance_id: None,
                navigation_sequence: None,
                submission_state: native
                    .map(|role| role.submission_state.clone())
                    .unwrap_or_else(|| "notSubmitted".to_owned()),
                status,
                native_input_resumed: native.is_some_and(|role| role.native_input_resumed),
                core_input_resumed,
                restart_required,
                failure_code: role_failure_code,
            });
        }
        drop(admission);
        let aggregate = controlled_role_reload_native_aggregate(&roles);
        terminal_status = aggregate;
        if cleanup_released
            && terminal_status == crate::model::SystemRuntimeOperationStatus::Indeterminate
        {
            terminal_stage = "navigationReloadInputResumeIndeterminate";
            terminal_failure_code = roles
                .iter()
                .find_map(|role| role.failure_code.clone())
                .unwrap_or(terminal_failure_code);
        }
        ControlledRoleReloadTerminal {
            failure_code: Some(terminal_failure_code),
            roles,
            stage: terminal_stage,
            status: terminal_status,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn reload_browser_runtime_tab(
        &self,
        operation_id: String,
        tab_id: String,
        window_id: String,
        window_generation: u64,
        topology_revision: u64,
        lifecycle_epoch: u64,
    ) -> CoreResult<crate::model::BrowserTabReloadReceiptRecord> {
        for value in [&operation_id, &tab_id, &window_id] {
            if !controlled_role_reload_valid_identifier(value, 256) {
                return Err(CoreError::InvalidInput(
                    "controlled reload identity is invalid".to_owned(),
                ));
            }
        }
        if window_generation == 0 || topology_revision == 0 || lifecycle_epoch == 0 {
            return Err(CoreError::InvalidInput(
                "controlled reload fences are invalid".to_owned(),
            ));
        }
        let fingerprint = controlled_role_reload_fingerprint(
            &tab_id,
            &window_id,
            window_generation,
            topology_revision,
            lifecycle_epoch,
        );
        let mut admission = self.controlled_role_reload_admission.lock().map_err(|_| {
            CoreError::Internal("controlled reload admission lock poisoned".to_owned())
        })?;
        match self
            .controlled_role_reloads
            .lookup(&operation_id, &fingerprint)?
        {
            ControlledRoleReloadLookup::Terminal(receipt) => return Ok(*receipt),
            ControlledRoleReloadLookup::Active => {
                drop(admission);
                return self
                    .controlled_role_reloads
                    .wait_for_terminal(&operation_id, &fingerprint);
            }
            ControlledRoleReloadLookup::New => {}
        }
        if !self.controlled_role_reload_registration_available()? {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_UNAVAILABLE",
                "The registered Chromium runtime cannot perform a controlled tab reload.",
            ));
        }
        let accepted_at = chrono::Utc::now().to_rfc3339();
        let started = Instant::now();
        let topology_exact = self.controlled_role_reload_topology_is_exact(
            &tab_id,
            &window_id,
            window_generation,
            topology_revision,
        )?;
        if !topology_exact
            || self.application_suspended.load(Ordering::Acquire)
            || self.application_lifecycle_epoch.load(Ordering::Acquire) != lifecycle_epoch
        {
            let invocation = ControlledRoleReloadInvocation {
                accepted_at,
                fingerprint,
                lifecycle_epoch,
                operation_id,
                roles: Vec::new(),
                started,
                tab_id,
                topology_revision,
                window_generation,
                window_id,
            };
            return self.finish_controlled_role_reload(
                &invocation,
                ControlledRoleReloadTerminal {
                    failure_code: Some("RUNTIME_TAB_RELOAD_STALE".to_owned()),
                    roles: Vec::new(),
                    stage: "navigationReloadSuperseded",
                    status: crate::model::SystemRuntimeOperationStatus::Superseded,
                },
            );
        }
        let mut roles = self.controlled_role_reload_owned_roles(&tab_id)?;
        loop {
            if roles.is_empty() {
                return Err(controlled_role_reload_error(
                    "RUNTIME_TAB_RELOAD_ROLES_MISSING",
                    "A controlled Role reload requires at least one live managed Role.",
                ));
            }
            let role_ids = roles
                .iter()
                .map(|role| role.role_id.clone())
                .collect::<Vec<_>>();
            let active_operations = self
                .controlled_role_reloads
                .active_operations_for_roles(&role_ids, &operation_id)?;
            if active_operations.is_empty() {
                break;
            }
            drop(admission);
            let mut predecessor_receipts = Vec::with_capacity(active_operations.len());
            for (active_operation_id, active_fingerprint) in active_operations {
                predecessor_receipts.push(
                    self.controlled_role_reloads
                        .wait_for_terminal(&active_operation_id, &active_fingerprint)?,
                );
            }
            let predecessor_safe = predecessor_receipts.iter().all(|receipt| {
                !receipt.roles.is_empty()
                    && receipt.roles.iter().all(|role| {
                        role.native_input_resumed
                            && role.core_input_resumed
                            && !role.restart_required
                    })
            });
            if !predecessor_safe {
                let invocation = ControlledRoleReloadInvocation {
                    accepted_at,
                    fingerprint,
                    lifecycle_epoch,
                    operation_id,
                    roles,
                    started,
                    tab_id,
                    topology_revision,
                    window_generation,
                    window_id,
                };
                let predecessor_roles = predecessor_receipts
                    .iter()
                    .flat_map(|receipt| receipt.roles.iter())
                    .collect::<Vec<_>>();
                let terminal_roles = invocation
                    .roles
                    .iter()
                    .map(|role| {
                        let predecessor = predecessor_roles
                            .iter()
                            .find(|candidate| candidate.role_id == role.role_id);
                        crate::model::BrowserRoleReloadReceiptRecord {
                            role_id: role.role_id.clone(),
                            owner_generation: role.owner_generation,
                            input_epoch: predecessor.map_or(0, |role| role.input_epoch),
                            surface_generation: predecessor
                                .map_or(0, |role| role.surface_generation),
                            before_document_instance_id: predecessor
                                .map(|role| role.before_document_instance_id.clone())
                                .unwrap_or_default(),
                            after_document_instance_id: None,
                            navigation_sequence: None,
                            submission_state: "notSubmitted".to_owned(),
                            status: crate::model::SystemRuntimeOperationStatus::Indeterminate,
                            native_input_resumed: false,
                            core_input_resumed: false,
                            restart_required: true,
                            failure_code: Some(
                                "RUNTIME_TAB_RELOAD_PREDECESSOR_INDETERMINATE".to_owned(),
                            ),
                        }
                    })
                    .collect();
                return self.finish_controlled_role_reload(
                    &invocation,
                    ControlledRoleReloadTerminal {
                        failure_code: Some(
                            "RUNTIME_TAB_RELOAD_PREDECESSOR_INDETERMINATE".to_owned(),
                        ),
                        roles: terminal_roles,
                        stage: "navigationReloadPredecessorIndeterminate",
                        status: crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    },
                );
            }
            admission = self.controlled_role_reload_admission.lock().map_err(|_| {
                CoreError::Internal("controlled reload admission lock poisoned".to_owned())
            })?;
            match self
                .controlled_role_reloads
                .lookup(&operation_id, &fingerprint)?
            {
                ControlledRoleReloadLookup::Terminal(receipt) => return Ok(*receipt),
                ControlledRoleReloadLookup::Active => {
                    drop(admission);
                    return self
                        .controlled_role_reloads
                        .wait_for_terminal(&operation_id, &fingerprint);
                }
                ControlledRoleReloadLookup::New => {}
            }
            if !self.controlled_role_reload_registration_available()? {
                return Err(controlled_role_reload_error(
                    "RUNTIME_TAB_RELOAD_UNAVAILABLE",
                    "The registered Chromium runtime cannot perform a controlled tab reload.",
                ));
            }
            if !self.controlled_role_reload_topology_is_exact(
                &tab_id,
                &window_id,
                window_generation,
                topology_revision,
            )? || self.application_suspended.load(Ordering::Acquire)
                || self.application_lifecycle_epoch.load(Ordering::Acquire) != lifecycle_epoch
            {
                let invocation = ControlledRoleReloadInvocation {
                    accepted_at,
                    fingerprint,
                    lifecycle_epoch,
                    operation_id,
                    roles: Vec::new(),
                    started,
                    tab_id,
                    topology_revision,
                    window_generation,
                    window_id,
                };
                return self.finish_controlled_role_reload(
                    &invocation,
                    ControlledRoleReloadTerminal {
                        failure_code: Some("RUNTIME_TAB_RELOAD_STALE".to_owned()),
                        roles: Vec::new(),
                        stage: "navigationReloadSuperseded",
                        status: crate::model::SystemRuntimeOperationStatus::Superseded,
                    },
                );
            }
            roles = self.controlled_role_reload_owned_roles(&tab_id)?;
        }
        let diagnostics = self.macro_runtime.input_diagnostics()?;
        let restart_required = diagnostics
            .roles
            .iter()
            .filter(|diagnostic| roles.iter().any(|role| role.role_id == diagnostic.role_id))
            .any(|diagnostic| diagnostic.restart_required);
        if restart_required {
            let invocation = ControlledRoleReloadInvocation {
                accepted_at,
                fingerprint,
                lifecycle_epoch,
                operation_id,
                roles,
                started,
                tab_id,
                topology_revision,
                window_generation,
                window_id,
            };
            let terminal_roles = invocation
                .roles
                .iter()
                .map(|role| {
                    let diagnostic = diagnostics
                        .roles
                        .iter()
                        .find(|diagnostic| diagnostic.role_id == role.role_id);
                    crate::model::BrowserRoleReloadReceiptRecord {
                        role_id: role.role_id.clone(),
                        owner_generation: role.owner_generation,
                        input_epoch: diagnostic.map_or(0, |role| role.input_epoch),
                        surface_generation: 0,
                        before_document_instance_id: String::new(),
                        after_document_instance_id: None,
                        navigation_sequence: None,
                        submission_state: "notSubmitted".to_owned(),
                        status: crate::model::SystemRuntimeOperationStatus::Indeterminate,
                        native_input_resumed: false,
                        core_input_resumed: false,
                        restart_required: diagnostic.is_some_and(|role| role.restart_required),
                        failure_code: Some("RUNTIME_TAB_RELOAD_ROLE_RESTART_REQUIRED".to_owned()),
                    }
                })
                .collect();
            return self.finish_controlled_role_reload(
                &invocation,
                ControlledRoleReloadTerminal {
                    failure_code: Some("RUNTIME_TAB_RELOAD_ROLE_RESTART_REQUIRED".to_owned()),
                    roles: terminal_roles,
                    stage: "navigationReloadRoleRestartRequired",
                    status: crate::model::SystemRuntimeOperationStatus::Indeterminate,
                },
            );
        }
        for index in 0..roles.len() {
            let role_id = roles[index].role_id.clone();
            let fenced = if index == 1 {
                self.controlled_role_reload_test_fault("fenceSecond")
                    .and_then(|()| self.fence_macro_input(&role_id))
            } else {
                self.fence_macro_input(&role_id)
            };
            match fenced {
                Ok(epoch) => {
                    roles[index].input_epoch = epoch.input_epoch;
                }
                Err(error) => {
                    let invocation = ControlledRoleReloadInvocation {
                        accepted_at,
                        fingerprint,
                        lifecycle_epoch,
                        operation_id,
                        roles,
                        started,
                        tab_id,
                        topology_revision,
                        window_generation,
                        window_id,
                    };
                    let terminal = self.controlled_role_reload_preadmit_terminal(
                        &invocation,
                        &error,
                        "navigationReloadInputFenceFailed",
                    );
                    return self.finish_controlled_role_reload(&invocation, terminal);
                }
            }
        }
        let invocation = ControlledRoleReloadInvocation {
            accepted_at,
            fingerprint,
            lifecycle_epoch,
            operation_id,
            roles,
            started,
            tab_id,
            topology_revision,
            window_generation,
            window_id,
        };
        let reload_entry = ActiveControlledRoleReload {
            actor_operation_id: None,
            fingerprint: invocation.fingerprint.clone(),
            phase: ControlledRoleReloadPhase::Fenced,
            reload_operation_id: invocation.operation_id.clone(),
            roles: invocation.roles.clone(),
            provisional_restart_role_ids: std::collections::HashSet::new(),
            superseded_reason: None,
        };
        let older_actor_operation_ids = match self
            .controlled_role_reload_test_fault("admit")
            .and_then(|()| self.controlled_role_reloads.admit(reload_entry))
        {
            Ok(operation_ids) => operation_ids,
            Err(error) => {
                let terminal = self.controlled_role_reload_preadmit_terminal(
                    &invocation,
                    &error,
                    "navigationReloadAdmissionFailed",
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        };
        let admission_exact = self.controlled_role_reload_is_exact(&invocation);
        drop(admission);
        for actor_operation_id in older_actor_operation_ids {
            let _ = self.operation_actor.cancel(&actor_operation_id);
        }
        match admission_exact {
            Ok(true) => {}
            Ok(false) => {
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    None,
                    crate::model::SystemRuntimeOperationStatus::Superseded,
                    "navigationReloadSuperseded",
                    "RUNTIME_TAB_RELOAD_STALE",
                    None,
                    false,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
            Err(error) => {
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    None,
                    if controlled_role_reload_error_is_indeterminate(&error) {
                        crate::model::SystemRuntimeOperationStatus::Indeterminate
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    },
                    "navigationReloadAdmissionFailed",
                    error.code(),
                    None,
                    false,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        }

        let prepare_outcome = self.run_controlled_role_reload_effect(
            &invocation,
            ControlledRoleReloadPhase::Fenced,
            CoreEffectAction::EmbeddedPrepareTabRoleReload {
                reload_operation_id: invocation.operation_id.clone(),
                tab_id: invocation.tab_id.clone(),
                window_id: invocation.window_id.clone(),
                window_generation: invocation.window_generation,
                topology_revision: invocation.topology_revision,
                lifecycle_epoch: invocation.lifecycle_epoch,
                roles: invocation.roles.clone(),
            },
            &[],
        );
        let prepare = match prepare_outcome {
            Ok(outcome) => match self.parse_controlled_role_reload_prepare(&invocation, outcome) {
                Ok(receipt) => receipt,
                Err(error) => {
                    let terminal = self.controlled_role_reload_precommit_terminal(
                        &invocation,
                        None,
                        if controlled_role_reload_error_is_indeterminate(&error) {
                            crate::model::SystemRuntimeOperationStatus::Indeterminate
                        } else {
                            crate::model::SystemRuntimeOperationStatus::Failed
                        },
                        "navigationReloadPrepareFailed",
                        error.code(),
                        None,
                        true,
                    );
                    return self.finish_controlled_role_reload(&invocation, terminal);
                }
            },
            Err(failure) => {
                let superseded = self
                    .controlled_role_reloads
                    .is_current(&invocation.operation_id)
                    .is_ok_and(|current| !current);
                let status = if superseded {
                    crate::model::SystemRuntimeOperationStatus::Superseded
                } else if controlled_role_reload_error_is_indeterminate(&failure.error) {
                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                } else {
                    crate::model::SystemRuntimeOperationStatus::Failed
                };
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    None,
                    status,
                    if superseded {
                        "navigationReloadSuperseded"
                    } else {
                        "navigationReloadPrepareFailed"
                    },
                    failure.error.code(),
                    failure.cleanup.map(|receipt| *receipt),
                    true,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        };
        if prepare.status != crate::model::SystemRuntimeOperationStatus::Applied {
            let terminal = self.controlled_role_reload_precommit_terminal(
                &invocation,
                Some(&prepare.roles),
                prepare.status,
                "navigationReloadPrepareIncomplete",
                prepare
                    .failure_code
                    .as_deref()
                    .unwrap_or("RUNTIME_TAB_RELOAD_PREPARE_INCOMPLETE"),
                None,
                true,
            );
            return self.finish_controlled_role_reload(&invocation, terminal);
        }
        match self.controlled_role_reloads.set_phase(
            &invocation.operation_id,
            ControlledRoleReloadPhase::Prepared,
        ) {
            Ok(true) => {}
            Ok(false) => {
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Superseded,
                    "navigationReloadSuperseded",
                    "RUNTIME_TAB_RELOAD_SUPERSEDED",
                    None,
                    true,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
            Err(error) => {
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    "navigationReloadCoreStateFailed",
                    error.code(),
                    None,
                    true,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        }
        #[cfg(test)]
        let after_prepare_hook = match self.controlled_role_reload_after_prepare_hook.lock() {
            Ok(hook) => hook.clone(),
            Err(_) => {
                let error = CoreError::Internal(
                    "controlled reload after-prepare test hook poisoned".to_owned(),
                );
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    "navigationReloadCoreStateFailed",
                    error.code(),
                    None,
                    true,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        };
        #[cfg(test)]
        if let Some(hook) = after_prepare_hook {
            hook();
        }
        for role in &prepare.roles {
            if let Err(error) = Self::validate_managed_shortcut_surface_retirement(
                &role.role_id,
                role.surface_generation,
                &role.document_instance_id,
            ) {
                let status = if controlled_role_reload_error_is_indeterminate(&error) {
                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                } else {
                    crate::model::SystemRuntimeOperationStatus::Failed
                };
                let terminal = self.controlled_role_reload_precommit_terminal(
                    &invocation,
                    Some(&prepare.roles),
                    status,
                    "navigationReloadShortcutRetireValidationFailed",
                    error.code(),
                    None,
                    true,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        }
        let mut managed_shortcut_retirements = Vec::with_capacity(prepare.roles.len());
        for (index, role) in prepare.roles.iter().enumerate() {
            let retired = if index == 1 {
                self.controlled_role_reload_test_fault("retireSecondTimeout")
                    .and_then(|()| {
                        self.retire_managed_shortcut_surface(
                            &role.role_id,
                            role.surface_generation,
                            &role.document_instance_id,
                        )
                    })
            } else {
                self.retire_managed_shortcut_surface(
                    &role.role_id,
                    role.surface_generation,
                    &role.document_instance_id,
                )
            };
            match retired {
                Ok(receipt) => managed_shortcut_retirements.push(receipt),
                Err(error) => {
                    let status = if controlled_role_reload_error_is_indeterminate(&error) {
                        crate::model::SystemRuntimeOperationStatus::Indeterminate
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    };
                    let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                        &invocation,
                        Some(&prepare.roles),
                        status,
                        "navigationReloadShortcutRetireFailed",
                        error.code(),
                        None,
                        true,
                        &managed_shortcut_retirements,
                    );
                    return self.finish_controlled_role_reload(&invocation, terminal);
                }
            }
        }
        for role in &prepare.roles {
            let drained = match self
                .controlled_role_reload_test_fault("drain")
                .and_then(|()| self.drain_macro_input(&role.role_id, role.input_epoch))
            {
                Ok(drained) => drained,
                Err(error) => {
                    let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                        &invocation,
                        Some(&prepare.roles),
                        if controlled_role_reload_error_is_indeterminate(&error) {
                            crate::model::SystemRuntimeOperationStatus::Indeterminate
                        } else {
                            crate::model::SystemRuntimeOperationStatus::Failed
                        },
                        "navigationReloadInputDrainFailed",
                        error.code(),
                        None,
                        true,
                        &managed_shortcut_retirements,
                    );
                    return self.finish_controlled_role_reload(&invocation, terminal);
                }
            };
            if !drained.current {
                let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Superseded,
                    "navigationReloadSuperseded",
                    "RUNTIME_TAB_RELOAD_INPUT_SUPERSEDED",
                    None,
                    true,
                    &managed_shortcut_retirements,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        }
        match self
            .controlled_role_reloads
            .set_phase(&invocation.operation_id, ControlledRoleReloadPhase::Drained)
        {
            Ok(true) => {}
            Ok(false) => {
                let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Superseded,
                    "navigationReloadSuperseded",
                    "RUNTIME_TAB_RELOAD_SUPERSEDED",
                    None,
                    true,
                    &managed_shortcut_retirements,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
            Err(error) => {
                let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    "navigationReloadCoreStateFailed",
                    error.code(),
                    None,
                    true,
                    &managed_shortcut_retirements,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        }
        let exact_after_drain = self
            .controlled_role_reload_test_fault("snapshotAfterDrain")
            .and_then(|()| self.controlled_role_reload_is_exact(&invocation));
        match exact_after_drain {
            Ok(true) => {}
            Ok(false) => {
                let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Superseded,
                    "navigationReloadSuperseded",
                    "RUNTIME_TAB_RELOAD_STALE",
                    None,
                    true,
                    &managed_shortcut_retirements,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
            Err(error) => {
                let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                    &invocation,
                    Some(&prepare.roles),
                    crate::model::SystemRuntimeOperationStatus::Indeterminate,
                    "navigationReloadSnapshotFailed",
                    error.code(),
                    None,
                    true,
                    &managed_shortcut_retirements,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        }

        let native_outcome = self.run_controlled_role_reload_effect(
            &invocation,
            ControlledRoleReloadPhase::CommitSubmitted,
            CoreEffectAction::EmbeddedCommitTabRoleReload {
                reload_operation_id: invocation.operation_id.clone(),
                tab_id: invocation.tab_id.clone(),
                window_id: invocation.window_id.clone(),
                window_generation: invocation.window_generation,
                topology_revision: invocation.topology_revision,
                lifecycle_epoch: invocation.lifecycle_epoch,
                roles: prepare.roles.clone(),
                managed_shortcut_retirements: managed_shortcut_retirements.clone(),
            },
            &managed_shortcut_retirements,
        );
        let native = match native_outcome {
            Ok(outcome) => {
                match self.parse_controlled_role_reload_native(&invocation, &prepare.roles, outcome)
                {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        let superseded = self
                            .controlled_role_reloads
                            .is_current(&invocation.operation_id)
                            .is_ok_and(|current| !current);
                        let terminal = self
                            .controlled_role_reload_precommit_terminal_with_retirements(
                                &invocation,
                                Some(&prepare.roles),
                                if superseded {
                                    crate::model::SystemRuntimeOperationStatus::Superseded
                                } else {
                                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                                },
                                if superseded {
                                    "navigationReloadSuperseded"
                                } else {
                                    "navigationReloadIndeterminate"
                                },
                                error.code(),
                                None,
                                true,
                                &managed_shortcut_retirements,
                            );
                        return self.finish_controlled_role_reload(&invocation, terminal);
                    }
                }
            }
            Err(failure) => {
                let superseded = self
                    .controlled_role_reloads
                    .is_current(&invocation.operation_id)
                    .is_ok_and(|current| !current);
                let terminal = self.controlled_role_reload_precommit_terminal_with_retirements(
                    &invocation,
                    Some(&prepare.roles),
                    if superseded {
                        crate::model::SystemRuntimeOperationStatus::Superseded
                    } else if controlled_role_reload_error_is_indeterminate(&failure.error) {
                        crate::model::SystemRuntimeOperationStatus::Indeterminate
                    } else {
                        crate::model::SystemRuntimeOperationStatus::Failed
                    },
                    if superseded {
                        "navigationReloadSuperseded"
                    } else {
                        "navigationReloadCommitFailed"
                    },
                    failure.error.code(),
                    failure.cleanup.map(|receipt| *receipt),
                    true,
                    &managed_shortcut_retirements,
                );
                return self.finish_controlled_role_reload(&invocation, terminal);
            }
        };

        let before_final_admission = self.controlled_role_reload_before_final_admission_test_hook();
        let final_admission = self.controlled_role_reload_admission.lock().map_err(|_| {
            CoreError::Internal("controlled reload admission lock poisoned".to_owned())
        });
        let operation_exact = match &final_admission {
            Ok(_) => before_final_admission
                .and_then(|()| self.controlled_role_reload_after_final_admission_test_hook())
                .and_then(|()| self.controlled_role_reload_test_fault("snapshotFinal"))
                .and_then(|()| self.controlled_role_reload_is_exact(&invocation)),
            Err(error) => Err(CoreError::Internal(error.to_string())),
        };
        let superseded_reason = final_admission.as_ref().ok().and_then(|_| {
            self.controlled_role_reloads
                .superseded_reason(&invocation.operation_id)
                .ok()
                .flatten()
        });
        let exact_error_code = operation_exact
            .as_ref()
            .err()
            .map(|error| error.code().to_owned());
        let operation_current = operation_exact.as_ref().is_ok_and(|exact| *exact);
        let operation_superseded = superseded_reason.is_some();
        let native_failure_code = native.failure_code;
        let mut roles = Vec::with_capacity(native.roles.len());
        for role in native.roles {
            let mut status = role.status;
            let mut core_input_resumed = false;
            let mut restart_required = role.restart_required;
            let mut failure_code = role.failure_code;
            let submitted = matches!(role.submission_state.as_str(), "submitted" | "unknown");
            let fence = invocation
                .roles
                .iter()
                .find(|fence| fence.role_id == role.role_id)
                .expect("validated native reload role fence");
            if let Some(error_code) = exact_error_code.as_ref() {
                status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                restart_required = true;
                failure_code = Some(error_code.clone());
            } else if status == crate::model::SystemRuntimeOperationStatus::Applied
                && operation_current
            {
                match self.resume_controlled_role_reload_input(&role.role_id, role.input_epoch) {
                    Ok(resumed) => {
                        core_input_resumed = resumed.current;
                        if !resumed.current {
                            status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                            restart_required = true;
                            failure_code = Some("RUNTIME_TAB_RELOAD_CORE_INPUT_STALE".to_owned());
                        }
                    }
                    Err(error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        failure_code = Some(error.code().to_owned());
                    }
                }
            } else if status == crate::model::SystemRuntimeOperationStatus::Applied {
                status = if operation_superseded {
                    crate::model::SystemRuntimeOperationStatus::Superseded
                } else {
                    crate::model::SystemRuntimeOperationStatus::Indeterminate
                };
                restart_required |= superseded_reason
                    .as_deref()
                    .is_none_or(|reason| !matches!(reason, "tabStop" | "windowClose"));
                failure_code = Some("RUNTIME_TAB_RELOAD_SUPERSEDED_AFTER_NATIVE_APPLY".to_owned());
            } else if !submitted {
                let resume_decision = self.controlled_role_reload_resume_allowed(
                    &invocation,
                    fence,
                    superseded_reason.as_deref(),
                );
                match resume_decision {
                    Ok(true) => {
                        let provisional_restart = self
                            .controlled_role_reloads
                            .owns_provisional_restart(&invocation.operation_id, &role.role_id);
                        let resumed = match provisional_restart {
                            Ok(true) => self
                                .resume_controlled_role_reload_after_provisional_restart(
                                    &role.role_id,
                                    role.input_epoch,
                                ),
                            Ok(false) => self.resume_controlled_role_reload_input(
                                &role.role_id,
                                role.input_epoch,
                            ),
                            Err(error) => Err(error),
                        };
                        match resumed {
                            Ok(resumed) => {
                                core_input_resumed = resumed.current;
                                if !resumed.current {
                                    status =
                                        crate::model::SystemRuntimeOperationStatus::Indeterminate;
                                    restart_required = true;
                                    failure_code =
                                        Some("RUNTIME_TAB_RELOAD_CORE_INPUT_STALE".to_owned());
                                }
                            }
                            Err(error) => {
                                status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                                restart_required = true;
                                failure_code = Some(error.code().to_owned());
                            }
                        }
                    }
                    Ok(false) if operation_superseded => {
                        status = crate::model::SystemRuntimeOperationStatus::Superseded;
                        if matches!(superseded_reason.as_deref(), Some("tabMove" | "tabHide")) {
                            status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                            restart_required = true;
                            failure_code = Some("RUNTIME_TAB_RELOAD_ROLE_OWNER_CHANGED".to_owned());
                        }
                    }
                    Ok(false) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        failure_code =
                            Some("RUNTIME_TAB_RELOAD_CORE_INPUT_RESUME_UNSAFE".to_owned());
                    }
                    Err(error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        restart_required = true;
                        failure_code = Some(error.code().to_owned());
                    }
                }
            } else {
                restart_required = true;
                if !matches!(
                    status,
                    crate::model::SystemRuntimeOperationStatus::Superseded
                        | crate::model::SystemRuntimeOperationStatus::Cancelled
                ) {
                    status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                }
            }
            if restart_required {
                match self.require_controlled_role_reload_restart(&role.role_id, role.input_epoch) {
                    Ok(true) => {}
                    Ok(false) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        failure_code = Some("RUNTIME_TAB_RELOAD_RESTART_MARK_STALE".to_owned());
                    }
                    Err(error) => {
                        status = crate::model::SystemRuntimeOperationStatus::Indeterminate;
                        failure_code = Some(error.code().to_owned());
                    }
                }
            }
            roles.push(crate::model::BrowserRoleReloadReceiptRecord {
                role_id: role.role_id,
                owner_generation: role.owner_generation,
                input_epoch: role.input_epoch,
                surface_generation: role.surface_generation,
                before_document_instance_id: role.before_document_instance_id,
                after_document_instance_id: role.after_document_instance_id,
                navigation_sequence: role.navigation_sequence,
                submission_state: role.submission_state,
                status,
                native_input_resumed: role.native_input_resumed,
                core_input_resumed,
                restart_required,
                failure_code,
            });
        }
        let status = controlled_role_reload_native_aggregate(&roles);
        let failure_code = if status == crate::model::SystemRuntimeOperationStatus::Applied {
            None
        } else {
            native_failure_code.or_else(|| roles.iter().find_map(|role| role.failure_code.clone()))
        };
        let stage = match status {
            crate::model::SystemRuntimeOperationStatus::Applied => "navigationReloadInputReady",
            crate::model::SystemRuntimeOperationStatus::Superseded => "navigationReloadSuperseded",
            crate::model::SystemRuntimeOperationStatus::Indeterminate => {
                "navigationReloadIndeterminate"
            }
            crate::model::SystemRuntimeOperationStatus::Degraded => "navigationReloadDegraded",
            _ => "navigationReloadFailed",
        };
        let terminal = self.finish_controlled_role_reload(
            &invocation,
            ControlledRoleReloadTerminal {
                failure_code,
                roles,
                stage,
                status,
            },
        );
        drop(final_admission);
        terminal
    }
}
