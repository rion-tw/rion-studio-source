impl SystemRuntimeExecutor {
    fn execute_role_load_effect_async(
        self: &Arc<Self>,
        action_name: &'static str,
        effect: CoreEffectRequest,
        _presentation_revision: u64,
        persist_runtime: bool,
    ) {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        let scope = native_effect_scope(&effect);
        let started = Instant::now();
        let roles = match effect.action {
            CoreEffectAction::EmbeddedLoadRoles { roles } => roles,
            _ => unreachable!("role-load async dispatch only accepts EmbeddedLoadRoles"),
        };
        let pending = match self.start_role_loads(roles) {
            Ok(pending) => pending,
            Err(error) => {
                let _ = self.apply_runtime_native_event_for_operation(&operation_id, "failed");
                let error_payload = rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                };
                let result = CoreEffectResult {
                    effect_id: effect_id.clone(),
                    operation_id: operation_id.clone(),
                    ok: false,
                    value_json: None,
                    error: Some(error_payload.clone()),
                };
                let dispatch = self.core.dispatch_core_effect_results(vec![result]);
                let acknowledgement_status = dispatch
                    .as_ref()
                    .map(|report| effect_acknowledgement_status(report, &effect_id))
                    .unwrap_or("dispatchFailed");
                self.record_effect_outcome_failures(
                    action_name,
                    &effect_id,
                    &operation_id,
                    Some(&error_payload),
                    acknowledgement_status,
                    started.elapsed(),
                    persist_runtime,
                    &scope,
                );
                return;
            }
        };
        let lifecycle_epoch = pending
            .first()
            .map(|pending| pending.lifecycle_epoch)
            .unwrap_or_else(|| self.lifecycle_epoch());
        let mut result = CoreEffectResult {
            effect_id: effect_id.clone(),
            operation_id: operation_id.clone(),
            ok: true,
            value_json: None,
            error: None,
        };
        let persistence_error = persist_runtime
            .then(|| self.persist_restore_session(false).err())
            .flatten();
        result = finalize_persisted_effect_result(result, persist_runtime, persistence_error);
        let succeeded = result.ok;
        let error_payload = result.error.clone();
        let dispatch = self.core.dispatch_core_effect_results(vec![result]);
        let acknowledgement_status = dispatch
            .as_ref()
            .map(|report| effect_acknowledgement_status(report, &effect_id))
            .unwrap_or("dispatchFailed");
        let effect_accepted = succeeded && acknowledgement_status == "accepted";
        self.record_effect_outcome_failures(
            action_name,
            &effect_id,
            &operation_id,
            error_payload.as_ref(),
            acknowledgement_status,
            started.elapsed(),
            persist_runtime,
            &scope,
        );
        self.record_runtime_stage(
            format!("navigation-submitted:{operation_id}"),
            if effect_accepted {
                "completed"
            } else {
                "failed"
            },
            started,
        );
        if effect_accepted && persist_runtime {
            self.publish_projection();
        }
        if !effect_accepted {
            let _ = self.terminalize_runtime_operation(
                &operation_id,
                RuntimeOperationPhase::Cancelled,
                Some("CORE_EFFECT_NOT_ACCEPTED".to_owned()),
            );
        }

        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut ready_roles = HashSet::new();
            let mut failed_roles = Vec::new();
            for pending_navigation in &pending {
                let status = if let Some(operation) = pending_navigation.operation.clone() {
                    let receipt = runtime
                        .wait_role_navigation_for_lifecycle(pending_navigation, operation)
                        .await;
                    let status = receipt.status;
                    let failure_code = receipt.failure_code.clone();
                    runtime.record_native_operation_receipt(receipt);
                    if matches!(
                        status,
                        NativeOperationStatus::Degraded
                            | NativeOperationStatus::Failed
                            | NativeOperationStatus::Indeterminate
                    ) {
                        failed_roles.push((
                            pending_navigation.role_id.clone(),
                            pending_navigation.surface.label().to_owned(),
                            failure_code.unwrap_or_else(|| {
                                "System WebView navigation did not complete.".to_owned()
                            }),
                        ));
                    }
                    status
                } else {
                    NativeOperationStatus::Applied
                };
                if status == NativeOperationStatus::Applied {
                    ready_roles.insert(pending_navigation.role_id.clone());
                }
            }
            if !effect_accepted {
                ready_roles.clear();
                failed_roles.clear();
            }

            let runtime_for_completion = Arc::clone(&runtime);
            let completion = tauri::async_runtime::spawn_blocking(move || {
                let controlled_labels = pending
                    .iter()
                    .map(|pending| pending.surface.label().to_owned())
                    .collect::<Vec<_>>();
                let mut ready_tabs = HashSet::new();
                for pending_navigation in &pending {
                    if !ready_roles.contains(&pending_navigation.role_id)
                        || !runtime_for_completion
                            .application_lifecycle_epoch_matches(pending_navigation.lifecycle_epoch)
                    {
                        continue;
                    }
                    let current_tab_id = runtime_for_completion.state.lock().ok().and_then(|state| {
                        let tab_id = state.native_tab_id_for_role_surface(&pending_navigation.role_id)?.clone();
                        let surface = state.native_resources.tabs.get(&tab_id)?.roles.get(&pending_navigation.role_id)?;
                        (surface.webview.label() == pending_navigation.surface.label())
                            .then_some(tab_id)
                    });
                    let Some(tab_id) = current_tab_id else {
                        continue;
                    };
                    if runtime_for_completion
                        .reassert_role_keys(
                            &pending_navigation.role_id,
                            &pending_navigation.surface,
                        )
                        .is_ok()
                    {
                        runtime_for_completion.record_runtime_stage(
                            format!(
                                "tab.page-ready:{tab_id}:{}",
                                pending_navigation.role_id
                            ),
                            "completed",
                            started,
                        );
                        ready_tabs.insert(tab_id);
                    }
                }
                runtime_for_completion.finish_controlled_navigations(&controlled_labels);
                ready_tabs
            })
            .await
            .unwrap_or_default();

            let mut failed_tabs = HashSet::new();
            for (role_id, surface_label, failure) in failed_roles {
                let current = runtime.state.lock().ok().and_then(|state| {
                    let tab_id = state.native_tab_id_for_role_surface(&role_id)?.clone();
                    let surface = state.native_resources.tabs.get(&tab_id)?.roles.get(&role_id)?;
                    (surface.webview.label() == surface_label)
                        .then_some((tab_id, surface.generation))
                });
                if let Some((tab_id, generation)) = current {
                    failed_tabs.insert(tab_id.clone());
                    runtime.set_launch_phase(&tab_id, LaunchPhase::Degraded);
                    runtime.record_runtime_stage(
                        format!("tab.page-ready:{tab_id}:{role_id}:{failure}"),
                        "failed",
                        started,
                    );
                    runtime.schedule_surface_recovery(
                        role_id,
                        "navigation-page-ready-failed".to_owned(),
                        generation,
                    );
                }
            }
            for tab_id in completion {
                if failed_tabs.contains(&tab_id) {
                    continue;
                }
                if runtime.application_lifecycle_epoch_matches(lifecycle_epoch) {
                    runtime.set_launch_phase(&tab_id, LaunchPhase::EssentialReady);
                    runtime.schedule_optional_hydration(&tab_id);
                    let _ = runtime
                        .apply_runtime_native_event_for_operation(&operation_id, "ready");
                }
            }
            if !failed_tabs.is_empty() {
                let _ = runtime.apply_runtime_native_event_for_operation(&operation_id, "failed");
            }
        });
    }
}
