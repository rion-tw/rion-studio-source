impl AppCore {
    fn run_controlled_role_reload_effect(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        phase: ControlledRoleReloadPhase,
        action: CoreEffectAction,
        managed_shortcut_retirements: &[crate::model::ManagedShortcutSurfaceRetirementReceiptRecord],
    ) -> Result<crate::operation_actor::OperationOutcome, ControlledRoleReloadEffectFailure> {
        let plan = crate::operation_actor::OperationPlan {
            steps: vec![effect_step(
                &invocation.tab_id,
                action,
                Duration::from_secs(15),
                Some(Self::controlled_role_reload_supersede_action(
                    invocation,
                    "coreCancelled",
                    managed_shortcut_retirements,
                )),
            )],
        };
        let handle = self
            .operation_actor
            .start_with_parent(plan, invocation.operation_id.clone())
            .map_err(|error| ControlledRoleReloadEffectFailure {
                cleanup: None,
                error,
            })?;
        let actor_operation_id = handle.operation_id.clone();
        let actor_current = self.controlled_role_reloads.set_actor_operation(
            &invocation.operation_id,
            actor_operation_id.clone(),
            phase,
        );
        match actor_current {
            Ok(true) => {}
            Ok(false) => {
                let _ = self.operation_actor.cancel(&actor_operation_id);
            }
            Err(error) => {
                let _ = self.operation_actor.cancel(&actor_operation_id);
                let _ = handle.outcome.blocking_recv();
                return Err(ControlledRoleReloadEffectFailure {
                    cleanup: None,
                    error,
                });
            }
        }
        let outcome =
            handle
                .outcome
                .blocking_recv()
                .map_err(|_| ControlledRoleReloadEffectFailure {
                    cleanup: None,
                    error: CoreError::Internal("controlled reload effect actor stopped".to_owned()),
                })?;
        if let Err(error) = self
            .controlled_role_reloads
            .clear_actor_operation(&invocation.operation_id, &actor_operation_id)
        {
            return Err(ControlledRoleReloadEffectFailure {
                cleanup: None,
                error,
            });
        }
        if !outcome.compensation_failures.is_empty() {
            return Err(ControlledRoleReloadEffectFailure {
                cleanup: None,
                error: CoreError::Effect {
                    code: "RUNTIME_TAB_RELOAD_SUPERSEDE_FAILED".to_owned(),
                    message: "Chromium did not acknowledge the controlled reload cleanup fence."
                        .to_owned(),
                },
            });
        }
        if let Some(error) = &outcome.error {
            let cleanup = (outcome.compensation_results.len() == 1)
                .then(|| &outcome.compensation_results[0])
                .ok_or_else(|| {
                    controlled_role_reload_error(
                        "RUNTIME_TAB_RELOAD_SUPERSEDE_RECEIPT_MISSING",
                        "Chromium omitted its controlled reload cleanup receipt.",
                    )
                })
                .and_then(|result| self.parse_controlled_role_reload_supersede(invocation, result));
            let (cleanup, failure_error) = match cleanup {
                Ok(cleanup) => (
                    Some(Box::new(cleanup)),
                    CoreError::Effect {
                        code: error.code.clone(),
                        message: error.message.clone(),
                    },
                ),
                Err(cleanup_error) => (None, cleanup_error),
            };
            return Err(ControlledRoleReloadEffectFailure {
                cleanup,
                error: failure_error,
            });
        }
        Ok(outcome)
    }

    fn run_controlled_role_reload_cleanup(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        reason: &str,
        managed_shortcut_retirements: &[crate::model::ManagedShortcutSurfaceRetirementReceiptRecord],
    ) -> CoreResult<crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord> {
        let outcome = self.run_embedded_runtime_effect(
            &invocation.tab_id,
            Self::controlled_role_reload_supersede_action(
                invocation,
                reason,
                managed_shortcut_retirements,
            ),
            None,
            Some(&invocation.operation_id),
        )?;
        let result = (outcome.results.len() == 1
            && outcome.compensation_results.is_empty()
            && outcome.compensation_failures.is_empty()
            && outcome.error.is_none())
        .then(|| &outcome.results[0])
        .ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_SUPERSEDE_RECEIPT_INVALID",
                "Chromium returned an ambiguous controlled reload cleanup outcome.",
            )
        })?;
        self.parse_controlled_role_reload_supersede(invocation, result)
    }

    fn parse_controlled_role_reload_supersede(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        result: &crate::model::CoreEffectResult,
    ) -> CoreResult<crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord> {
        if !result.ok || result.error.is_some() {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_SUPERSEDE_RECEIPT_INVALID",
                "Chromium rejected its controlled reload cleanup receipt.",
            ));
        }
        let value = result.value_json.as_deref().ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_SUPERSEDE_RECEIPT_MISSING",
                "Chromium omitted its controlled reload cleanup receipt.",
            )
        })?;
        let mut receipt = serde_json::from_str::<
            crate::model::EmbeddedTabRoleReloadSupersedeReceiptRecord,
        >(value)
        .map_err(|_| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_SUPERSEDE_RECEIPT_INVALID",
                "Chromium returned an invalid controlled reload cleanup receipt.",
            )
        })?;
        receipt
            .roles
            .sort_by(|left, right| left.role_id.cmp(&right.role_id));
        let aggregate = receipt
            .roles
            .iter()
            .map(|role| crate::model::BrowserRoleReloadReceiptRecord {
                role_id: role.role_id.clone(),
                owner_generation: role.owner_generation,
                input_epoch: role.input_epoch,
                surface_generation: 0,
                before_document_instance_id: String::new(),
                after_document_instance_id: None,
                navigation_sequence: None,
                submission_state: role.submission_state.clone(),
                status: role.status,
                native_input_resumed: role.native_input_resumed,
                core_input_resumed: false,
                restart_required: role.restart_required,
                failure_code: role.failure_code.clone(),
            })
            .collect::<Vec<_>>();
        if receipt.reload_operation_id != invocation.operation_id
            || receipt.tab_id != invocation.tab_id
            || receipt.roles.len() != invocation.roles.len()
            || receipt.status != controlled_role_reload_native_aggregate(&aggregate)
            || receipt
                .roles
                .iter()
                .zip(&invocation.roles)
                .any(|(native, core)| {
                    native.role_id != core.role_id
                        || native.owner_generation != core.owner_generation
                        || native.input_epoch != core.input_epoch
                        || !matches!(
                            native.submission_state.as_str(),
                            "notSubmitted" | "submitted" | "unknown"
                        )
                        || (native.submission_state != "notSubmitted"
                            && native.native_input_resumed)
                        || (native.submission_state != "notSubmitted" && !native.restart_required)
                })
        {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_SUPERSEDE_RECEIPT_INVALID",
                "Chromium returned stale controlled reload cleanup fences.",
            ));
        }
        Ok(receipt)
    }

    fn parse_controlled_role_reload_prepare(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        outcome: crate::operation_actor::OperationOutcome,
    ) -> CoreResult<crate::model::EmbeddedTabRoleReloadPreparationReceiptRecord> {
        let result = (outcome.results.len() == 1
            && outcome.compensation_results.is_empty()
            && outcome.compensation_failures.is_empty()
            && outcome.error.is_none())
        .then(|| &outcome.results[0])
        .ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_PREPARE_RECEIPT_INVALID",
                "Chromium returned an ambiguous controlled reload preparation outcome.",
            )
        })?;
        if !result.ok || result.error.is_some() {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_PREPARE_RECEIPT_INVALID",
                "Chromium rejected its controlled reload preparation receipt.",
            ));
        }
        let value = result.value_json.as_deref().ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_PREPARE_RECEIPT_MISSING",
                "Chromium omitted its controlled reload preparation receipt.",
            )
        })?;
        let mut receipt = serde_json::from_str::<
            crate::model::EmbeddedTabRoleReloadPreparationReceiptRecord,
        >(value)
        .map_err(|_| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_PREPARE_RECEIPT_INVALID",
                "Chromium returned an invalid controlled reload preparation receipt.",
            )
        })?;
        receipt
            .roles
            .sort_by(|left, right| left.role_id.cmp(&right.role_id));
        if receipt.reload_operation_id != invocation.operation_id
            || receipt.tab_id != invocation.tab_id
            || receipt.window_id != invocation.window_id
            || receipt.window_generation != invocation.window_generation
            || receipt.topology_revision != invocation.topology_revision
            || receipt.lifecycle_epoch != invocation.lifecycle_epoch
            || receipt.roles.len() != invocation.roles.len()
            || receipt
                .roles
                .iter()
                .zip(&invocation.roles)
                .any(|(native, core)| {
                    native.role_id != core.role_id
                        || native.owner_generation != core.owner_generation
                        || native.input_epoch != core.input_epoch
                        || (receipt.status == crate::model::SystemRuntimeOperationStatus::Applied
                            && (native.surface_generation == 0
                                || !controlled_role_reload_valid_identifier(
                                    &native.document_instance_id,
                                    512,
                                )))
                })
        {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_PREPARE_RECEIPT_INVALID",
                "Chromium returned stale controlled reload preparation fences.",
            ));
        }
        Ok(receipt)
    }

    fn parse_controlled_role_reload_native(
        &self,
        invocation: &ControlledRoleReloadInvocation,
        preparations: &[crate::model::EmbeddedRoleReloadPreparationRecord],
        outcome: crate::operation_actor::OperationOutcome,
    ) -> CoreResult<crate::model::EmbeddedTabRoleReloadNativeReceiptRecord> {
        let result = (outcome.results.len() == 1
            && outcome.compensation_results.is_empty()
            && outcome.compensation_failures.is_empty()
            && outcome.error.is_none())
        .then(|| &outcome.results[0])
        .ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_NATIVE_RECEIPT_INVALID",
                "Chromium returned an ambiguous controlled reload terminal outcome.",
            )
        })?;
        if !result.ok || result.error.is_some() {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_NATIVE_RECEIPT_INVALID",
                "Chromium rejected its controlled reload terminal receipt.",
            ));
        }
        let value = result.value_json.as_deref().ok_or_else(|| {
            controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_NATIVE_RECEIPT_MISSING",
                "Chromium omitted its controlled reload terminal receipt.",
            )
        })?;
        let mut receipt =
            serde_json::from_str::<crate::model::EmbeddedTabRoleReloadNativeReceiptRecord>(value)
                .map_err(|_| {
                controlled_role_reload_error(
                    "RUNTIME_TAB_RELOAD_NATIVE_RECEIPT_INVALID",
                    "Chromium returned an invalid controlled reload terminal receipt.",
                )
            })?;
        receipt
            .roles
            .sort_by(|left, right| left.role_id.cmp(&right.role_id));
        let aggregate_roles = receipt
            .roles
            .iter()
            .map(|role| crate::model::BrowserRoleReloadReceiptRecord {
                role_id: role.role_id.clone(),
                owner_generation: role.owner_generation,
                input_epoch: role.input_epoch,
                surface_generation: role.surface_generation,
                before_document_instance_id: role.before_document_instance_id.clone(),
                after_document_instance_id: role.after_document_instance_id.clone(),
                navigation_sequence: role.navigation_sequence,
                submission_state: role.submission_state.clone(),
                status: role.status,
                native_input_resumed: role.native_input_resumed,
                core_input_resumed: false,
                restart_required: role.restart_required,
                failure_code: role.failure_code.clone(),
            })
            .collect::<Vec<_>>();
        if receipt.reload_operation_id != invocation.operation_id
            || receipt.tab_id != invocation.tab_id
            || receipt.window_id != invocation.window_id
            || receipt.window_generation != invocation.window_generation
            || receipt.topology_revision != invocation.topology_revision
            || receipt.lifecycle_epoch != invocation.lifecycle_epoch
            || receipt.roles.len() != preparations.len()
            || receipt.status != controlled_role_reload_native_aggregate(&aggregate_roles)
            || receipt
                .roles
                .iter()
                .zip(preparations)
                .any(|(native, prepared)| {
                    native.role_id != prepared.role_id
                        || native.owner_generation != prepared.owner_generation
                        || native.input_epoch != prepared.input_epoch
                        || native.surface_generation != prepared.surface_generation
                        || native.before_document_instance_id != prepared.document_instance_id
                        || !matches!(
                            native.submission_state.as_str(),
                            "notSubmitted" | "submitted" | "unknown"
                        )
                        || (native.submission_state == "notSubmitted"
                            && (!native.native_input_resumed || native.restart_required))
                        || (native.submission_state != "notSubmitted"
                            && native.native_input_resumed
                            && native.status != crate::model::SystemRuntimeOperationStatus::Applied)
                        || (native.status == crate::model::SystemRuntimeOperationStatus::Applied
                            && (native.submission_state != "submitted"
                                || !native.native_input_resumed
                                || native.restart_required
                                || native.navigation_sequence.is_none()
                                || native.after_document_instance_id.as_ref().is_none_or(
                                    |after| {
                                        !controlled_role_reload_valid_identifier(after, 512)
                                            || after == &native.before_document_instance_id
                                    },
                                )))
                })
        {
            return Err(controlled_role_reload_error(
                "RUNTIME_TAB_RELOAD_NATIVE_RECEIPT_INVALID",
                "Chromium returned stale controlled reload terminal fences.",
            ));
        }
        Ok(receipt)
    }
}
